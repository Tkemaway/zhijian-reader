/**
 * “检查更新后书架多出一本” 回归测试
 * 运行: npm run test:identity
 *
 * 覆盖两条主链路（Node 环境无 IndexedDB，故用内存假实现跑**真实的** db.js /
 * sync.js / reconcile.js，而不是复制逻辑——复制的逻辑测不出真实代码的 bug）：
 *   1. 身份口径：书名的《》、(完结)、首尾/全角空格、作者「作者：」前缀、
 *      书源大小写，全部必须归一到同一个键；
 *   2. 同步收敛：远端 key 用旧写法（脏数据）时，连续多轮同步不得新增书籍记录；
 *   3. 存量清理：历史遗留的重复记录被合并，且缓存/进度/书签不丢。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, databases } from './helpers/fake-idb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

install();

// ---- 最小 DOM / 存储 / 网络桩 ----
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
const reconcile = await import(id('store/reconcile.js'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
}
async function wipe() {
	for (const b of await db.getBooks()) await db.deleteBook(b.id);
}
/** 绕过写入闸门直接落库，模拟旧版本写坏的历史数据 */
function rawPut(record) {
	databases.get('zhijian')._stores.books.store.put(record);
}
function setRemote(snapshot) { gistContent = JSON.stringify(snapshot); }
function remote() { return gistContent ? JSON.parse(gistContent) : null; }

// ============================================================
console.log('== 1. 身份归一化口径 ==');
{
	const K = identity.bookIdentityKey;
	check('书名去《》', K({ title: '《斗破苍穹》', sourceId: 's' }) === K({ title: '斗破苍穹', sourceId: 's' }));
	check('书名去 (完结)', identity.normalizeTitle('斗破苍穹（完结）') === '斗破苍穹');
	check('多重包裹收敛', identity.normalizeTitle('《《斗破苍穹》》') === '斗破苍穹');
	check('全角空格归并', identity.normalizeTitle('斗破\u3000苍穹') === '斗破 苍穹');
	check('首尾空白', identity.normalizeTitle('  斗破苍穹  ') === '斗破苍穹');
	check('作者去「作者：」', identity.normalizeAuthor('作者：天蚕土豆') === '天蚕土豆');
	check('作者前缀+空白', identity.normalizeAuthor('作者:\u00a0天蚕土豆') === '天蚕土豆');
	check('书源 id 小写', identity.normalizeSourceId('FanQie') === 'fanqie');
	check('不同书源键不同', K({ title: 'X', author: 'Y', sourceId: 'a' }) !== K({ title: 'X', author: 'Y', sourceId: 'b' }));
	check('作者前缀去掉', identity.normalizeAuthor('作者：天蚕土豆') === '天蚕土豆');
	// 作者名必须保持忠实，不能破坏性剥离「著」：否则「王著」会被改成「王」、
	// 纯「作者」会被清空。「天蚕土豆」vs「天蚕土豆 著」的差异交给匹配层处理
	check('作者名含「著」不被删改', identity.normalizeAuthor('王著') === '王著');
	check('「著」后缀不被删改', identity.normalizeAuthor('天蚕土豆 著') === '天蚕土豆 著');
	check('authorsCompatible 识别「著」后缀为同一人', identity.authorsCompatible('天蚕土豆', '天蚕土豆 著'));
	check('authorsCompatible 识别不同作者', !identity.authorsCompatible('甲', '乙'));
	// 身份键保持忠实（不破坏性改写作者名），「著」后缀由匹配层识别为同一人，
	// 这样既不会误伤真名（如「王著」），也不会把同一本书当成两本
	check('「著」后缀键不同但可匹配', K({ title: '斗破苍穹', author: '天蚕土豆 著', sourceId: 'sn-5' }) !== K({ title: '斗破苍穹', author: '天蚕土豆', sourceId: 'sn-5' })
		&& !!identity.findSameBookRecord({ title: '斗破苍穹', author: '天蚕土豆 著', sourceId: 'sn-5' }, [{ id: 'x', title: '斗破苍穹', author: '天蚕土豆', sourceId: 'sn-5' }]));
	check('不同作者算不同键', K({ title: '斗破苍穹', author: '甲', sourceId: 's' }) !== K({ title: '斗破苍穹', author: '乙', sourceId: 's' }));
	// 同名不同作者绝不能被当成同一本书（丢书比重复更严重）
	const shelf = [{ id: 'a', title: '斗破苍穹', author: '天蚕土豆', sourceId: 'sn-5' }];
	check('同名同源不同作者不匹配', !identity.findSameBookRecord({ title: '斗破苍穹', author: '另一个人', sourceId: 'sn-5' }, shelf));
	check('作者缺失时仍可匹配', !!identity.findSameBookRecord({ title: '斗破苍穹', author: '', sourceId: 'sn-5' }, shelf));
	check('作者带「著」时仍可匹配', !!identity.findSameBookRecord({ title: '斗破苍穹', author: '天蚕土豆 著', sourceId: 'sn-5' }, shelf));
	// 换源列表要覆盖作者写法不同（「著」后缀）的来源，但不能并入不同作者的同名书
	const variants = identity.findSourceVariants({ title: '斗破苍穹', author: '天蚕土豆' }, [
		{ title: '斗破苍穹', author: '天蚕土豆', sourceId: 'sn-7' },
		{ title: '斗破苍穹', author: '天蚕土豆 著', sourceId: 'sn-8' },
		{ title: '斗破苍穹', author: '另一个人', sourceId: 'sn-9' }
	]);
	check('换源覆盖「著」后缀来源', variants.length === 2 && variants.every((v) => v.sourceId !== 'sn-9'), 'n=' + variants.length + ' src=' + variants.map((v) => v.sourceId).join(','));
}

// ============================================================
console.log('\n== 2. 统一写入闸门：同身份不新增 ==');
{
	await wipe();
	await db.addBook({ id: 'g1', title: '斗破苍穹', author: '天蚕土豆', sourceId: 'sn-5', totalChapters: 100 });
	const merged = await db.addBook({ id: 'g2', title: '《斗破苍穹》 ', author: '作者：天蚕土豆', sourceId: 'SN-5', totalChapters: 130, lastReadAt: 77 });
	const books = await db.getBooks();
	check('只保留一条记录', books.length === 1, 'n=' + books.length);
	check('返回已有记录并标记合并', !!merged.__merged && merged.id === 'g1', 'id=' + merged.id);
	check('totalChapters 取较大值', books[0].totalChapters === 130, 'got=' + books[0].totalChapters);
	check('lastReadAt 取较大值', books[0].lastReadAt === 77, 'got=' + books[0].lastReadAt);
}

// ============================================================
console.log('\n== 3. 同步收敛：脏远端 key 不新增书籍 ==');
{
	const R = { key: '斗破苍穹\u0001天蚕土豆\u0001sn-5', title: '斗破苍穹', author: '天蚕土豆', sourceId: 'sn-5', sourceName: 'A源', totalChapters: 100, addedAt: 1 };
	const L = { id: 'b_local', title: '斗破苍穹', author: '天蚕土豆', sourceId: 'sn-5', sourceName: 'A源', totalChapters: 100, cachedChapters: 0, addedAt: 2, lastReadAt: 0 };
	const cases = [
		['v1 两段 key + 《》+ 尾空格', { ...R, key: '《斗破苍穹》\u0001天蚕土豆 ', title: '《斗破苍穹》 ', author: '天蚕土豆 ' }, L],
		['远端作者为空', { ...R, key: '斗破苍穹\u0001\u0001sn-5', author: '' }, L],
		['本地作者为空', R, { ...L, author: '' }],
		['作者带「著」后缀', { ...R, key: '斗破苍穹\u0001天蚕土豆 著\u0001sn-5', author: '天蚕土豆 著' }, L],
		['多重书名号', { ...R, key: '《《斗破苍穹》》\u0001天蚕土豆\u0001sn-5', title: '《《斗破苍穹》》' }, L],
		['书源 id 大小写不同', { ...R, key: '斗破苍穹\u0001天蚕土豆\u0001SN-5', sourceId: 'SN-5' }, L],
		['完全一致', R, L]
	];
	for (const [name, rb, lb] of cases) {
		await wipe();
		sync.saveSyncConfig({ token: 't', enabled: true, gistId: 'G1' });
		setRemote({ version: 2, updatedAt: 1, progress: {}, bookmarks: [], reading: { devices: {} }, books: [rb] });
		await db.addBook(lb);
		const counts = [];
		for (let i = 0; i < 4; i++) { await sync.syncNow(); counts.push((await db.getBooks()).length); }
		check('不增长: ' + name, counts.every((c) => c === counts[0]), counts.join(','));
	}
	// 关键：第 2 轮起 applied.books 必须为 0，且远端收敛为一条
	await wipe();
	sync.saveSyncConfig({ token: 't', enabled: true, gistId: 'G1' });
	setRemote({ version: 2, updatedAt: 1, progress: {}, bookmarks: [], reading: { devices: {} }, books: [{ ...R, key: '斗破苍穹\u0001天蚕土豆 \u0001sn-5', author: '天蚕土豆 ' }] });
	await db.addBook(L);
	const a1 = (await sync.syncNow()).applied;
	const a2 = (await sync.syncNow()).applied;
	const a3 = (await sync.syncNow()).applied;
	check('第 2、3 轮不再新增记录', a2.books === 0 && a3.books === 0, `第1轮+${a1.books}, 第2轮+${a2.books}, 第3轮+${a3.books}`);
	check('远端书架收敛为一条', remote().books.length === 1, 'n=' + remote().books.length);
	check('书架仍只有一条', (await db.getBooks()).length === 1);
}

// ============================================================
console.log('\n== 4. 多书源不误合 ==');
{
	await wipe();
	sync.saveSyncConfig({ token: 't', enabled: true, gistId: 'G1' });
	const R = { key: 'X书\u0001Y\u0001sn-1', title: 'X书', author: 'Y', sourceId: 'sn-1', totalChapters: 10, addedAt: 1 };
	setRemote({ version: 2, updatedAt: 1, progress: {}, bookmarks: [], reading: { devices: {} },
		books: [R, { ...R, key: 'X书\u0001Y\u0001sn-2', sourceId: 'sn-2', totalChapters: 20 }] });
	for (let i = 0; i < 3; i++) await sync.syncNow();
	const books = await db.getBooks();
	check('两个书源各自保留一条', books.length === 2, 'n=' + books.length + ' src=' + books.map((b) => b.sourceId).join(','));
	check('远端也保留两个来源', remote().books.length === 2, 'n=' + remote().books.length);

	// 同一书源下「同名不同作者」是两本不同的书，绝不能被合并/去重掉
	await wipe();
	await db.addBook({ id: 'au1', title: '同名书', author: '甲', sourceId: 'sn-1', totalChapters: 10 });
	await db.addBook({ id: 'au2', title: '同名书', author: '乙', sourceId: 'sn-1', totalChapters: 20 });
	const auBooks = await db.getBooks();
	check('同书名同源不同作者不合并', auBooks.length === 2, 'n=' + auBooks.length);

	// 但「同书同源、作者一空一有」必须合并（这是重复的来源）
	await wipe();
	await db.addBook({ id: 'an1', title: '同名书', author: '', sourceId: 'sn-1', totalChapters: 10 });
	await db.addBook({ id: 'an2', title: '同名书', author: '甲', sourceId: 'sn-1', totalChapters: 20 });
	check('作者一空一有仍合并', (await db.getBooks()).length === 1, 'n=' + (await db.getBooks()).length);
}

// ============================================================
console.log('\n== 5. 存量重复清理（缓存/进度/书签不丢） ==');
{
	await wipe();
	sync.saveSyncConfig({ token: 't', enabled: true, gistId: 'G1' });
	setRemote({ version: 2, updatedAt: 1, progress: {}, bookmarks: [], reading: { devices: {} }, books: [] });
	rawPut({ id: 'd1', title: '斗破苍穹', author: '天蚕土豆', sourceId: 'sn-5', totalChapters: 100, addedAt: 5, lastReadAt: 0 });
	rawPut({ id: 'd2', title: '斗破苍穹 ', author: '天蚕土豆 ', sourceId: 'sn-5', totalChapters: 120, addedAt: 6, lastReadAt: 99 });
	await db.saveToc('d1', [{ title: '第1章', url: 'u1' }, { title: '第2章', url: 'u2' }]);
	await db.saveChapters('d1', [{ idx: 0, title: '第1章', paragraphs: ['内容一'] }]);
	await db.saveProgress({ bookId: 'd1', chapterIdx: 1, anchor: { chapterIdx: 1, paragraphIdx: 0, charOffset: 0 } });
	await db.saveBookmark({ id: 'd1:1:0:0', bookId: 'd1', anchor: { chapterIdx: 1, paragraphIdx: 0, charOffset: 0 } });
	check('前置：确有两条重复', (await db.getBooks()).length === 2);

	const res = await reconcile.reconcileDuplicateBooks();
	const books = await db.getBooks();
	check('合并为一条', books.length === 1, 'merged=' + res.merged + ' n=' + books.length);
	check('保留有阅读进度的那条', books[0]?.id === 'd2', 'kept=' + books[0]?.id);
	check('章节数不回退', books[0]?.totalChapters === 120, 'got=' + books[0]?.totalChapters);
	check('目录已搬迁', ((await db.getToc('d2')) || []).length === 2);
	check('章节缓存已搬迁', !!(await db.getChapter('d2', 0)));
	check('进度已搬迁', !!(await db.getProgress('d2')));
	check('书签已改挂', (await db.getBookmarks('d2')).length === 1);

	// 本地有重复记录时同步不得抛错（历史 P0：pickMostRecent 未导入）
	await wipe();
	rawPut({ id: 'p1', title: 'X书', author: 'Y', sourceId: 'sn-1', totalChapters: 10, addedAt: 1 });
	rawPut({ id: 'p2', title: 'X书 ', author: 'Y ', sourceId: 'sn-1', totalChapters: 12, addedAt: 2 });
	setRemote({ version: 2, updatedAt: 1, progress: {}, bookmarks: [], reading: { devices: {} },
		books: [{ key: 'X书\u0001Y\u0001sn-1', title: 'X书', author: 'Y', sourceId: 'sn-1', totalChapters: 10, addedAt: 1 }] });
	let threw = null;
	try { await sync.syncNow(); } catch (e) { threw = e.message || String(e); }
	check('本地有重复时同步不抛错', !threw, 'threw=' + threw);
	check('同步后收敛为一条', (await db.getBooks()).length === 1, 'n=' + (await db.getBooks()).length);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
