/**
 * 漫画导入落库回归：CBZ/EPUB → 书本记录 → 章节图片 → 读取
 * 用真实 db.js（内存 IndexedDB）跑一遍，确认「导入后能读」不是纸面功能。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';
import { zipSync, strToU8 } from 'fflate';
import { install } from './helpers/fake-idb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = (p) => pathToFileURL(path.join(__dirname, '..', 'src', p)).href;

install();
globalThis.DOMParser = DOMParser;

const mem = new Map();
globalThis.localStorage = {
	getItem: (k) => (mem.has(k) ? mem.get(k) : null),
	setItem: (k, v) => mem.set(k, String(v)),
	removeItem: (k) => mem.delete(k)
};

const db = await import(id('store/db.js'));
const bf = await import(id('store/book-files.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

const PNG = Uint8Array.from(Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
));

/** 4 页、每话一个目录的漫画 EPUB */
function buildEpub() {
	const files = {
		mimetype: [strToU8('application/epub+zip'), { level: 0 }],
		'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
	<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
	};
	const manifest = [];
	const spine = [];
	['第1话/001.png', '第1话/002.png', '第2话/001.png', '第2话/002.png'].forEach((p, i) => {
		files[`OEBPS/${p}`] = PNG;
		manifest.push(`<item id="img${i}" href="${p}" media-type="image/png"/>`);
		const page = `text/p${i}.xhtml`;
		files[`OEBPS/${page}`] = strToU8(`<html><body><img src="../${p}"/></body></html>`);
		manifest.push(`<item id="p${i}" href="${page}" media-type="application/xhtml+xml"/>`);
		spine.push(`<itemref idref="p${i}"/>`);
	});
	files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
	<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
		<dc:title>测试漫画</dc:title><dc:creator>某漫画家</dc:creator>
	</metadata>
	<manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine>
</package>`);
	return zipSync(files);
}

console.log('== 导入漫画 EPUB ==');
const epub = buildEpub();
const saved = await bf.importBookFromBytes(epub, '测试漫画.epub');
const book = await db.getBook(saved.id);
check('书本标记为漫画', book.kind === 'comic', book.kind);
check('书名正确', book.title === '测试漫画', book.title);
check('记录总页数', book.totalPages === 4, String(book.totalPages));
check('话数 = 2', book.totalChapters === 2, String(book.totalChapters));

const toc = await db.getToc(book.id);
check('目录 2 话', toc?.length === 2, JSON.stringify(toc));

const ch0 = await db.getChapter(book.id, 0);
check('第一话存了 2 张图', ch0?.images?.length === 2, String(ch0?.images?.length));
check('图片字节非空', ch0?.images?.[0]?.bytes?.length > 50, String(ch0?.images?.[0]?.bytes?.length));
check('图片 mime', ch0?.images?.[0]?.mime === 'image/png', ch0?.images?.[0]?.mime);
check('没有多余的段落字段', !ch0?.paragraphs?.length);

const images = (await db.getChapter(book.id, 0))?.images || [];
check('本地书直接读章节图片', images.length === 2);

console.log('== 同文件重复导入不新增书 ==');
const before = (await db.getBooks()).length;
const again = await bf.importBookFromBytes(epub, '测试漫画.epub');
const after = (await db.getBooks()).length;
check('不会产生第二本', after === before, `${before} → ${after}`);
check('返回同一条记录', again.id === saved.id || (await db.getBooks()).some((b) => b.id === again.id));

console.log('== 导入 CBZ ==');
const cbz = zipSync({ '001.png': PNG, '002.png': PNG, '003.png': PNG });
const saved2 = await bf.importBookFromBytes(cbz, '短篇集.cbz');
const book2 = await db.getBook(saved2.id);
check('CBZ 也是漫画', book2?.kind === 'comic', book2?.kind);
check('CBZ 书名取文件名', book2?.title === '短篇集', book2?.title);
const ch2 = await db.getChapter(saved2.id, 0);
check('CBZ 页数', ch2?.images?.length === 3, String(ch2?.images?.length));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
