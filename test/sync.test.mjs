/**
 * 同步合并逻辑测试（多书源 / 旧版 key 迁移 / 最远优先 / 换源同步）
 * 运行: npm run test:sync
 */
const store = new Map();
globalThis.localStorage = {
	getItem: (k) => (store.has(k) ? store.get(k) : null),
	setItem: (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k)
};

const { bookKeyOf, _mergeSnapshotsForTest: mergeSnapshots } = await import('../src/store/sync.js');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
}

const S1 = '书名\u0001作者\u0001sn-5';   // 源 A
const S2 = '书名\u0001作者\u0001sn-7';   // 源 B（同一本书的另一书源）

console.log('== 1. bookKeyOf 含书源段 ==');
const k1 = bookKeyOf({ title: '书名', author: '作者', sourceId: 'sn-5' });
check('key = 书名+作者+书源', k1 === S1, k1);
check('不同书源 key 不同', bookKeyOf({ title: '书名', author: '作者', sourceId: 'sn-7' }) === S2);

console.log('== 2. 同书同源：最远优先 ==');
{
	const local = {
		progress: { [S1]: { anchor: { chapterIdx: 10, paragraphIdx: 3, charOffset: 100 }, chapterIdx: 10, updatedAt: 2000 } },
		bookmarks: [], books: [{ key: S1, sourceId: 'sn-5', readChapters: 10 }],
		reading: { devices: {} }
	};
	const remote = {
		progress: { [S1]: { anchor: { chapterIdx: 50, paragraphIdx: 1, charOffset: 20 }, chapterIdx: 50, updatedAt: 1000 } },
		bookmarks: [], books: [{ key: S1, sourceId: 'sn-5', readChapters: 50 }],
		reading: { devices: {} }
	};
	const m = mergeSnapshots(local, remote);
	check('远端读得更远 → 取远端（不因时间旧而丢弃）', m.progress[S1].chapterIdx === 50);
	check('书架合并为一条', m.books.length === 1);
	check('readChapters 取 max', m.books[0].readChapters === 50);
}

console.log('== 3. 同书不同源：进度互不串扰 ==');
{
	const local = {
		progress: { [S1]: { anchor: { chapterIdx: 300 }, chapterIdx: 300, updatedAt: 1 } },
		bookmarks: [], books: [{ key: S1, sourceId: 'sn-5', readChapters: 300 }],
		reading: { devices: {} }
	};
	const remote = {
		progress: { [S2]: { anchor: { chapterIdx: 900 }, chapterIdx: 900, updatedAt: 2 } },
		bookmarks: [], books: [{ key: S2, sourceId: 'sn-7', readChapters: 900 }],
		reading: { devices: {} }
	};
	const m = mergeSnapshots(local, remote);
	check('两个书源各自保留进度', m.progress[S1].chapterIdx === 300 && m.progress[S2].chapterIdx === 900);
	check('书架保留两个来源（多源）', m.books.length === 2);
}

console.log('== 4. v1 旧 key 迁移（无书源段 → 补书源段） ==');
{
	const local = {
		progress: { [S1]: { anchor: { chapterIdx: 20 }, chapterIdx: 20, updatedAt: 1 } },
		bookmarks: [], books: [{ key: S1, sourceId: 'sn-5' }],
		reading: { devices: {} }
	};
	const remote = {
		progress: { '书名\u0001作者': { anchor: { chapterIdx: 80 }, chapterIdx: 80, updatedAt: 5 } },
		bookmarks: [{ key: '书名\u0001作者', anchor: { chapterIdx: 80, paragraphIdx: 2, charOffset: 5 }, text: '笔记' }],
		books: [{ key: '书名\u0001作者', sourceId: 'sn-5', title: '书名', author: '作者' }],
		reading: { devices: {} }
	};
	const m = mergeSnapshots(local, remote);
	check('旧进度迁移到新 key 并参与合并', m.progress[S1]?.chapterIdx === 80, JSON.stringify(m.progress));
	check('旧书架条目迁移', m.books.length === 1 && m.books[0].key === S1);
	check('旧书签迁移', m.bookmarks.length === 1 && m.bookmarks[0].key === S1);
}

console.log('== 5. 无归属的旧条目丢弃（书架里查不到书源） ==');
{
	const local = { progress: {}, bookmarks: [], books: [], reading: { devices: {} } };
	const remote = {
		progress: { '旧书\u0001旧作者': { anchor: { chapterIdx: 1 }, chapterIdx: 1 } },
		bookmarks: [{ key: '旧书\u0001旧作者', anchor: { chapterIdx: 1 } }],
		books: [], reading: { devices: {} }
	};
	const m = mergeSnapshots(local, remote);
	check('无书源信息的旧进度被丢弃', Object.keys(m.progress).length === 0);
	check('无书源信息的旧书签被丢弃', m.bookmarks.length === 0);
}

console.log('== 6. 换源选择跨设备同步（activeAt 新者赢） ==');
{
	const mk = (key, sid, active, activeAt) => ({ key, sourceId: sid, active: active ? 1 : 0, activeAt });
	const local = {
		progress: {}, bookmarks: [],
		books: [mk(S1, 'sn-5', true, 1000), mk(S2, 'sn-7', false, 0)],
		reading: { devices: {} }
	};
	const remote = {
		progress: {}, bookmarks: [],
		books: [mk(S1, 'sn-5', false, 500), mk(S2, 'sn-7', true, 9000)],
		reading: { devices: {} }
	};
	const m = mergeSnapshots(local, remote);
	const a = m.books.find((b) => b.key === S1);
	const b = m.books.find((b) => b.key === S2);
	check('源A 跟随本机（activeAt 1000 > 500）', a.active === 1);
	check('源B 跟随对端（activeAt 9000 > 0）', b.active === 1, JSON.stringify(b));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
