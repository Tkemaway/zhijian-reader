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
check('第一话有 2 页元信息', ch0?.pages?.length === 2, String(ch0?.pages?.length));
check('章节记录不再塞图片字节', !ch0?.images, JSON.stringify(Object.keys(ch0 || {})));
check('页元信息带宽高', ch0?.pages?.[0]?.w === 1 && ch0?.pages?.[0]?.h === 1, JSON.stringify(ch0?.pages?.[0]));
const page0 = await db.getComicPage(book.id, 0, 0);
check('页字节单独存且非空', page0?.bytes?.length > 50, String(page0?.bytes?.length));
check('页 mime', page0?.mime === 'image/png', page0?.mime);
check('页记录带页码', page0?.pageIdx === 0 && page0?.chapterIdx === 0);
check('没有多余的段落字段', !ch0?.paragraphs?.length);

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
check('CBZ 页数', ch2?.pages?.length === 3, String(ch2?.pages?.length));
check('CBZ 页字节可读', (await db.getComicPage(saved2.id, 0, 2))?.bytes?.length > 50);

await db.deleteBook(saved2.id, { releaseFile: true });
check('删书后页字节一并清理', (await db.getComicPage(saved2.id, 0, 0)) == null);

console.log('== 旧版「整话图片」数据仍可读（兼容） ==');
{
	await db.addBook({ id: 'legacy_comic', title: '旧漫画', author: '', sourceId: 'local', kind: 'comic', totalChapters: 1, addedAt: Date.now() });
	await db.saveChapters('legacy_comic', [{ idx: 0, title: '第1话', images: [{ bytes: PNG, mime: 'image/png' }] }]);
	const ch = await db.getChapter('legacy_comic', 0);
	check('旧数据仍返回 images', ch?.images?.length === 1, JSON.stringify(Object.keys(ch || {})));
	check('旧数据没有 pages 元信息', !ch?.pages);

	// 迁移后章节变成元信息 + 按页记录
	await bf.saveParsedChapters('legacy_comic', { kind: 'comic', chapters: [{ title: '第1话', images: [{ bytes: PNG, mime: 'image/png', w: 1, h: 1 }] }] });
	const migrated = await db.getChapter('legacy_comic', 0);
	check('迁移后只留页元信息', migrated?.pages?.length === 1 && !migrated?.images, JSON.stringify(Object.keys(migrated || {})));
	check('迁移后页字节可读', (await db.getComicPage('legacy_comic', 0, 0))?.bytes?.length > 50);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
