/** 缓存章节 → EPUB → 再解析：往返一致性 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = (p) => pathToFileURL(path.join(__dirname, '..', 'src', p)).href;
const { buildEpubFromChapters, epubFileName } = await import(id('core/epub-build.js'));
const { parseEpub } = await import(id('core/importer.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

const chapters = [
	{ title: '第一章 初入江湖', paragraphs: ['山雨欲来。', '他握紧了剑。'] },
	{ title: '第二章 风起', paragraphs: ['风从北边来。'] }
];
const bytes = buildEpubFromChapters({ title: '测试之书', author: '某作者', id: 'b1', chapters });
check('产出 EPUB 字节', bytes.length > 500, String(bytes.length));

const parsed = parseEpub(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), DOMParser);
check('书名往返一致', parsed.title === '测试之书', parsed.title);
check('作者往返一致', parsed.author === '某作者', parsed.author);
check('章节数一致', parsed.chapters.length === 2, String(parsed.chapters.length));
check('章节标题一致', parsed.chapters[0].title === '第一章 初入江湖', parsed.chapters[0].title);
check('正文一致', parsed.chapters[0].paragraphs.join('|') === '山雨欲来。|他握紧了剑。', JSON.stringify(parsed.chapters[0].paragraphs));
check('文件名安全', epubFileName('龙族Ⅴ·悼亡者的归来') === '龙族Ⅴ·悼亡者的归来.epub', epubFileName('龙族Ⅴ·悼亡者的归来'));
check('非法字符替换', epubFileName('a/b:c*d') === 'a_b_c_d.epub', epubFileName('a/b:c*d'));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
