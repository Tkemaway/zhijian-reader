/** 本地下载器：页面扫描、章节识别、文件名清洗 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = (p) => pathToFileURL(path.join(__dirname, '..', p)).href;
const { scanHtml, findChapterLinks, findNextLink, pickTitle, sanitizeSegment } = await import(id('tools/comic-downloader/scan.mjs'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

console.log('== 文件名清洗 ==');
check('去掉 Windows 非法字符', sanitizeSegment('第1话: 海贼/王?') === '第1话 海贼 王', sanitizeSegment('第1话: 海贼/王?'));
check('空名兜底', sanitizeSegment('   ') === '未命名');
check('截断过长', sanitizeSegment('长'.repeat(200), 20).length === 20);

console.log('== 标题 ==');
const titleHtml = '<html><head><title>站点名 - 海贼王</title></head><body><h1>海贼王</h1></body></html>';
check('优先 h1', pickTitle(new DOMParser().parseFromString(titleHtml, 'text/html')) === '海贼王');

console.log('== 章节识别 ==');
const html = `<html><head><title>某漫画</title></head><body>
	<h1>测试漫画</h1>
	<div class="header"><a href="/">首页</a><a href="/rank">排行榜</a></div>
	<ul class="chapters">
		<li><a href="/c3">第3话</a></li>
		<li><a href="/c2">第2话</a></li>
		<li><a href="/c1">第1话</a></li>
	</ul>
	<a href="https://other.com/c9">第9话</a>
	<a href="/c3" class="next">下一话</a>
	<div id="content">
		<img src="/img/logo.png" alt="logo">
		<img data-src="/img/001.jpg" alt="第1页">
		<img data-src="/img/002.jpg" alt="第2页">
		<img data-src="/img/003.jpg" alt="第3页">
	</div>
</body></html>`;

const doc = new DOMParser().parseFromString(html, 'text/html');
const chapters = findChapterLinks(doc, 'https://example.com/book/1/');
check('只认同源章节链接', chapters.length === 3, JSON.stringify(chapters));
check('倒序目录会被翻正', chapters.map((c) => c.title).join(',') === '第1话,第2话,第3话', JSON.stringify(chapters.map((c) => c.title)));
check('链接绝对化', chapters[0].url === 'https://example.com/c1', chapters[0].url);
check('下一话链接', findNextLink(doc, 'https://example.com/book/1/') === 'https://example.com/c3');

console.log('== 整页扫描 ==');
const scanned = scanHtml(html, 'https://example.com/book/1/', DOMParser);
check('标题取 h1', scanned.title === '测试漫画', scanned.title);
check('图片 3 张（过滤 logo）', scanned.images.length === 3, JSON.stringify(scanned.images));
check('图片绝对化', scanned.images[0] === 'https://example.com/img/001.jpg', scanned.images[0]);
check('返回章节与下一话', scanned.chapters.length === 3 && !!scanned.nextUrl);

const blank = scanHtml('<html><body><p>没有图片</p></body></html>', 'https://example.com/a', DOMParser);
check('空白页不报错', blank.images.length === 0 && blank.chapters.length === 0);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
