/**
 * 本地书跨设备同步（元数据 + 待下载队列）回归测试
 * 运行: npm run test:local
 *
 * 文件本体走 WebDAV（不在 Node 里真连），这里验证同步协议层：
 *   1. 带文件指纹的本地书会进入同步快照；
 *   2. 远端有、本机没有的本地书 → 不建"幽灵书"，而是进入待下载队列；
 *   3. 导入完成后（本地已有同身份记录）待下载队列清空；
 *   4. 哈希与云端文件名的去重规则。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from './helpers/fake-idb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
install();

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
const db = await import(id('store/db.js'));
const sync = await import(id('store/sync.js'));
const files = await import(id('store/book-files.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

console.log('== 1. 哈希与云端文件命名 ==');
{
	const h = await files.sha256Hex(new TextEncoder().encode('hello world'));
	check('SHA-256 为 64 位十六进制', /^[0-9a-f]{64}$/.test(h), h);
	const h2 = await files.sha256Hex(new TextEncoder().encode('hello world'));
	check('同内容哈希稳定', h === h2);
	const name = files.remoteNameFor('abcdef1234567890ffff', '斗破苍穹 第1卷.epub');
	check('文件名保留中文与扩展名、空格转下划线', name === 'abcdef1234567890-斗破苍穹_第1卷.epub', name);
	const name2 = files.remoteNameFor('abcdef1234567890ffff', '无扩展名');
	check('缺扩展名时补 .epub', name2.endsWith('.epub'), name2);
}

console.log('== 2. 本地书文件指纹进入同步快照 ==');
{
	sync.saveSyncConfig({ token: 't', enabled: true, gistId: 'G1' });
	await db.addBook({
		id: 'l1', title: '我的电子书', author: '某作者', sourceId: 'local',
		totalChapters: 3, fileHash: 'abc123', fileName: '我的电子书.epub',
		fileSize: 1234, fileRemoteName: 'abc123-我的电子书.epub', fileUploadedAt: 1
	});
	await sync.syncNow();
	const snap = JSON.parse(gistContent);
	const entry = (snap.books || []).find((b) => b.sourceId === 'local');
	check('快照包含本地书', !!entry);
	check('带 fileRemoteName / fileHash', entry?.fileRemoteName === 'abc123-我的电子书.epub' && entry?.fileHash === 'abc123', JSON.stringify(entry));
}

console.log('== 3. 远端本地书 → 待下载队列（不建幽灵书）==');
{
	gistContent = JSON.stringify({
		version: 2,
		updatedAt: 1,
		progress: {},
		bookmarks: [],
		books: [{
			key: '另一本书\u0001另一个作者\u0001local',
			title: '另一本书', author: '另一个作者', sourceId: 'local',
			fileHash: 'fff000', fileName: '另一本书.epub',
			fileRemoteName: 'fff000-另一本书.epub', fileSize: 900
		}],
		reading: { devices: {} }
	});
	await sync.syncNow();
	const books = await db.getBooks();
	check('不创建幽灵书', !books.some((b) => b.title === '另一本书'), JSON.stringify(books.map((b) => b.title)));
	const pending = sync.getPendingLocalDownloads();
	check('进入待下载列表', pending.length === 1 && pending[0].fileRemoteName === 'fff000-另一本书.epub', JSON.stringify(pending));
}

console.log('== 4. 导入后待下载队列清空 ==');
{
	await db.addBook({
		id: 'l2', title: '另一本书', author: '另一个作者', sourceId: 'local',
		totalChapters: 2, fileHash: 'fff000', fileName: '另一本书.epub',
		fileRemoteName: 'fff000-另一本书.epub', fileUploadedAt: 1
	});
	await sync.syncNow();
	check('本地已有该书 → 不再待下载', sync.getPendingLocalDownloads().length === 0, JSON.stringify(sync.getPendingLocalDownloads()));
	const books = await db.getBooks();
	check('仍然只有一本（没有重复创建）', books.filter((b) => b.title === '另一本书').length === 1);
}

console.log('== 5. 未上传的本地书不进入快照 ==');
{
	await db.addBook({
		id: 'l3', title: '还没上传的书', author: '某作者', sourceId: 'local',
		totalChapters: 1, fileHash: 'zzz', fileName: '还没上传的书.epub', fileRemoteName: ''
	});
	await sync.syncNow();
	const snap = JSON.parse(gistContent);
	check('没有 fileRemoteName 时不进快照', !(snap.books || []).some((b) => b.title === '还没上传的书'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
