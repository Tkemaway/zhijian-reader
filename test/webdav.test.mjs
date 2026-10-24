/** WebDAV 客户端回归：鉴权、PUT/GET/DELETE、上传本地书、JSON 快照读写 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from './helpers/fake-idb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
install();

// ---- 本地 WebDAV 模拟服务器 ----
const files = new Map();
const AUTH = 'Basic ' + Buffer.from('me@example.com:app-pass').toString('base64');
const server = http.createServer((req, res) => {
	if (req.headers.authorization !== AUTH) { res.writeHead(401); res.end('unauthorized'); return; }
	const key = decodeURIComponent(req.url.replace(/^\/dav\/?/, ''));
	const chunks = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', () => {
		if (req.method === 'PUT') {
			files.set(key, Buffer.concat(chunks));
			res.writeHead(201); res.end();
		} else if (req.method === 'GET') {
			if (!files.has(key)) { res.writeHead(404); res.end('not found'); return; }
			res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
			res.end(files.get(key));
		} else if (req.method === 'DELETE') {
			files.delete(key); res.writeHead(204); res.end();
		} else {
			res.writeHead(405); res.end('method not allowed');
		}
	});
});
await new Promise((r) => server.listen(18080, '127.0.0.1', r));

// ---- 环境桩 ----
const mem = new Map();
globalThis.localStorage = {
	getItem: (k) => (mem.has(k) ? mem.get(k) : null),
	setItem: (k, v) => mem.set(k, String(v)),
	removeItem: (k) => mem.delete(k)
};

const id = (p) => pathToFileURL(path.join(__dirname, '..', 'src', p)).href;
const db = await import(id('store/db.js'));
const bf = await import(id('store/book-files.js'));
const sync = await import(id('store/sync.js'));
const auto = await import(id('store/auto-sync.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

console.log('== 地址清洗 ==');
check('去掉零宽字符', bf.normalizeDavUrl('https://dav.jianguoyun.com/\u200bdav/') === 'https://dav.jianguoyun.com/dav/', bf.normalizeDavUrl('https://dav.jianguoyun.com/\u200bdav/'));
check('缺 /dav 自动补', bf.normalizeDavUrl('dav.jianguoyun.com') === 'https://dav.jianguoyun.com/dav/', bf.normalizeDavUrl('dav.jianguoyun.com'));
check('补协议与结尾斜杠', bf.normalizeDavUrl('example.com/dav') === 'https://example.com/dav/', bf.normalizeDavUrl('example.com/dav'));

console.log('== 连接测试（写→读→删）==');
bf.saveFileSyncConfig({ url: 'http://127.0.0.1:18080/dav/', user: 'me@example.com', pass: 'app-pass', enabled: true });
await bf.testFileSyncConnection();
check('连接测试通过', true);
check('探针已清理', [...files.keys()].every((k) => !k.startsWith('zhijian-probe')));

console.log('== 上传本地书 ==');
const bytes = new TextEncoder().encode('EPUB-CONTENT-1234');
const hash = await bf.sha256Hex(bytes);
await db.addBook({
	id: 'l1', title: '测试本地书', author: '作者', sourceId: 'local', totalChapters: 1,
	fileHash: hash, fileName: '测试本地书.epub', fileSize: bytes.length,
	fileRemoteName: bf.remoteNameFor(hash, '测试本地书.epub'), fileUploadedAt: 0
});
await db.saveBookFile(hash, bytes, { name: '测试本地书.epub' });
const book = (await db.getBooks())[0];
await bf.uploadLocalBookFile(book, { force: true });
const remoteKey = [...files.keys()][0];
check('云端收到文件', files.size === 1, JSON.stringify([...files.keys()]));
check('写入 zhijian/ 目录且带哈希前缀', /^zhijian\/zhijian-[0-9a-f]{16}-/.test(remoteKey), remoteKey);
check('内容一致', Buffer.from(files.get(remoteKey)).toString() === 'EPUB-CONTENT-1234');

console.log('== 旧本地书（无原文件）自动打包上传 ==');
const before = new Set(files.keys());
await db.addBook({ id: 'l2', title: '旧书', author: '作者乙', sourceId: 'local', totalChapters: 2 });
await db.saveToc('l2', [{ title: '第一章', url: '' }, { title: '第二章', url: '' }]);
await db.saveChapters('l2', [
	{ idx: 0, title: '第一章', paragraphs: ['第一段'], url: '', totalChars: 3 },
	{ idx: 1, title: '第二章', paragraphs: ['第二段'], url: '', totalChars: 3 }
]);
const up = await bf.uploadAllPending({});
const l2 = await db.getBook('l2');
check('自动打包并上传成功', up.uploaded === 1 && !!l2.fileHash && l2.fileUploadedAt > 0, JSON.stringify(up));
const added = [...files.keys()].filter((k) => !before.has(k));
check('云端出现该书 EPUB', added.some((k) => k.endsWith('.epub')), JSON.stringify(added));

console.log('== JSON 快照读写 ==');
await bf.davWriteText('zhijian-sync.json', JSON.stringify({ hello: '世界' }));
const back = await bf.davReadText('zhijian-sync.json');
check('写后读回一致', JSON.parse(back).hello === '世界', back);
check('不存在的文件返回 null', (await bf.davReadText('nope.json')) === null);

console.log('== 错误提示 ==');
bf.saveFileSyncConfig({ pass: 'wrong', enabled: true });
try { await bf.testFileSyncConnection(); check('错误密码应抛错', false); }
catch (e) { check('错误密码给出 401 提示', /401|不正确/.test(String(e.message)), e.message); }

console.log('== 自动同步：只配了网盘、没开同步 ==');
bf.saveFileSyncConfig({ pass: 'app-pass', user: 'me@example.com', url: 'http://127.0.0.1:18080/dav/', enabled: true });
sync.saveSyncConfig({ enabled: false, transport: 'gist', autoDisabled: false });
const before2 = new Set(files.keys());
const res = await auto.runAutoSync({ force: true, reason: 'test' });
check('自动开启了同步', sync.isSyncEnabled() === true, JSON.stringify({ enabled: sync.loadSyncConfig().enabled }));
check('自动选用坚果云通道', sync.loadSyncConfig().transport === 'dav', sync.loadSyncConfig().transport);
check('云端出现快照', [...files.keys()].some((k) => k.endsWith('zhijian-sync.json')), JSON.stringify([...files.keys()].filter((k) => !before2.has(k))));
check('返回结果包含上传数', typeof res?.uploaded === 'number', JSON.stringify(res));

console.log('== 手动关闭后不再自动开启 ==');
sync.disableSync();
await auto.runAutoSync({ force: true, reason: 'test' });
check('用户关掉后保持关闭', sync.isSyncEnabled() === false);

server.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
