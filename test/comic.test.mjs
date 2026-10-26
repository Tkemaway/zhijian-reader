/**
 * 漫画解析回归：EPUB / CBZ / 自动分派 / 书源取图
 *
 * 重点是「分话」——不同 EPUB 结构（每话一个目录 vs 所有图一个目录）
 * 必须分得开，否则要么一话几千页，要么一话只有一页。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';
import { zipSync, strToU8 } from 'fflate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = (p) => pathToFileURL(path.join(__dirname, '..', 'src', p)).href;
const comic = await import(id('core/comic-book.js'));
const { parseBookFile } = await import(id('core/importer.js'));
const { collectComicImages, detectBlockPage } = await import(id('core/engine.js'));
const { buildEpubFromChapters } = await import(id('core/epub-build.js'));
const { parseSearchUrl } = await import(id('core/legado.js'));
const { parseToc } = await import(id('core/source-legado.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

// 1x1 PNG
const PNG = Uint8Array.from(Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
));

/** 拼一本漫画 EPUB：images 为相对 OEBPS 的图片路径数组 */
function buildComicEpub({ title = '测试漫画', author = '作者', images, wrapXhtml = true }) {
	const files = {
		mimetype: [strToU8('application/epub+zip'), { level: 0 }],
		'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
	<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
	};

	const manifest = [];
	const spine = [];
	images.forEach((p, i) => {
		files[`OEBPS/${p}`] = PNG;
		manifest.push(`<item id="img${i}" href="${p}" media-type="image/png"/>`);
		if (wrapXhtml) {
			const page = `text/p${i}.xhtml`;
			files[`OEBPS/${page}`] = strToU8(`<html><head><title>第${i + 1}页</title></head><body><img src="../${p}" alt="page${i + 1}"/></body></html>`);
			manifest.push(`<item id="p${i}" href="${page}" media-type="application/xhtml+xml"/>`);
			spine.push(`<itemref idref="p${i}"/>`);
		}
	});
	// 封面/logo 这类装饰图不应被当成正文页
	files['OEBPS/images/logo.png'] = PNG;

	files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
	<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
		<dc:title>${title}</dc:title>
		<dc:creator>${author}</dc:creator>
	</metadata>
	<manifest>${manifest.join('')}</manifest>
	<spine>${spine.join('')}</spine>
</package>`);

	return zipSync(files);
}

console.log('== 漫画 EPUB：每页一个 XHTML ==');
const flatImages = Array.from({ length: 25 }, (_, i) => `images/${String(i + 1).padStart(3, '0')}.png`);
const epub = buildComicEpub({ images: flatImages });
const parsed = comic.parseComicEpub(epub, DOMParser);
check('识别为漫画', parsed.kind === 'comic', parsed.kind);
check('书名解析', parsed.title === '测试漫画', parsed.title);
check('作者解析', parsed.author === '作者', parsed.author);
check('25 页按 20 页切成 2 话', parsed.chapters.length === 2, String(parsed.chapters.length));
check('第一话 20 页', parsed.chapters[0].images.length === 20, String(parsed.chapters[0].images.length));
check('第二话 5 页', parsed.chapters[1].images.length === 5, String(parsed.chapters[1].images.length));
check('图片带 mime', parsed.chapters[0].images[0].mime === 'image/png', parsed.chapters[0].images[0].mime);
check('章节有标题', /第 \d+ 话/.test(parsed.chapters[0].title), parsed.chapters[0].title);

console.log('== 漫画 EPUB：每话一个目录 ==');
const dirImages = [
	'第1话/001.png', '第1话/002.png',
	'第2话/001.png', '第2话/002.png', '第2话/003.png'
];
const epub2 = buildComicEpub({ title: '分话测试', images: dirImages });
const parsed2 = comic.parseComicEpub(epub2, DOMParser);
check('按目录分成 2 话', parsed2.chapters.length === 2, String(parsed2.chapters.length));
check('话名取目录名', parsed2.chapters[0].title === '第1话' && parsed2.chapters[1].title === '第2话', JSON.stringify(parsed2.chapters.map((c) => c.title)));
check('页数对应', parsed2.chapters[0].images.length === 2 && parsed2.chapters[1].images.length === 3);

console.log('== 漫画 EPUB：spine 里直接放图片（无 XHTML 包装） ==');
const direct = buildComicEpub({ images: flatImages.slice(0, 4), wrapXhtml: false });
const parsed3 = comic.parseComicEpub(direct, DOMParser);
check('直接图片也能解析', parsed3.chapters.reduce((n, c) => n + c.images.length, 0) === 4);

console.log('== 顺序按 spine，不按文件名 ==');
const ordered = zipSync({
	mimetype: [strToU8('application/epub+zip'), { level: 0 }],
	'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
	'OEBPS/content.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>顺序测试</dc:title></metadata>
	<manifest>
		<item id="p1" href="text/b.xhtml" media-type="application/xhtml+xml"/>
		<item id="p2" href="text/a.xhtml" media-type="application/xhtml+xml"/>
		<item id="p3" href="text/z.xhtml" media-type="application/xhtml+xml"/>
	</manifest>
	<spine><itemref idref="p1"/><itemref idref="p2"/><itemref idref="p3"/></spine></package>`),
	'OEBPS/text/b.xhtml': strToU8('<html><body><img src="../pics/b.png"/></body></html>'),
	'OEBPS/text/a.xhtml': strToU8('<html><body><img src="../pics/a.png"/></body></html>'),
	'OEBPS/text/z.xhtml': strToU8('<html><body><img src="../pics/z-only.png"/></body></html>'),
	'OEBPS/pics/a.png': Uint8Array.from([1, 1, 1]),
	'OEBPS/pics/b.png': Uint8Array.from([2, 2, 2]),
	// 只被 XHTML 引用、不在 manifest 里：验证按页面路径解析而不是清单兜底
	'OEBPS/pics/z-only.png': Uint8Array.from([3, 3, 3])
});
const parsedOrder = comic.parseComicEpub(ordered, DOMParser);
const firstBytes = parsedOrder.chapters[0].images.map((im) => im.bytes[0]);
check('三页都在（含 manifest 外的图）', parsedOrder.chapters[0].images.length === 3, String(parsedOrder.chapters[0].images.length));
check('顺序 = spine 顺序（b→a→z）', firstBytes.join(',') === '2,1,3', firstBytes.join(','));

console.log('== CBZ ==');
const cbz = zipSync({
	'001.png': PNG,
	'002.png': PNG,
	'003.png': PNG,
	'__MACOSX/._001.png': PNG,
	'cover.jpg': PNG
});
const parsedCbz = comic.parseCbz(cbz, '海贼王 第1卷.cbz');
check('CBZ 识别为漫画', parsedCbz.kind === 'comic');
check('书名取文件名', parsedCbz.title === '海贼王 第1卷', parsedCbz.title);
check('过滤 macOS 垃圾文件', parsedCbz.chapters[0].images.length === 4, String(parsedCbz.chapters[0].images.length));

console.log('== 文字书不会被误判成漫画 ==');
const textEpub = buildEpubFromChapters({
	title: '普通小说', author: '作者', id: 't1',
	chapters: [
		{ title: '第一章', paragraphs: ['这是一段正常的小说正文。'.repeat(30)] },
		{ title: '第二章', paragraphs: ['第二章也有很多字。'.repeat(30)] }
	]
});
check('图片 EPUB 判为漫画', comic.isComicEpub(epub, DOMParser) === true);
check('文字 EPUB 不判为漫画', comic.isComicEpub(textEpub, DOMParser) === false);
const parsedText = parseBookFile(textEpub, '小说.epub', DOMParser);
check('分派后仍是文字书', parsedText.kind === 'text', parsedText.kind);
check('正文完整', parsedText.chapters[0].paragraphs.length > 0);

console.log('== parseBookFile 自动分派 ==');
const autoComic = parseBookFile(epub, 'comic.epub', DOMParser);
check('图片 EPUB → 漫画', autoComic.kind === 'comic', autoComic.kind);
const autoTxt = parseBookFile(new TextEncoder().encode('第一章 开始\n正文内容').buffer, 'a.txt', DOMParser);
check('TXT → 文字书', autoTxt.kind === 'text', autoTxt.kind);
const autoCbz = parseBookFile(cbz, 'a.cbz', DOMParser);
check('CBZ → 漫画', autoCbz.kind === 'comic');

console.log('== 书源取图过滤 ==');
const html = `
<html><body>
	<div class="header"><img src="/static/logo.png" alt="logo"></div>
	<div id="content">
		<img src="/img/loading.gif" data-original="/comic/001.jpg">
		<img data-src="/comic/002.jpg">
		<img src="/comic/003.jpg" width="40" height="40">
		<img src="/comic/004.jpg" alt="第4页">
		<img src="/comic/001.jpg">
	</div>
	<div class="share"><img src="/comic/qrcode.png"></div>
</body></html>`;
const urls = collectComicImages(html, 'https://example.com/chapter/1.html', {}, DOMParser);
check('懒加载属性优先', urls.includes('https://example.com/comic/001.jpg'), JSON.stringify(urls));
check('过滤 logo/占位图/二维码', !urls.some((u) => /logo|loading|qrcode/.test(u)), JSON.stringify(urls));
check('过滤 40x40 小图', !urls.includes('https://example.com/comic/003.jpg'), JSON.stringify(urls));
check('去重', urls.filter((u) => u.endsWith('/001.jpg')).length === 1, JSON.stringify(urls));
check('保留正常页', urls.includes('https://example.com/comic/002.jpg') && urls.includes('https://example.com/comic/004.jpg'), JSON.stringify(urls));

console.log('== 自定义书源（Legado JSON）==');
const cs = await import(id('core/custom-sources.js'));
const rawSource = {
	bookSourceName: '某漫画站',
	bookSourceUrl: 'https://example.com',
	bookSourceType: 2,
	searchUrl: '/search?q={{key}}',
	ruleSearch: { bookList: '.book-item', name: 'tag.a.0@text', bookUrl: 'tag.a.0@href' },
	ruleToc: { chapterList: '.chapter-list a', chapterName: 'text', chapterUrl: 'href' },
	ruleContent: { content: '#images' }
};
const norm = cs.normalizeCustomSource(rawSource);
check('bookSourceType=2 → 漫画', norm?.kind === 'comic', norm?.kind);
check('保留内容规则', norm?.ruleContent?.content === '#images', JSON.stringify(norm?.ruleContent));
check('缺 toc/content 的源被拒', cs.normalizeCustomSource({ bookSourceName: 'x', bookSourceUrl: 'https://a.com' }) === null);
const parsedInput = cs.parseSourceInput(JSON.stringify([rawSource]));
check('支持数组格式', parsedInput.list.length === 1 && !parsedInput.error, parsedInput.error);
check('非法 JSON 给提示', !!cs.parseSourceInput('{bad json').error);

console.log('== 站点书源的常见写法兼容 ==');
// yckceo 的源常把提示写在 <js> 里，真地址在后面
const su = parseSearchUrl('<js>java.toast("请先通过验证");</js>/page/{{page}}/?s={{key}}&post_type=wp-manga', '海贼王', { baseUrl: 'https://baka3.cfd' });
check('<js> 前缀被剥离', su?.url === 'https://baka3.cfd/page/1/?s=%E6%B5%B7%E8%B4%BC%E7%8E%8B&post_type=wp-manga', su?.url);

// 目录规则是 @js:java.getElements('selector') 且倒序
const jsSource = {
	url: 'https://example.com',
	ruleToc: {
		chapterList: "@js:var items=java.getElements('#list li.ch');var arr=[];for(var i=items.size()-1;i>=0;i--){arr.push(items.get(i));}arr",
		chapterName: 'a@text',
		chapterUrl: 'a@href'
	}
};
const tocHtml = '<html><body><ul id="list"><li class="ch"><a href="/c1">第1话</a></li><li class="ch"><a href="/c2">第2话</a></li></ul></body></html>';
const tocRows = parseToc(tocHtml, 'https://example.com/m/1/', jsSource, DOMParser);
check('脚本目录按选择器取到', tocRows.length === 2, JSON.stringify(tocRows));
check('倒序规则生效', tocRows[0]?.title === '第2话', JSON.stringify(tocRows));

// 失败提示要指出具体缺哪个字段
const badInput = cs.parseSourceInput('[{"bookSourceName":"只有名字"}]');
check('缺字段提示具体', /bookSourceUrl/.test(badInput.error), badInput.error);
const realSource = cs.parseSourceInput(JSON.stringify([{
	bookSourceName: '脚本漫画源',
	bookSourceUrl: 'https://example.com',
	bookSourceType: 2,
	searchUrl: '<js>java.toast("x")</js>/s?q={{key}}',
	ruleSearch: { bookList: '.item' },
	ruleToc: { chapterList: '@js:java.getElements(".ch")' },
	ruleContent: { content: '.reader' }
}]));
check('标记含脚本规则的源', realSource.list[0]?.scripted === true);
check('识别 Cloudflare 拦截页', /人机验证/.test(detectBlockPage('<html><title>Just a moment...</title></html>')));
check('普通页面不误判', detectBlockPage('<html><title>漫画首页</title></html>') === '');

console.log('== 图片尺寸（用于占位高度）==');
{
	const png = Uint8Array.from(Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
		'base64'
	));
	const pngSize = comic.imageSize(png);
	check('PNG 1x1', pngSize.w === 1 && pngSize.h === 1, JSON.stringify(pngSize));
	const jpeg = Uint8Array.from([0xFF,0xD8,0xFF,0xC0,0x00,0x11,0x08,0x00,0x02,0x00,0x03,0x03,0x01,0x22,0x00,0x02,0x11,0x01,0x03,0x11,0x01,0xFF,0xD9,0x00]);
	const jpegSize = comic.imageSize(jpeg);
	check('JPEG 3x2（SOF0）', jpegSize.w === 3 && jpegSize.h === 2, JSON.stringify(jpegSize));
	check('解析结果带 w/h', parsed.chapters[0].images[0].w === 1 && parsed.chapters[0].images[0].h === 1, JSON.stringify(Object.keys(parsed.chapters[0].images[0])));
	check('无法识别时返回 0', comic.imageSize(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25])).w === 0);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
