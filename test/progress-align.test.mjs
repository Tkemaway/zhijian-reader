/**
 * 进度 / 书签的「目录漂移对齐」回归测试
 * 运行: npm run test:progress
 *
 * 场景：两台设备的目录版本不同（一端检查过更新、另一端还是旧目录），
 * 远端进度的 chapterIdx 直接套到本机会错位、越界时还会落到最后一章。
 * 本测试验证：
 *   1. 章节被前插/重排时，按 chapterTitle 找回原章节，锚点保留；
 *   2. 越界且标题对不上 → 收敛到有效范围、丢弃锚点，且不覆盖本机更远的进度；
 *   3. 书签同样按标题对齐；
 *   4. 序号与标题一致时原样应用（不误伤）。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from './helpers/fake-idb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
install();

// ---- 最小环境桩 ----
const mem = new Map();
globalThis.localStorage = {
	getItem: (k) => (mem.has(k) ? mem.get(k) : null),
	setItem: (k, v) => mem.set(k, String(v)),
	removeItem: (k) => mem.delete(k)
};
globalThis.DOMParser = class {};
let gistContent = null;
globalThis.fetch = async (url, opts = {}) => {
	const u = String(url);
	const method = (opts.method || 'GET').toUpperCase();
	const json = (o) => ({
		status: 200, ok: true, url: u,
		headers: { get: () => 'application/json' },
		json: async () => o,
		text: async () => JSON.stringify(o),
		arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(o)).buffer
	});
	if (u.includes('/gists?')) return json([{ id: 'G1', description: 'zhijian-sync-v1' }]);
	if (u.includes('/gists/G1') && method === 'GET') {
		return json({ id: 'G1', files: { 'zhijian-sync.json': { content: gistContent, truncated: false } } });
	}
	if (u.includes('/gists/G1') && method === 'PATCH') {
		gistContent = JSON.parse(opts.body).files['zhijian-sync.json'].content;
		return json({ id: 'G1' });
	}
	throw new Error('unexpected ' + method + ' ' + u);
};

const id = (p) => pathToFileURL(path.join(SRC, p)).href;
const identity = await import(id('store/book-identity.js'));
const db = await import(id('store/db.js'));
const sync = await import(id('store/sync.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

const BOOK = { id: 'p1', title: '测试书', author: '作者甲', sourceId: 'sn-5' };
const KEY = identity.bookIdentityKey(BOOK);
const TOC = ['第1章', '第2章', '第3章', '第4章', '第5章'].map((t, i) => ({ title: t, url: `u${i}` }));

function remoteSnapshot({ progress, bookmarks = [] }) {
	return {
		version: 2,
		updatedAt: Date.now(),
		progress: progress || {},
		bookmarks,
		books: [{
			key: KEY, title: BOOK.title, author: BOOK.author, sourceId: BOOK.sourceId,
			sourceName: '测试源', totalChapters: TOC.length, readChapters: 0,
			addedAt: 1, lastReadAt: 0, active: 0, activeAt: 0
		}],
		reading: { devices: {} }
	};
}

async function resetLocal({ progress = null } = {}) {
	// 清空 books/toc/progress/bookmarks 后再铺场景
	for (const b of await db.getBooks()) await db.deleteBook(b.id);
	await db.addBook({ ...BOOK, totalChapters: TOC.length, addedAt: 1 });
	await db.saveToc(BOOK.id, TOC.map((c) => ({ ...c })));
	if (progress) await db.saveProgress({ bookId: BOOK.id, ...progress });
	sync.saveSyncConfig({ token: 't', enabled: true, gistId: 'G1' });
}

console.log('== 1. 章节前插：按标题找回原章节 ==');
{
	await resetLocal({
		progress: { chapterIdx: 1, chapterTitle: '第2章', anchor: { chapterIdx: 1, paragraphIdx: 0, charOffset: 0 }, updatedAt: 100 }
	});
	// 远端目录多了两章（「第2章」在那边是 idx 3）
	gistContent = JSON.stringify(remoteSnapshot({
		progress: {
			[KEY]: { chapterIdx: 3, chapterTitle: '第2章', anchor: { chapterIdx: 3, paragraphIdx: 2, charOffset: 10 }, updatedAt: 200 }
		}
	}));
	await sync.syncNow();
	const p = await db.getProgress(BOOK.id);
	check('对齐到本机 idx=1', p?.chapterIdx === 1, JSON.stringify(p?.chapterIdx));
	check('标题命中时锚点保留', p?.anchor?.paragraphIdx === 2 && p?.anchor?.charOffset === 10, JSON.stringify(p?.anchor));
}

console.log('== 2. 越界且标题对不上：收敛且不覆盖本机更远进度 ==');
{
	await resetLocal({
		progress: { chapterIdx: 4, chapterTitle: '第5章', anchor: { chapterIdx: 4, paragraphIdx: 5, charOffset: 3 }, updatedAt: 100 }
	});
	gistContent = JSON.stringify(remoteSnapshot({
		progress: {
			[KEY]: { chapterIdx: 50, chapterTitle: '第 999 章 不存在的章节', anchor: { chapterIdx: 50, paragraphIdx: 9, charOffset: 99 }, updatedAt: 999 }
		}
	}));
	await sync.syncNow();
	const p = await db.getProgress(BOOK.id);
	check('本地更远 → 不被错位进度覆盖', p?.anchor?.paragraphIdx === 5, JSON.stringify(p));
}

console.log('== 3. 越界但标题命中：对齐后照常应用 ==');
{
	await resetLocal({
		progress: { chapterIdx: 1, chapterTitle: '第2章', anchor: { chapterIdx: 1, paragraphIdx: 0, charOffset: 0 }, updatedAt: 100 }
	});
	gistContent = JSON.stringify(remoteSnapshot({
		progress: {
			[KEY]: { chapterIdx: 88, chapterTitle: '第4章', anchor: { chapterIdx: 88, paragraphIdx: 4, charOffset: 8 }, updatedAt: 300 }
		}
	}));
	await sync.syncNow();
	const p = await db.getProgress(BOOK.id);
	check('对齐到 idx=3', p?.chapterIdx === 3, JSON.stringify(p?.chapterIdx));
	check('锚点保留', p?.anchor?.paragraphIdx === 4, JSON.stringify(p?.anchor));
}

console.log('== 4. 书签按标题对齐 ==');
{
	await resetLocal();
	gistContent = JSON.stringify(remoteSnapshot({
		progress: {},
		bookmarks: [{
			key: KEY, chapterTitle: '第3章',
			anchor: { chapterIdx: 7, paragraphIdx: 1, charOffset: 12 },
			text: '划线的句子', createdAt: 5
		}]
	}));
	await sync.syncNow();
	const marks = await db.getBookmarks(BOOK.id);
	check('书签已写入', marks.length === 1, JSON.stringify(marks));
	check('书签章节对齐到 idx=2', marks[0]?.anchor?.chapterIdx === 2, JSON.stringify(marks[0]?.anchor));
	check('书签段落/字符偏移保留', marks[0]?.anchor?.paragraphIdx === 1 && marks[0]?.anchor?.charOffset === 12);
}

console.log('== 5. 序号与标题一致：原样应用 ==');
{
	await resetLocal();
	gistContent = JSON.stringify(remoteSnapshot({
		progress: {
			[KEY]: { chapterIdx: 2, chapterTitle: '第3章', anchor: { chapterIdx: 2, paragraphIdx: 3, charOffset: 7 }, updatedAt: 200 }
		}
	}));
	await sync.syncNow();
	const p = await db.getProgress(BOOK.id);
	check('chapterIdx 保持 2', p?.chapterIdx === 2, JSON.stringify(p?.chapterIdx));
	check('锚点原样', p?.anchor?.paragraphIdx === 3 && p?.anchor?.charOffset === 7);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
