/**
 * 跨设备同步 —— 基于 GitHub Gist 的中转同步
 *
 * 同步内容：阅读进度（字符级锚点）+ 书签 + 书架 + 阅读时长
 * 跨设备主键：bookKey = 书名 \u0001 作者 \u0001 书源ID（v2 起）
 *   （本地 book id 每台设备不同且每次入架都变，不能直接用）
 *   为何要带书源段：同名同作者的书在两台设备可能来自**不同书源**，而不同
 *   书源的章节划分/更新进度并不一致——若按「书名+作者」合并，进度锚点
 *   （章节序号）在另一台设备的书源上可能根本不存在、或指向错误章节。
 *   加入书源段后按源隔离，各源独立同步、互不串扰。
 *   v1 的旧格式 key 会在合并时自动迁移（用远端书架条目的书源补齐），
 *   无法归属书源的旧条目丢弃（各设备本地进度会以新 key 重新上传）。
 *
 * 配置（localStorage zj-sync-v1）：
 *   { enabled, token, gistId, login, lastSyncAt, lastResult }
 */
import { getBooks, addBook, updateBook, getAllProgress, getAllBookmarks, saveProgress, saveBookmark, getToc } from './db.js';
import { getLocalDailyMap, saveRemoteReadingMap } from './stats.js';
import { requestText } from '../core/http.js';
// 书籍身份口径（唯一来源）：书名/作者/书源的归一化与「同一本书」判定
import { bookIdentityKey, bookKeyOfParts, bookTitleSourceKey, findSameBookRecord, normalizeBookFields, normalizeTitle, pickMostRecent, authorsCompatible } from './book-identity.js';
import { reconcileDuplicateBooks } from './reconcile.js';

const CFG_KEY = 'zj-sync-v1';
const GIST_DESC = 'zhijian-sync-v1';
const GIST_FILE = 'zhijian-sync.json';
const DATA_VERSION = 2;
const API = 'https://api.github.com';

const DEFAULTS = { enabled: false, token: '', gistId: '', login: '', lastSyncAt: 0, lastResult: '', lastPushFp: '' };

export function loadSyncConfig() {
	try {
		const raw = localStorage.getItem(CFG_KEY);
		return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveSyncConfig(patch) {
	const next = { ...loadSyncConfig(), ...patch };
	try {
		localStorage.setItem(CFG_KEY, JSON.stringify(next));
	} catch { /* ignore */ }
	return next;
}

export function isSyncEnabled() {
	const c = loadSyncConfig();
	return !!(c.enabled && c.token);
}

/**
 * 跨设备书籍主键（书名+作者+书源，与本地 id 无关）
 * 归一化统一委托给 book-identity.js：此前这里只做 trim，而书名/作者在
 * 不同设备、不同书源下常有「《书名》」「作者：xx」「首尾空格」等写法差异，
 * 两边算出的 key 不一致 → 同步时匹配不上本地记录 → 每轮同步新增一条重复书。
 */
export function bookKeyOf(book) {
	return bookIdentityKey(book);
}

/**
 * 远端 key 规范化（v1 → v2 迁移 + 统一归一化）
 * v1 格式为「书名\u0001作者」（两段），v2 追加书源段（三段）。
 * 旧 key 由来源条目携带的书源补齐；无法确定书源的返回 ''（调用方丢弃）。
 *
 * 注意 v2 分支**不能**直接把旧 key 原样返回：远端 key 是别的设备（可能是旧
 * 版本、或书源返回的首尾空格/《书名》/「作者：」写法）算出来的，
 * 必须用 book-identity 的口径重新拼一遍，
 * 否则本机 bookKeyOf 算出的键与它不一致 → 永远匹配不上 → 重复建书。
 */
function normalizeRemoteKey(key, sourceId) {
	const parts = String(key || '').split('\u0001');
	if (parts.length < 2) return '';
	if (parts.length >= 3) return bookKeyOfParts(parts[0], parts[1], parts[2]);
	const sid = String(sourceId || '').trim();
	return sid ? bookKeyOfParts(parts[0], parts[1], sid) : '';
}

/**
 * 本机设备 ID（首次调用时生成并持久化）
 * 阅读时长按"设备分账"：每台设备只上传/维护自己那份，汇总时相加——
 * 这样同步多次也不会重复累加。
 */
const DEVICE_KEY = 'zj-sync-device-id';
export function getDeviceId() {
	try {
		let id = localStorage.getItem(DEVICE_KEY);
		if (!id) {
			id = `d_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
			localStorage.setItem(DEVICE_KEY, id);
		}
		return id;
	} catch {
		return 'd_unknown';
	}
}

// ============================================================
//  GitHub API（token 只存在于本机 localStorage，仅发往 api.github.com）
// ============================================================

async function gh(token, path, { method = 'GET', body } = {}) {
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	};
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	const res = await requestText(`${API}${path}`, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : null,
		timeout: 12000
	});
	if (res.status && res.status >= 400) {
		let msg = `HTTP ${res.status}`;
		try {
			msg = JSON.parse(res.text)?.message || msg;
		} catch { /* ignore */ }
		const err = new Error(`GitHub：${msg}`);
		err.status = res.status;
		throw err;
	}
	try {
		return JSON.parse(res.text);
	} catch {
		throw new Error('GitHub 返回了无法解析的内容');
	}
}

/** 校验 token，返回登录名 */
export async function verifyToken(token) {
	const me = await gh(token, '/user');
	return me.login || 'github';
}

/** 在账号中查找已有的同步 Gist（第二台设备复用同一中转仓库的关键） */
async function findSyncGist(token) {
	for (let page = 1; page <= 3; page++) {
		const list = await gh(token, `/gists?per_page=100&page=${page}`);
		if (!Array.isArray(list) || !list.length) break;
		const hit = list.find((g) => g.description === GIST_DESC);
		if (hit) return hit.id;
		if (list.length < 100) break;
	}
	return '';
}

async function createSyncGist(token, snapshot) {
	const g = await gh(token, '/gists', {
		method: 'POST',
		body: {
			description: GIST_DESC,
			public: false,
			files: { [GIST_FILE]: { content: JSON.stringify(snapshot) } }
		}
	});
	return g.id;
}

async function readRemote(token, gistId) {
	const g = await gh(token, `/gists/${gistId}`);
	const file = g.files?.[GIST_FILE];
	if (!file) return null;
	let content = file.content;
	if (file.truncated && file.raw_url) {
		const raw = await requestText(file.raw_url, { headers: { Authorization: `Bearer ${token}` } });
		content = raw.text;
	}
	try {
		return JSON.parse(content);
	} catch {
		return null;
	}
}

async function writeRemote(token, gistId, snapshot) {
	await gh(token, `/gists/${gistId}`, {
		method: 'PATCH',
		body: { files: { [GIST_FILE]: { content: JSON.stringify(snapshot) } } }
	});
}

// ============================================================
//  快照构建 / 合并 / 应用
// ============================================================

async function buildLocalSnapshot() {
	const books = await getBooks();
	const byId = new Map(books.map((b) => [b.id, b]));
	const progress = await getAllProgress();
	const marks = await getAllBookmarks();

	const progOut = {};
	for (const p of progress) {
		const book = byId.get(p.bookId);
		if (!book) continue;
		progOut[bookKeyOf(book)] = {
			anchor: p.anchor || null,
			chapterIdx: p.chapterIdx ?? 0,
			chapterTitle: p.chapterTitle || '',
			pageIdx: p.pageIdx ?? 0,
			scrollTop: p.scrollTop ?? 0,
			mode: p.mode || 'page',
			updatedAt: Number(p.updatedAt) || 0
		};
	}
	const bmOut = [];
	for (const m of marks) {
		const book = byId.get(m.bookId);
		if (!book || !m.anchor) continue;
		bmOut.push({
			key: bookKeyOf(book),
			anchor: m.anchor,
			chapterTitle: m.chapterTitle || '',
			text: m.text || '',
			createdAt: Number(m.createdAt) || 0
		});
	}
	// 阅读时长：只上传本机那份（按设备分账）
	// 书架：同步元数据（不传正文/目录；另一台设备打开该书时按 tocUrl 自动拉取）
	// 本地导入的书（sourceId='local'）正文不跨设备，不上传
	// 本地导入书也纳入快照（只传元数据 + 文件指纹）：
	// 文件本体走 WebDAV（book-files.js），另一台设备按 fileRemoteName 拉取后重新导入。
	// 没有 fileRemoteName 的本地书不传（文件还没上传，传了也没法取）。
	const bookOut = books.filter((b) => b.sourceId !== 'local' || b.fileRemoteName).map((b) => ({
		key: bookKeyOf(b),
		title: b.title || '',
		author: b.author || '',
		sourceId: b.sourceId || '',
		sourceName: b.sourceName || '',
		bookUrl: b.bookUrl || '',
		tocUrl: b.tocUrl || '',
		coverStyle: b.coverStyle || '',
		totalChapters: Number(b.totalChapters) || 0,
		readChapters: Number(b.readChapters) || 0,
		addedAt: Number(b.addedAt) || 0,
		lastReadAt: Number(b.lastReadAt) || 0,
		// 多书源：当前阅读的是哪个来源（换源选择跨设备同步，最新一次切换生效）
		active: b.active ? 1 : 0,
		activeAt: Number(b.activeAt) || 0,
		// 本地书文件指纹（文件本体在 WebDAV）
		fileHash: b.fileHash || '',
		fileName: b.fileName || '',
		fileSize: Number(b.fileSize) || 0,
		fileRemoteName: b.fileRemoteName || ''
	}));
	return {
		version: DATA_VERSION,
		updatedAt: Date.now(),
		progress: progOut,
		bookmarks: bmOut,
		books: bookOut,
		reading: { devices: { [getDeviceId()]: getLocalDailyMap() } }
	};
}

/** 合并两本书的元数据（进度类取 max、时间类分取 max/min、文本类优先非空） */
function mergeBookEntry(a, b) {
	if (!a) return { ...b };
	if (!b) return { ...a };
	const minPositive = (x, y) => {
		const xs = [Number(x) || 0, Number(y) || 0].filter((v) => v > 0);
		return xs.length ? Math.min(...xs) : 0;
	};
	// 换源选择：最近一次切换的设备赢（本机刚好同时切换时保留本机）
	const aActiveAt = Number(a.activeAt) || 0;
	const bActiveAt = Number(b.activeAt) || 0;
	const activeWinner = aActiveAt >= bActiveAt ? a : b;
	return {
		key: a.key,
		title: a.title || b.title || '',
		author: a.author || b.author || '',
		sourceId: a.sourceId || b.sourceId || '',
		sourceName: a.sourceName || b.sourceName || '',
		bookUrl: a.bookUrl || b.bookUrl || '',
		tocUrl: a.tocUrl || b.tocUrl || '',
		coverStyle: a.coverStyle || b.coverStyle || '',
		totalChapters: Math.max(Number(a.totalChapters) || 0, Number(b.totalChapters) || 0),
		readChapters: Math.max(Number(a.readChapters) || 0, Number(b.readChapters) || 0),
		addedAt: minPositive(a.addedAt, b.addedAt),
		lastReadAt: Math.max(Number(a.lastReadAt) || 0, Number(b.lastReadAt) || 0),
		active: activeWinner.active ? 1 : 0,
		activeAt: Math.max(aActiveAt, bActiveAt),
		// 本地书的文件指纹：两端都有时取内容一致的那份（哈希相同即同一文件）
		fileHash: a.fileHash || b.fileHash || '',
		fileName: a.fileName || b.fileName || '',
		fileSize: Number(a.fileSize) || Number(b.fileSize) || 0,
		fileRemoteName: a.fileRemoteName || b.fileRemoteName || ''
	};
}

/**
 * 书架条目的归并键：同书 + 同书源视为同一条。
 * 不能用 key 字符串本身——同一本书在两台设备上算出的 key 可能因作者
 * 缺失/写法不同而不同（「天蚕土豆」vs「天蚕土豆 著」→ 两个 key），
 * 用 key 归并会让它们在远端长期并存，进而被各设备当成两本书拉回本地。
 */
function bookMergeKey(b) {
	const norm = normalizeBookFields(b);
	// 旧格式条目可能只带 key 而没有 title/author 字段（早期版本上传的快照）——
	// 此时从 key 自身取书名/书源段，否则会被算成"空书名"而无法与携带字段的
	// 同一本书归并，导致同一本书在远端长期并存、被各设备分别拉成两条
	const parts = String(b?.key || '').split('\u0001');
	const title = norm.title || (parts.length >= 2 ? parts[0] : '');
	const sid = norm.sourceId || (parts.length >= 3 ? parts[2] : '');
	// 缺少书名或书源时只按完整身份归并（宁可不合并，也不误合不同书源）
	if (!title || !sid) return 'id:' + bookIdentityKey(norm);
	return bookTitleSourceKey({ title, sourceId: sid });
}

/**
 * 合并书架列表（按「同书同源」归并，而非按 key 字符串）。
 *
 * 归并不止按 key：同一本书在两台设备上算出的 key 可能因作者缺失/写法不同
 * 而不同（「天蚕土豆」vs「天蚕土豆 著」），只看 key 会让它们在远端长期并存，
 * 进而被各设备分别拉成本地两条。
 *
 * 但归并**必须校验作者兼容**：同一书源下同名不同作者是两本不同的书，
 * 若只按「书名+书源」归并，会出现两本书的进度/书签被并到同一条上（数据串味）。
 */
function mergeBooks(localBooks, remoteBooks) {
	const map = new Map();
	const groups = new Map(); // 候选键 → 已归并的条目列表（用于作者二次校验）
	for (const b of [...(localBooks || []), ...(remoteBooks || [])]) {
		if (!b) continue;
		const norm = normalizeBookFields(b);
		const site = bookMergeKey(norm);
		let merged = null;
		const bucket = groups.get(site) || [];
		// 在候选桶里找第一条作者兼容的记录（缺作者视为兼容）
		const prev = bucket.find((x) => authorsCompatible(x.author, norm.author));
		if (prev) {
			merged = mergeBookEntry(prev, norm);
			bucket[bucket.indexOf(prev)] = merged;
		} else {
			merged = norm;
			bucket.push(merged);
		}
		groups.set(site, bucket);
		// 有明确书名+书源时，把 key 统一规范到归一化后的完整身份键，
		// 这样两个原本写法不同的条目不会在远端继续并存；
		// 字段不全的旧条目保留原 key，避免把已有信息改没
		merged.key = merged.title && merged.sourceId ? bookIdentityKey(merged) : merged.key;
	}
	const keyMap = new Map();
	for (const bucket of groups.values()) for (const b of bucket) keyMap.set(b.key, b);
	return [...keyMap.values()];
}

/** 阅读位置的次序（章节 → 段落 → 字符），用于"最远优先"比较 */
function progressRank(p) {
	return [
		Number(p?.chapterIdx) || 0,
		Number(p?.anchor?.paragraphIdx) || 0,
		Number(p?.anchor?.charOffset) || 0
	];
}

/** a 是否严格比 b 读得更远（Kindle furthest-read 语义） */
function isFurther(a, b) {
	const ra = progressRank(a);
	const rb = progressRank(b);
	for (let i = 0; i < ra.length; i++) {
		if (ra[i] !== rb[i]) return ra[i] > rb[i];
	}
	return false;
}

/** 合并阅读时长（设备分账）：
 * - 其他设备：直接取远端数据
 * - 本机设备：与远端逐日取 max（防止本地数据被清后云端历史贡献被抹掉；
 *   正常情况下本地持续累加，max 即为本地最新值）
 */
function mergeReadingDevices(localDevices, remoteDevices) {
	const myId = getDeviceId();
	const merged = { ...(remoteDevices || {}) };
	const myLocal = localDevices?.[myId] || {};
	const my = { ...(merged[myId] || {}) };
	for (const [date, sec] of Object.entries(myLocal)) {
		my[date] = Math.max(Number(my[date]) || 0, Number(sec) || 0);
	}
	merged[myId] = my;
	return merged;
}

/**
 * 合并本地与远端快照
 * - 先把远端 v1 旧 key 迁移为 v2（补书源段，见 normalizeRemoteKey）；
 *   同名书来自不同书源时 key 不同，进度互不比较、各归各的源
 * - 进度：**最远优先**（读得更远的赢；完全同位置时取时间较新的）——
 *   这是 Kindle "Furthest Read Location" 的语义。若仅按时间戳取新，
 *   会出现"某台设备停在旧章节、其本地时间却是新的"把另一台更靠前的
 *   进度覆盖掉（造成倒退）
 * - 书签：按锚点去重并集
 * - 时长：按设备分账（见 mergeReadingDevices）
 */
function mergeSnapshots(local, remote) {
	if (!remote) {
		return {
			version: DATA_VERSION,
			updatedAt: Date.now(),
			progress: { ...local.progress },
			bookmarks: [...local.bookmarks],
			books: [...(local.books || [])],
			reading: { devices: mergeReadingDevices(local.reading?.devices, {}) }
		};
	}
	// ——— 远端 v1 旧 key 迁移（「书名\u0001作者」→ 追加书源段）———
	// 旧 key 的书源 id 取自远端书架条目；无法归属书源的旧进度/书签丢弃
	// （各设备本地进度本就在，会以新 key 在后续同步中重新上传）
	const legacySid = new Map();
	for (const rb of remote.books || []) {
		if (rb?.key && String(rb.key).split('\u0001').length === 2) {
			legacySid.set(rb.key, String(rb.sourceId || '').trim());
		}
	}
	const rBooks = [];
	for (const rb of remote.books || []) {
		const nk = normalizeRemoteKey(rb?.key, rb?.sourceId);
		if (nk) rBooks.push(nk === rb.key ? rb : { ...rb, key: nk });
	}
	const rProgress = {};
	for (const [k, v] of Object.entries(remote.progress || {})) {
		const nk = normalizeRemoteKey(k, legacySid.get(k));
		if (nk) rProgress[nk] = v;
	}
	const rBookmarks = [];
	for (const bm of remote.bookmarks || []) {
		const nk = bm?.key ? normalizeRemoteKey(bm.key, legacySid.get(bm.key)) : '';
		if (nk) rBookmarks.push(nk === bm.key ? bm : { ...bm, key: nk });
	}

	const merged = { version: DATA_VERSION, updatedAt: Date.now(), progress: {}, bookmarks: [], books: [], reading: null };
	const keys = new Set([...Object.keys(local.progress || {}), ...Object.keys(rProgress)]);
	for (const k of keys) {
		const lp = local.progress?.[k];
		const rp = rProgress[k];
		if (!lp) { merged.progress[k] = rp; continue; }
		if (!rp) { merged.progress[k] = lp; continue; }
		if (isFurther(rp, lp)) { merged.progress[k] = rp; continue; }
		if (isFurther(lp, rp)) { merged.progress[k] = lp; continue; }
		// 完全同一位置：取时间较新的
		merged.progress[k] = (Number(rp.updatedAt) || 0) > (Number(lp.updatedAt) || 0) ? rp : lp;
	}
	const seen = new Set();
	for (const bm of [...rBookmarks, ...(local.bookmarks || [])]) {
		if (!bm || !bm.key || !bm.anchor) continue;
		const id = `${bm.key}#${bm.anchor.chapterIdx ?? -1}#${bm.anchor.paragraphIdx ?? -1}#${bm.anchor.charOffset ?? 0}`;
		if (seen.has(id)) continue;
		seen.add(id);
		merged.bookmarks.push(bm);
	}
	merged.reading = { devices: mergeReadingDevices(local.reading?.devices, remote.reading?.devices) };
	merged.books = mergeBooks(local.books, rBooks);
	return merged;
}

/** 把合并结果中"更远"的进度与"新"的书签写回本地（本地没有的书先跳过，入架后下次同步生效） */
/**
 * 把远端阅读进度对齐到本机目录。
 *
 * 两台设备的目录版本可能不同（一端检查过更新、或缓存的是旧目录），远端
 * 的 chapterIdx 直接套到本机会错位，越界时还会被阅读器夹到「最后一章」。
 * 用 chapterTitle 校正（章节被重排但标题不变时也能找回原位）：
 *   - 标题命中（含换到别的序号）：字符/段落锚点仍属于同一章内容，保留
 *   - 仅按范围夹取：章节身份不确定，丢弃锚点，只落到章首
 */
async function alignProgressToLocalToc(p, book, tocCache) {
	let toc = tocCache.get(book.id);
	if (toc === undefined) {
		try { toc = (await getToc(book.id)) || []; } catch { toc = []; }
		tocCache.set(book.id, toc);
	}
	if (!toc.length) return p;
	const rawIdx = Number.isInteger(p?.chapterIdx) ? p.chapterIdx : 0;
	let idx = Math.max(0, Math.min(rawIdx, toc.length - 1));
	let titleHit = false;
	const want = normalizeTitle(p?.chapterTitle || '');
	if (want) {
		if (normalizeTitle(toc[idx]?.title || '') === want) {
			titleHit = true;
		} else {
			const found = toc.findIndex((c) => normalizeTitle(c?.title || '') === want);
			if (found >= 0) { idx = found; titleHit = true; }
		}
	}
	if (idx === rawIdx) return p;
	return { ...p, chapterIdx: idx, anchor: titleHit ? (p.anchor || null) : null };
}

/** 书签同样按标题对齐（章节重排后书签不会漂到别的章） */
function alignBookmarkToLocalToc(bm, toc) {
	if (!toc?.length) return bm;
	const a = bm?.anchor || {};
	const rawIdx = Number.isInteger(a.chapterIdx) ? a.chapterIdx : 0;
	let idx = Math.max(0, Math.min(rawIdx, toc.length - 1));
	const want = normalizeTitle(bm?.chapterTitle || '');
	if (want && normalizeTitle(toc[idx]?.title || '') !== want) {
		const found = toc.findIndex((c) => normalizeTitle(c?.title || '') === want);
		if (found >= 0) idx = found;
	}
	if (idx === rawIdx) return bm;
	return { ...bm, anchor: { ...a, chapterIdx: idx } };
}

/** 本轮同步发现的「云端有、本机没有」的本地书（待从 WebDAV 下载后导入） */
let _pendingLocalDownloads = [];

/** 读取待下载的本地书列表（供同步面板展示/触发下载） */
export function getPendingLocalDownloads() {
	return _pendingLocalDownloads.map((x) => ({ ...x }));
}

async function applySnapshotToLocal(merged, local) {
	_pendingLocalDownloads = [];
	let booksApplied = 0;
	let progressApplied = 0;
	let bookmarksApplied = 0;

	// 0. 书架：先创建/更新本地书架（"幽灵书"只同步元数据，打开时按 tocUrl 自动拉目录），
	//    这样其后的进度/书签才能匹配到对应的书。
	//
	//    ⚠️ 这里是「同步会复制出一份新书」的历史踩坑点，两条铁律：
	//    (1) 新建记录前，除了按身份键精确匹配，还必须用 findSameBookRecord
	//        做一次降级匹配（书名+书源），把「同一本书但键写法不同」的远端条目
	//        合并到已有记录上，而不是再插一条；
	//    (2) 新建/更新后要**立即**把该键写回索引，否则同轮次后面的进度、书签、
	//        以及其它指向同一本书的远端条目都会匹配失败。
	// 先合并本地存量重复记录，再做任何匹配：
	// 否则同一身份的多条记录会在下面的索引里互相覆盖（后写入者胜），
	// 远端元数据可能落到一条「不该保留」的记录上，最终保留哪条变得不确定。
	let reconciled = 0;
	try {
		reconciled = (await reconcileDuplicateBooks()).merged;
	} catch { /* 整理失败不应阻断本轮同步 */ }

	let books = await getBooks();
	const byKey = new Map();
	const byId = new Map();
	for (const b of books) {
		byId.set(b.id, b);
		const k = bookKeyOf(b);
		// 理论上整理后不会再有同键记录；若仍有（并发写入），
		// 保留「最值得保留」的那条，避免结果依赖遍历顺序
		byKey.set(k, byKey.has(k) ? pickMostRecent([byKey.get(k), b]) : b);
	}
	let booksAdded = 0;
	let booksUpdated = 0;

	for (const rb of merged.books || []) {
		if (!rb || !rb.key) continue;
		// 远端条目先归一化落库字段，保证其身份键与本地口径一致
		const remoteBook = normalizeBookFields(rb);
		let exist = byKey.get(bookIdentityKey(remoteBook));
		if (!exist) {
			// 降级匹配：同名 + 同书源（作者在不同书源/设备下常缺失或写法不同）
			exist = findSameBookRecord(remoteBook, [...byId.values()]);
		}

		if (exist) {
			const keyBefore = bookIdentityKey(exist);
			const patch = {};
			if ((remoteBook.readChapters || 0) > (exist.readChapters || 0)) patch.readChapters = remoteBook.readChapters;
			if ((remoteBook.lastReadAt || 0) > (exist.lastReadAt || 0)) patch.lastReadAt = remoteBook.lastReadAt;
			if ((remoteBook.totalChapters || 0) > (exist.totalChapters || 0)) patch.totalChapters = remoteBook.totalChapters;
			if (!exist.tocUrl && remoteBook.tocUrl) patch.tocUrl = remoteBook.tocUrl;
			if (!exist.bookUrl && remoteBook.bookUrl) patch.bookUrl = remoteBook.bookUrl;
			if (!exist.coverStyle && remoteBook.coverStyle) patch.coverStyle = remoteBook.coverStyle;
			// 本地作者为空而远端有 → 补齐（补齐后键更稳定，后续同步不会反复退化匹配）
			if (!exist.author && remoteBook.author) patch.author = remoteBook.author;
			if (!exist.sourceName && remoteBook.sourceName) patch.sourceName = remoteBook.sourceName;
			// 换源选择：对端切换得更晚 → 跟随（保证两台设备读同一个来源）
			if ((Number(remoteBook.activeAt) || 0) > (Number(exist.activeAt) || 0)) {
				patch.active = remoteBook.active ? 1 : 0;
				patch.activeAt = Number(remoteBook.activeAt) || 0;
			}
			// 本地书：补齐文件指纹（旧版本导入的书没有这些字段）
			if (remoteBook.sourceId === 'local' && remoteBook.fileRemoteName) {
				if (!exist.fileHash && remoteBook.fileHash) patch.fileHash = remoteBook.fileHash;
				if (!exist.fileName && remoteBook.fileName) patch.fileName = remoteBook.fileName;
				if (!exist.fileSize && remoteBook.fileSize) patch.fileSize = remoteBook.fileSize;
				if (!exist.fileRemoteName) {
					patch.fileRemoteName = remoteBook.fileRemoteName;
					patch.fileUploadedAt = Number(exist.fileUploadedAt) || 0;
				}
			}
			if (Object.keys(patch).length) {
				await updateBook(exist.id, patch);
				Object.assign(exist, patch);
				booksUpdated++;
			}
			// 索引指向这条已有记录：远端键与本地键可能写法不同（作者缺失/写法差异），
			// 把「归一化前 / 归一化后 / 远端原键」都登记一遍，
			// 保证同轮次内的进度与书签无论用哪个键都能命中同一条记录
			byKey.set(rb.key, exist);
			byKey.set(keyBefore, exist);
			byKey.set(bookIdentityKey(exist), exist);
			continue;
		}

		// 本地导入书：本机没有 → 不能建"幽灵书"（没有 tocUrl 可拉目录），
		// 登记为待下载任务，由同步面板/自动流程走 WebDAV 下载后解析导入
		if (remoteBook.sourceId === 'local') {
			if (remoteBook.fileRemoteName) {
				_pendingLocalDownloads.push({
					title: remoteBook.title || '',
					author: remoteBook.author || '',
					fileHash: remoteBook.fileHash || '',
					fileName: remoteBook.fileName || '',
					fileSize: Number(remoteBook.fileSize) || 0,
					fileRemoteName: remoteBook.fileRemoteName
				});
			}
			continue;
		}

		const created = normalizeBookFields({
			id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
			title: remoteBook.title || '',
			author: remoteBook.author || '',
			coverStyle: remoteBook.coverStyle || '',
			sourceId: remoteBook.sourceId || '',
			sourceName: remoteBook.sourceName || '',
			bookUrl: remoteBook.bookUrl || '',
			tocUrl: remoteBook.tocUrl || '',
			totalChapters: remoteBook.totalChapters || 0,
			readChapters: remoteBook.readChapters || 0,
			cachedChapters: 0,
			addedAt: remoteBook.addedAt || Date.now(),
			lastReadAt: remoteBook.lastReadAt || 0,
			active: remoteBook.active ? 1 : 0,
			activeAt: remoteBook.activeAt || 0
		});
		// addBook 是统一写入闸门：若库中已存在同身份记录，它会返回那条已有记录
		// （__merged），此时必须沿用它来登记索引，否则后续进度/书签会挂到不存在的 id
		const saved = await addBook(created);
		if (saved?.__merged) booksUpdated++;
		else booksAdded++;
		// 立即入索引：同轮次内后续条目/进度/书签都能匹配到这条记录
		byId.set(saved.id, saved);
		byKey.set(rb.key, saved);
		byKey.set(bookIdentityKey(saved), saved);
	}
	booksApplied = booksAdded + booksUpdated;
	if (booksApplied) {
		books = await getBooks();
	}
	// 进度/书签的键可能来自另一台设备（作者写法不同、书源 id 大小写不同），
	// 因此在「键 → 本地记录」之外再建一张「书名+书源 → 记录」的降级索引，
	// 保证远端进度不会因为键的写法差异而落空、更不会另建一本书来承接它。
	const byTitleSource = new Map();
	for (const b of books) {
		byKey.set(bookKeyOf(b), b);
		const ts = bookTitleSourceKey(normalizeBookFields(b));
		if (!byTitleSource.has(ts)) byTitleSource.set(ts, b);
	}
	const resolveBook = (key) => {
		const direct = byKey.get(key);
		if (direct) return direct;
		return byTitleSource.get(bookTitleSourceKey(normalizeBookFields({ key }))) || null;
	};

	const tocCache = new Map();
	for (const [key, mp] of Object.entries(merged.progress || {})) {
		const book = resolveBook(key);
		if (!book) continue;
		const lp = local.progress?.[key];
		// 先按本机目录校正（标题对齐 / 越界收敛），再判断"是否更远"——
		// 否则目录漂移的远端序号可能虚高，把本机更远的进度覆盖成错位位置
		const adjusted = await alignProgressToLocalToc(mp, book, tocCache);
		// 最远优先：只在"远端读得更远"时跟进；本地更远或完全相同时保持本地不动（不会倒退）
		if (lp && !isFurther(adjusted, lp)) continue;
		await saveProgress({
			bookId: book.id,
			anchor: adjusted.anchor || null,
			chapterIdx: adjusted.chapterIdx ?? 0,
			chapterTitle: adjusted.chapterTitle || '',
			pageIdx: adjusted.pageIdx ?? 0,
			scrollTop: adjusted.scrollTop ?? 0,
			mode: adjusted.mode || 'page',
			updatedAt: Number(adjusted.updatedAt) || Date.now()
		});
		progressApplied++;
	}

	const existing = await getAllBookmarks();
	const exIds = new Set(existing.map((m) => m.id));
	for (const raw of merged.bookmarks || []) {
		const book = resolveBook(raw.key);
		if (!book) continue;
		// 书签也按标题对齐到本机目录，避免目录漂移后书签跳到别的章
		let toc = tocCache.get(book.id);
		if (toc === undefined) {
			try { toc = (await getToc(book.id)) || []; } catch { toc = []; }
			tocCache.set(book.id, toc);
		}
		const bm = alignBookmarkToLocalToc(raw, toc);
		const a = bm.anchor || {};
		const localId = `${book.id}:${a.chapterIdx ?? 0}:${a.paragraphIdx ?? 0}:${a.charOffset ?? 0}`;
		if (exIds.has(localId)) continue;
		await saveBookmark({
			id: localId,
			bookId: book.id,
			anchor: bm.anchor,
			chapterTitle: bm.chapterTitle || '',
			text: bm.text || '',
			createdAt: Number(bm.createdAt) || Date.now()
		});
		bookmarksApplied++;
	}

	// 阅读时长：汇总"其他设备"的每日贡献写入本地缓存
	// （stats.js 的今日/周统计与防沉迷限额会自动带这部分；本机数据不在此列）
	const devices = merged.reading?.devices || {};
	const myId = getDeviceId();
	const dateMap = {};
	for (const [id, map] of Object.entries(devices)) {
		if (id === myId) continue;
		for (const [date, sec] of Object.entries(map || {})) {
			dateMap[date] = (dateMap[date] || 0) + (Number(sec) || 0);
		}
	}
	saveRemoteReadingMap(dateMap);

	// reconciled：本轮整理掉的存量重复记录数（供同步结果提示与回归测试断言）
	return {
		books: booksApplied,
		progress: progressApplied,
		bookmarks: bookmarksApplied,
		reconciled,
		booksAdded,
		booksUpdated,
		pendingLocal: _pendingLocalDownloads.length
	};
}

// ============================================================
//  对外接口
// ============================================================

/** 开启同步：校验 token → 查找/创建中转 Gist → 立即执行一轮完整同步 */
export async function enableSync(token) {
	const login = await verifyToken(token);
	saveSyncConfig({ token, login, enabled: true });
	try {
		const result = await syncNow();
		return { login, ...result };
	} catch (e) {
		// token 已保存且有效，但首轮同步失败（网络等）——保持开启，下次再试
		saveSyncConfig({ lastResult: e.message || String(e) });
		throw e;
	}
}

export function disableSync() {
	return saveSyncConfig({ enabled: false });
}

/** 核心同步：拉取远端 → 合并 → 应用较新条目 → 推回远端 */
/** 本地快照指纹（用于跳过"无变化"的上传，减少一次网络往返） */
function localFingerprint(snapshot) {
	try {
		return JSON.stringify({
			p: Object.keys(snapshot.progress || {}).sort().map((k) => [k, snapshot.progress[k]]),
			b: (snapshot.bookmarks || []).map((bm) => `${bm.key}#${bm.anchor?.chapterIdx ?? ''}#${bm.anchor?.paragraphIdx ?? ''}#${bm.anchor?.charOffset ?? ''}`).sort(),
			bk: (snapshot.books || []).map((x) => `${x.key}|${x.readChapters}|${x.lastReadAt}|${x.totalChapters}|${x.active}|${x.activeAt}`).sort(),
			r: Object.keys(snapshot.reading?.devices || {}).sort().map((k) => [k, snapshot.reading.devices[k]])
		});
	} catch {
		return String(Date.now());
	}
}

// 防重入：正在同步时复用同一个 Promise（多个触发点不会并发打请求）
let _syncing = null;

export function syncNow() {
	if (_syncing) return _syncing;
	_syncing = doSyncNow().finally(() => { _syncing = null; });
	return _syncing;
}

async function doSyncNow() {
	const cfg = loadSyncConfig();
	if (!cfg.enabled || !cfg.token) throw new Error('同步未开启');
	const token = cfg.token;
	const emptyApplied = { books: 0, progress: 0, bookmarks: 0 };

	// 1. 确保有中转 Gist（没有则查找账户里已有的；再没有才创建）
	let gistId = cfg.gistId;
	if (!gistId) {
		gistId = await findSyncGist(token);
		if (!gistId) {
			const local = await buildLocalSnapshot();
			gistId = await createSyncGist(token, local);
			saveSyncConfig({ gistId, lastSyncAt: Date.now(), lastResult: '已创建同步仓库', lastPushFp: localFingerprint(local) });
			return { applied: emptyApplied, created: true };
		}
		saveSyncConfig({ gistId });
	}

	// 2. 拉取远端
	let remote = null;
	try {
		remote = await readRemote(token, gistId);
	} catch (e) {
		if (e.status === 404) {
			// gist 被删除 → 重新查找或重建
			const found = await findSyncGist(token);
			if (found) {
				gistId = found;
				saveSyncConfig({ gistId });
				remote = await readRemote(token, gistId);
			} else {
				const local = await buildLocalSnapshot();
				gistId = await createSyncGist(token, local);
				saveSyncConfig({ gistId, lastSyncAt: Date.now(), lastResult: '同步仓库已重建', lastPushFp: localFingerprint(local) });
				return { applied: emptyApplied, recreated: true };
			}
		} else {
			throw e;
		}
	}

	// 3. 合并（本地 + 远端）
	const local = await buildLocalSnapshot();
	const fp = localFingerprint(local);
	const merged = mergeSnapshots(local, remote);

	// 4. 应用"更远/更新"的条目到本地
	const applied = await applySnapshotToLocal(merged, local);

	// 存量清理已包含在 applySnapshotToLocal 的最前面（拉取远端时就会被合并），
	// 这里只把结果透传给 UI 提示
	const reconciled = applied.reconciled || 0;

	// 5. 推回远端：本地快照无变化时跳过上传（省一次网络往返——提速的关键）
	if (fp === cfg.lastPushFp && remote) {
		const parts = [];
		if (applied.books) parts.push(`书架 +${applied.books}`);
		if (applied.progress) parts.push(`进度 ${applied.progress}`);
		if (applied.bookmarks) parts.push(`书签 +${applied.bookmarks}`);
		if (reconciled) parts.push(`合并重复 ${reconciled}`);
		saveSyncConfig({
			lastSyncAt: Date.now(),
			lastResult: parts.length ? `已拉取：${parts.join(' · ')}` : '已是最新'
		});
		return { applied, reconciled };
	}

	merged.updatedAt = Date.now();
	try {
		await writeRemote(token, gistId, merged);
	} catch (e) {
		if (e.status === 404) {
			gistId = await createSyncGist(token, merged);
			saveSyncConfig({ gistId });
		} else {
			throw e;
		}
	}

	const parts = [];
	if (applied.books) parts.push(`书架 +${applied.books}`);
	if (applied.progress) parts.push(`进度 ${applied.progress}`);
	if (applied.bookmarks) parts.push(`书签 +${applied.bookmarks}`);
	if (reconciled) parts.push(`合并重复 ${reconciled}`);
	saveSyncConfig({
		lastSyncAt: Date.now(),
		lastResult: parts.length ? `已同步：${parts.join(' · ')}` : '已上传',
		lastPushFp: fp
	});
	return { applied, reconciled };
}

/** 有未同步的阅读变化时置位；切后台/回前台时立即冲刷 */
let _dirty = false;
let _pushTimer = null;

/** 仅供测试：暴露快照合并逻辑（Node 环境无 IndexedDB，跑不了完整同步流程） */
export function _mergeSnapshotsForTest(local, remote) {
	return mergeSnapshots(local, remote);
}

/** 标记"本地有新阅读进度待同步" */
export function markReadingDirty() {
	_dirty = true;
}

function flushSync() {
	if (!_dirty || !isSyncEnabled()) return;
	_dirty = false;
	syncNow().catch(() => {
		_dirty = true; // 失败保留标记，下次触发时重试
	});
}

// 切后台瞬间立即同步：Android WebView 后台会冻结/节流定时器，
// 若只靠 setTimeout，用户"读完直接锁屏"就永远不会自动同步。
if (typeof document !== 'undefined') {
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flushSync();
	});
}

/** 退出阅读器后延迟推送（进度落库 + 避免频繁请求；若用户很快切后台则立即同步） */
export function scheduleSyncAfterRead(delay = 2500) {
	if (!isSyncEnabled()) return;
	_dirty = true;
	clearTimeout(_pushTimer);
	_pushTimer = setTimeout(() => flushSync(), delay);
}
