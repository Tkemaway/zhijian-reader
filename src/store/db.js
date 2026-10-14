/**
 * 数据层 —— IndexedDB 书库存储
 * books: 书籍信息
 * toc:   目录（按书记）
 * chapters: 章节内容（按书+序号）
 * progress: 阅读进度
 */

const DB_NAME = 'zhijian';
const DB_VERSION = 2;

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

export async function addBook(book) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('books', 'readwrite');
		t.objectStore('books').put(book);
		t.oncomplete = () => resolve(book);
		t.onerror = () => reject(t.error);
	});
}

export async function getBooks() {
	const db = await openDb();
	return reqValue(db.transaction('books').objectStore('books').getAll());
}

export async function getBook(id) {
	const db = await openDb();
	return reqValue(db.transaction('books').objectStore('books').get(id));
}

export async function updateBook(id, patch) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('books', 'readwrite');
		const store = t.objectStore('books');
		let next = null;
		store.get(id).onsuccess = (event) => {
			if (!event.target.result) return;
			next = { ...event.target.result, ...patch, updatedAt: Date.now() };
			store.put(next);
		};
		t.oncomplete = () => resolve(next);
		t.onerror = () => reject(t.error);
	});
}

export async function deleteBook(id) {
	const db = await openDb();
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
		t.oncomplete = () => resolve(true);
		t.onerror = () => reject(t.error);
	});
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

export async function saveChapter(bookId, idx, chapter) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('chapters', 'readwrite');
		t.objectStore('chapters').put({
			bookId,
			idx,
			title: chapter.title,
			paragraphs: chapter.paragraphs,
			cachedAt: Date.now()
		});
		t.oncomplete = () => resolve(true);
		t.onerror = () => reject(t.error);
	});
}

export async function saveChapters(bookId, chapterList) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const t = db.transaction('chapters', 'readwrite');
		const store = t.objectStore('chapters');
		for (const ch of chapterList) {
			store.put({
				bookId,
				idx: ch.idx,
				title: ch.title,
				paragraphs: ch.paragraphs,
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
