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
check('文件名带 zhijian- 前缀与哈希', /^zhijian-[0-9a-f]{16}-/.test(remoteKey), remoteKey);
check('内容一致', Buffer.from(files.get(remoteKey)).toString() === 'EPUB-CONTENT-1234');

console.log('== JSON 快照读写 ==');
await bf.davWriteText('zhijian-sync.json', JSON.stringify({ hello: '世界' }));
const back = await bf.davReadText('zhijian-sync.json');
check('写后读回一致', JSON.parse(back).hello === '世界', back);
check('不存在的文件返回 null', (await bf.davReadText('nope.json')) === null);

console.log('== 错误提示 ==');
bf.saveFileSyncConfig({ pass: 'wrong', enabled: true });
try { await bf.testFileSyncConnection(); check('错误密码应抛错', false); }
catch (e) { check('错误密码给出 401 提示', /401|不正确/.test(String(e.message)), e.message); }

server.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
