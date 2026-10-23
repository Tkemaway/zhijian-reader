/**
 * 书籍记录整理 —— 修复历史遗留的重复书籍记录
 *
 * 背景：旧版同步逻辑用「trim 后的书名+作者+书源」当跨设备主键，
 * 而书名/作者在不同书源、不同设备、不同版本下写法不一致（首尾空格、
 * 《书名》、「作者：」前缀、后一页作者为空……），导致同一本书算出的键不同。
 * 同步时匹配不上本地已有记录，于是每同步一轮就 addBook 一条新记录——
 * 用户看到的现象就是「检查一次更新，书架里就多一本」。
 *
 * 修复分两层：
 *   1. 写入闸门（sync.js）：见 applySnapshotToLocal，新建前必须降级匹配；
 *   2. 存量清理（本模块）：把已经被复制出来的重复记录合并回一条。
 *
 * 合并策略（保守，宁可少合也不误合）：
 *   - 同一「归一化书名+作者+书源」→ 必然同一本书，合并；
 *   - 同一「归一化书名+书源」（书源非空，作者不同/缺失）→ 同一本书，合并；
 *   - 只有书名+作者相同、书源不同 → **不合并**（那是合法的多书源，供用户换源选择）。
 *
 * 数据搬迁：合并时把被合并记录的目录 / 章节缓存 / 进度 / 书签全部改挂到保留的
 * 记录上，再删除多余记录，避免用户「缓存和进度凭空消失」。
 */
import {
	getBooks, deleteBook, updateBook, getToc, saveToc,
	getProgress, saveProgress, getBookmarks, saveBookmark, deleteBookmark,
	getCachedChapterIndices, getChapter, saveChapters, getDownload, saveDownload
} from './db.js';
import { bookIdentityKey, bookTitleSourceKey, pickMostRecent, normalizeBookFields, authorsCompatible } from './book-identity.js';

/**
 * 候选分组键：同源优先用「书名 + 书源」；书源为空时只按完整身份（不猜）。
 *
 * 这只是**候选**分组——同一组里可能混有「同名但不同作者」的两本书，
 * 所以分组之后还要按作者做二次聚类（见 clusterByAuthor），
 * 否则会把不同作者的同名书并成一条并删掉一条。丢书比重复更严重。
 */
function mergeGroupKey(book) {
	const norm = normalizeBookFields(book);
	if (!norm.sourceId) return 'id:' + bookIdentityKey(norm);
	return 'ts:' + bookTitleSourceKey(norm);
}

/**
 * 组内按作者再聚类：把「同书同源」的候选拆成若干互不兼容的作者簇。
 * 作者为空/互为前缀的记录归入同一簇（缺作者是最常见的写法差异）；
 * 明确不同且互不包含的作者各自独立成簇，绝不互相合并。
 */
function clusterByAuthor(group) {
	const clusters = [];
	for (const b of group) {
		const hit = clusters.find((c) => c.every((x) => authorsCompatible(x.author, b.author)));
		if (hit) hit.push(b);
		else clusters.push([b]);
	}
	return clusters;
}

/**
 * 整理本地书架：合并重复记录。
 * @returns {Promise<{merged: number, removedIds: string[], kept: number}>}
 */
export async function reconcileDuplicateBooks() {
	const books = (await getBooks()).filter(Boolean);
	if (books.length < 2) return { merged: 0, removedIds: [], kept: books.length };

	const groups = new Map();
	for (const b of books) {
		const k = mergeGroupKey(b);
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(b);
	}

	const removedIds = [];
	let merged = 0;

	for (const group of groups.values()) {
		if (group.length < 2) continue;
		// 同一「书名+书源」下可能混着不同作者的同名书 → 按作者再聚类，
		// 只在兼容的作者簇内部合并
		for (const cluster of clusterByAuthor(group)) {
			if (cluster.length < 2) continue;
			await mergeCluster(cluster, removedIds, () => { merged++; });
		}
	}
	return { merged, removedIds, kept: books.length - merged };
}

/** 合并一个（已确认同一本书的）记录簇：保留最值得保留的一条，其余并入 */
async function mergeCluster(cluster, removedIds, onMerged) {
	const winner = pickMostRecent(cluster);
	for (const loser of cluster) {
		if (loser.id === winner.id) continue;
		await absorbBook(winner, loser);
		removedIds.push(loser.id);
		onMerged();
	}
}

/**
 * 把 loser 的目录/缓存/进度/书签搬迁到 winner，然后删除 loser。
 */
async function absorbBook(winner, loser) {
	// 1. 元数据聚合（章节数、缓存数、阅读进度取大）
	const patch = {};
	if ((loser.totalChapters || 0) > (winner.totalChapters || 0)) patch.totalChapters = loser.totalChapters;
	if ((loser.readChapters || 0) > (winner.readChapters || 0)) patch.readChapters = loser.readChapters;
	if ((loser.lastReadAt || 0) > (winner.lastReadAt || 0)) patch.lastReadAt = loser.lastReadAt;
	if (loser.active && !winner.active) { patch.active = 1; patch.activeAt = Number(loser.activeAt) || 0; }
	if (!winner.tocUrl && loser.tocUrl) patch.tocUrl = loser.tocUrl;
	if (!winner.bookUrl && loser.bookUrl) patch.bookUrl = loser.bookUrl;
	if (!winner.author && loser.author) patch.author = loser.author;
	if (!winner.coverStyle && loser.coverStyle) patch.coverStyle = loser.coverStyle;
	if (!winner.sourceName && loser.sourceName) patch.sourceName = loser.sourceName;

	// 2. 目录：winner 没有才搬（有则保留 winner 的，避免章节序号错位）
	const winnerToc = await getToc(winner.id);
	if (!winnerToc?.length) {
		const loserToc = await getToc(loser.id);
		if (loserToc?.length) {
			await saveToc(winner.id, loserToc);
			// 只在 loser 目录更长时抬高章节数——否则会把 winner 已知的更大章节数
			// 拉回 loser 的较小值（章节数倒退会让书架进度百分比和「更新」提示失真）
			const known = Math.max(Number(patch.totalChapters) || 0, Number(winner.totalChapters) || 0);
			if (loserToc.length > known) patch.totalChapters = loserToc.length;
		}
	}

	// 3. 章节缓存：winner 缺的章节从 loser 搬过来（保持 idx 不变，
	//    因为同一本书同一书源的目录顺序一致）
	const winnerCached = new Set(await getCachedChapterIndices(winner.id));
	const loserCached = await getCachedChapterIndices(loser.id);
	const moved = [];
	for (const idx of loserCached) {
		if (winnerCached.has(idx)) continue;
		const ch = await getChapter(loser.id, idx);
		if (!ch) continue;
		moved.push({ idx, title: ch.title, paragraphs: ch.paragraphs, totalChars: ch.totalChars, url: ch.url });
		if (moved.length >= 200) { await saveChapters(winner.id, moved.splice(0)); }
	}
	if (moved.length) await saveChapters(winner.id, moved);
	patch.cachedChapters = new Set([...winnerCached, ...loserCached]).size;

	// 4. 进度：winner 没有进度才搬（有则保留 winner 的，避免阅读位置倒退）
	const wp = await getProgress(winner.id);
	if (!wp) {
		const lp = await getProgress(loser.id);
		if (lp) await saveProgress({ ...lp, bookId: winner.id });
	}

	// 5. 书签：逐条改挂到 winner（id 里含 bookId，必须重建）
	const marks = await getBookmarks(loser.id);
	for (const m of marks) {
		const a = m.anchor || {};
		const newId = `${winner.id}:${a.chapterIdx ?? 0}:${a.paragraphIdx ?? 0}:${a.charOffset ?? 0}`;
		await saveBookmark({ ...m, id: newId, bookId: winner.id });
		await deleteBookmark(m.id);
	}

	// 6. 缓存任务记录：winner 没有就搬过来，否则「上次缓存 N 章」的断点续传信息会丢
	const wd = await getDownload(winner.id);
	if (!wd) {
		const ld = await getDownload(loser.id);
		if (ld) await saveDownload({ ...ld, bookId: winner.id });
	}

	if (Object.keys(patch).length) await updateBook(winner.id, patch);
	await deleteBook(loser.id);
}
