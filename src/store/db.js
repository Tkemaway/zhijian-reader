/**
 * 数据层 —— IndexedDB 书库存储
 * books: 书籍信息
 * toc:   目录（按书记）
 * chapters: 章节内容（按书+序号）
 * progress: 阅读进度
 */

import { normalizeBookFields, dedupeBooks, findSameBookRecord } from './book-identity.js';

const DB_NAME = 'zhijian';
const DB_VERSION = 3;

let _db = null;

function openDb() {
	if (_db) return Promise.resolve(_db);
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (e) => {
			const db = e.target.result;
			if (!db.objectStoreNames.contains('books')) {
				db.createObjectStore('books', { keyPath: 'id' });
			}
			if (!db.objectStoreNames.contains('toc')) {
				db.createObjectStore('toc', { keyPath: 'bookId' });
			}
			if (!db.objectStoreNames.contains('chapters')) {
				const s = db.createObjectStore('chapters', { keyPath: ['bookId', 'idx'] });
				s.createIndex('byBook', 'bookId');
			}
			if (!db.objectStoreNames.contains('progress')) {
				db.createObjectStore('progress', { keyPath: 'bookId' });
			}
			if (!db.objectStoreNames.contains('downloads')) db.createObjectStore('downloads', { keyPath: 'bookId' });
			if (!db.objectStoreNames.contains('bookmarks')) {
				const store = db.createObjectStore('bookmarks', { keyPath: 'id' });
				store.createIndex('byBook', 'bookId');
			}
			// 本地导入书的原始文件（EPUB/TXT 字节）——用于跨设备云同步时原样重传/重传导入
			if (!db.objectStoreNames.contains('files')) {
				db.createObjectStore('files', { keyPath: 'hash' });
			}
		};
		req.onsuccess = () => { _db = req.result; resolve(_db); };
		req.onerror = () => reject(req.error);
	});
}

function tx(store, mode, fn) {
	return openDb().then(
		(db) =>
			new Promise((resolve, reject) => {
				const t = db.transaction(store, mode);
				const s = t.objectStore(store);
				const result = fn(s);
				t.oncomplete = () => resolve(result && result.__value !== undefined ? result.__value : result);
				t.onerror = () => reject(t.error);
			})
	);
}

function reqValue(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

// ---------- 书籍 ----------

/**
 * 新增书籍（**唯一写入闸门**）。
 *
 * 两件事：
 *  1. 统一身份字段（书名/作者/书源的归一化）——所有入架路径
 *     （搜索入架 / 本地导入 / 同步拉取 / 换源新建）都经过这里，
 *     保证任何地方算出的身份键口径一致，不会因写法差异被当成两本书。
 *  2. 同身份去重——若书架上已有「同一本 + 同一书源」的记录（含键写法不同、
 *     历史上被复制出来的重复），则把新书并入那条已有记录，**不再新建**。
 *     这是「检查更新后书架多出一本」这类问题的最后一道防线：
 *     即使某个调用方忘了查重，也不会产生重复。
 *
 * @returns {Promise<object>} 实际落库的记录（复用已有记录时返回那条记录，
 *   调用方必须使用其 id 继续写目录/章节，否则会挂到不存在的 id 上）
 */
export async function addBook(book) {
	const db = await openDb();
	const record = normalizeBookFields(book);

	// 已有同身份记录 → 合并进它（不新增）
	const existing = findSameBookRecord(record, await getBooks());
	if (existing && existing.id !== record.id) {
		const patch = {};
		if (!existing.coverStyle && record.coverStyle) patch.coverStyle = record.coverStyle;
		if ((record.totalChapters || 0) > (existing.totalChapters || 0)) patch.totalChapters = record.totalChapters;
		if ((record.readChapters || 0) > (existing.readChapters || 0)) patch.readChapters = record.readChapters;
		if ((record.lastReadAt || 0) > (existing.lastReadAt || 0)) patch.lastReadAt = record.lastReadAt;
		if (!existing.tocUrl && record.tocUrl) patch.tocUrl = record.tocUrl;
		if (!existing.bookUrl && record.bookUrl) patch.bookUrl = record.bookUrl;
		if (!existing.author && record.author) patch.author = record.author;
		if (!existing.sourceName && record.sourceName) patch.sourceName = record.sourceName;
		if (Object.keys(patch).length) await updateBook(existing.id, patch);
		return { ...existing, ...patch, __merged: true };
	}

	return new Promise((resolve, reject) => {
		const t = db.transaction('books', 'readwrite');
		t.objectStore('books').put(record);
		t.oncomplete = () => resolve(record);
		t.onerror = () => reject(t.error);
	});
}

export async function getBooks() {
	const db = await openDb();
	return reqValue(db.transaction('books').objectStore('books').getAll());
}

/**
 * 书架记录 + 去重后的结果（只读，不写库）。
 * 用于「同一身份+同一书源」出现多条历史重复时，界面只呈现一条——
 * 真正的合并由 reconcile.js 在同步时落库。
 */
export async function getBooksDeduped() {
	const { books } = dedupeBooks(await getBooks());
	return books;
}

export async function getBook(id) {
	const db = await openDb();
	return reqValue(db.transaction('books').objectStore('books').get(id));
}

/**
 * 更新书籍记录。
 * - 找不到该 id 时 resolve(null)，调用方需要据此判断（旧实现静默什么都不做）
 * - 若 patch 改了书名/作者/书源，会重新走身份归一化，避免更新后键漂移
 */
export async function updateBook(id, patch) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('books', 'readwrite');
		const store = t.objectStore('books');
		let next = null;
		store.get(id).onsuccess = (event) => {
			if (!event.target.result) return;
			const touchesIdentity = patch && ('title' in patch || 'author' in patch || 'sourceId' in patch);
			const merged = { ...event.target.result, ...patch, updatedAt: Date.now() };
			next = touchesIdentity ? normalizeBookFields(merged) : merged;
			store.put(next);
		};
		t.oncomplete = () => resolve(next);
		t.onerror = () => reject(t.error);
	});
}

/**
 * 删除书籍（书 + 目录 + 章节 + 进度 + 书签 + 缓存任务）。
 * @param {string} id
 * @param {{releaseFile?: boolean}} [opts] releaseFile：用户主动删书时一并清理原始文件
 *   （合并重复记录等内部搬迁不要传，避免把仍被引用的文件删掉）
 */
export async function deleteBook(id, { releaseFile = false } = {}) {
	const db = await openDb();
	// 记下这本书引用的原始文件哈希：删完后若已无其他记录引用，连同文件一起清掉，
	// 否则 IndexedDB 的 files 存储会一直留着这些 EPUB/TXT 字节（只增不减）。
	const doomed = releaseFile ? await reqValue(db.transaction('books').objectStore('books').get(id)) : null;
	const fileHash = doomed?.fileHash || '';
	// 删除书 + 目录 + 全部章节 + 进度
	return new Promise((resolve, reject) => {
		const t = db.transaction(['books', 'toc', 'chapters', 'progress', 'downloads', 'bookmarks'], 'readwrite');
		t.objectStore('books').delete(id);
		t.objectStore('toc').delete(id);
		t.objectStore('progress').delete(id);
		t.objectStore('downloads').delete(id);
		t.objectStore('bookmarks').index('byBook').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (event) => {
			const cursor = event.target.result;
			if (cursor) { t.objectStore('bookmarks').delete(cursor.primaryKey); cursor.continue(); }
		};
		const idx = t.objectStore('chapters').index('byBook');
		idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
			const cursor = e.target.result;
			if (cursor) {
				t.objectStore('chapters').delete(cursor.primaryKey);
				cursor.continue();
			}
		};
		t.oncomplete = () => {
			if (fileHash) releaseFileIfOrphaned(db, fileHash).catch(() => {});
			resolve(true);
		};
		t.onerror = () => reject(t.error);
	});
}

/** 没有任何书记录再引用该哈希时，删除原始文件（跨设备同步仍可重新下载） */
async function releaseFileIfOrphaned(db, hash) {
	const books = await reqValue(db.transaction('books').objectStore('books').getAll());
	if (books.some((b) => b && b.fileHash === hash)) return;
	await deleteBookFile(hash);
}

// ---------- 目录 ----------

export async function saveToc(bookId, chapters) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('toc', 'readwrite');
		t.objectStore('toc').put({ bookId, chapters, savedAt: Date.now() });
		t.oncomplete = () => resolve(true);
		t.onerror = () => reject(t.error);
	});
}

export async function getToc(bookId) {
	const db = await openDb();
	const row = await reqValue(db.transaction('toc').objectStore('toc').get(bookId));
	return row ? row.chapters : null;
}

// ---------- 章节内容 ----------

export async function saveChapters(bookId, chapterList) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('chapters', 'readwrite');
		const store = t.objectStore('chapters');
		for (const ch of chapterList) {
			const images = ch.images?.length ? ch.images : undefined;
			store.put({
				bookId,
				idx: ch.idx,
				title: ch.title,
				paragraphs: ch.paragraphs,
				// 漫画章节没有文字，正文是图片字节（本地导入 / 已缓存的在线章节）
				images,
				// 在线漫画尚未下载的图片地址（阅读时按需下载并回写 images）
				imageUrls: !images && ch.imageUrls?.length ? ch.imageUrls : undefined,
				totalChars: ch.totalChars || (ch.paragraphs || []).join('').length,
				url: ch.url || '',
				cachedAt: Date.now()
			});
		}
		t.oncomplete = () => resolve(true);
		t.onerror = () => reject(t.error);
	});
}

export async function getChapter(bookId, idx) {
	const db = await openDb();
	return reqValue(db.transaction('chapters').objectStore('chapters').get([bookId, idx]));
}

export async function countCachedChapters(bookId) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const idx = db.transaction('chapters').objectStore('chapters').index('byBook');
		const req = idx.count(IDBKeyRange.only(bookId));
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/** 已缓存章节序号（用于断点续传和目录状态） */
export async function getCachedChapterIndices(bookId) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const idx = db.transaction('chapters').objectStore('chapters').index('byBook');
		const out = [];
		const req = idx.openCursor(IDBKeyRange.only(bookId));
		req.onsuccess = (e) => {
			const cursor = e.target.result;
			if (!cursor) {
				out.sort((a, b) => a - b);
				resolve(out);
				return;
			}
			const key = cursor.primaryKey;
			if (Array.isArray(key) && Number.isInteger(key[1])) out.push(key[1]);
			cursor.continue();
		};
		req.onerror = () => reject(req.error);
	});
}

// ---------- 阅读进度 ----------

export async function saveProgress(progress) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('progress', 'readwrite');
		// 允许调用方传入 updatedAt（跨设备同步保持远端时间戳）；本地阅读时自动用当前时间
		t.objectStore('progress').put({ ...progress, updatedAt: progress.updatedAt || Date.now() });
		t.oncomplete = () => resolve(true);
		t.onerror = () => reject(t.error);
	});
}

export async function getProgress(bookId) {
	const db = await openDb();
	return reqValue(db.transaction('progress').objectStore('progress').get(bookId));
}

/** 全部阅读进度（跨设备同步用） */
export async function getAllProgress() {
	const db = await openDb();
	return reqValue(db.transaction('progress').objectStore('progress').getAll());
}

export async function getDownload(bookId) {
	const db = await openDb();
	return reqValue(db.transaction('downloads').objectStore('downloads').get(bookId));
}

export async function saveDownload(job) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('downloads', 'readwrite');
		t.objectStore('downloads').put({ ...job, updatedAt: Date.now() });
		t.oncomplete = () => resolve(job);
		t.onerror = () => reject(t.error);
	});
}

export async function getBookmarks(bookId) {
	const db = await openDb();
	return reqValue(db.transaction('bookmarks').objectStore('bookmarks').index('byBook').getAll(IDBKeyRange.only(bookId)));
}

/** 全部书签（跨设备同步用） */
export async function getAllBookmarks() {
	const db = await openDb();
	return reqValue(db.transaction('bookmarks').objectStore('bookmarks').getAll());
}

export async function saveBookmark(mark) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('bookmarks', 'readwrite');
		t.objectStore('bookmarks').put(mark);
		t.oncomplete = () => resolve(mark);
		t.onerror = () => reject(t.error);
	});
}

export async function deleteBookmark(id) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('bookmarks', 'readwrite');
		t.objectStore('bookmarks').delete(id);
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error);
	});
}

// ---------- 本地书原始文件（跨设备云同步用） ----------

/** 保存原始文件字节（按内容哈希去重，重复保存直接覆盖同一份） */
export async function saveBookFile(hash, bytes, meta = {}) {
	if (!hash) throw new Error('缺少文件哈希');
	const buf = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
	if (!(buf instanceof ArrayBuffer)) throw new Error('无效的文件数据');
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('files', 'readwrite');
		t.objectStore('files').put({ hash, bytes: buf, size: buf.byteLength, savedAt: Date.now(), ...meta });
		t.oncomplete = () => resolve({ hash, size: buf.byteLength });
		t.onerror = () => reject(t.error);
	});
}

/** 读取原始文件记录（{ hash, bytes, size, name? }）；不存在返回 null */
export async function getBookFile(hash) {
	if (!hash) return null;
	const db = await openDb();
	return reqValue(db.transaction('files').objectStore('files').get(hash));
}

export async function deleteBookFile(hash) {
	if (!hash) return;
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('files', 'readwrite');
		t.objectStore('files').delete(hash);
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error);
	});
}
