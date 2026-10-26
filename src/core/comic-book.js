/**
 * 漫画文件解析 —— EPUB / CBZ
 *
 * 与文字书不同，漫画的一「话」是一串图片，没有段落。
 * 解析结果统一为：
 *   { kind:'comic', title, author, chapters:[{ title, images:[{ mime, bytes }] }] }
 *
 * 分话规则（EPUB 结构差异很大，按可靠度依次降级）：
 *   1. 图片分散在多个目录（每话一个文件夹）→ 一个目录 = 一话，目录名当标题
 *   2. 只有单一目录（常见：所有图都塞在 images/）→ 按每 20 页切一话
 *   3. 单话页数超过 40 → 再切成多话，避免一话几百页滚不到头
 *
 * images 里存的是解压后的原始字节，由调用方决定写库还是转 Blob——
 * 这样解析逻辑与浏览器/IndexedDB 解耦，Node 里可以直接测。
 */
import { unzipSync, strFromU8 } from 'fflate';
import { cleanMetaText } from './text-clean.js';

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const MIME_BY_EXT = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	avif: 'image/avif',
	bmp: 'image/bmp'
};

/** 单话默认页数 / 单话最大页数（超出继续切分） */
const PAGES_PER_CHAPTER = 20;
const MAX_PAGES_PER_CHAPTER = 40;
/** 安全阈值：防止误导入超大文件把内存打满 */
const MAX_TOTAL_IMAGES = 4000;
const MAX_TOTAL_BYTES = 320 * 1024 * 1024;

/** 这些目录名是「容器」而不是章节名 */
const GENERIC_DIRS = new Set([
	'images', 'image', 'img', 'imgs', 'picture', 'pictures', 'pic', 'pics',
	'photos', 'photo', 'oebps', 'content', 'contents', 'text', 'texts',
	'comic', 'comics', 'manga', 'chapter', 'chapters', 'page', 'pages',
	'resource', 'resources', 'assets', 'files', 'book', 'books'
]);

export function mimeOfPath(path) {
	const m = String(path || '').match(/\.([a-z0-9]+)$/i);
	if (!m) return '';
	return MIME_BY_EXT[m[1].toLowerCase()] || '';
}

export function isImagePath(path) {
	return IMAGE_EXT_RE.test(String(path || ''));
}

/** 自然排序：第2页排在 第10页 前面 */
export function naturalCompare(a, b) {
	const re = /(\d+)|(\D+)/g;
	const ax = String(a).toLowerCase().match(re) || [];
	const bx = String(b).toLowerCase().match(re) || [];
	const len = Math.min(ax.length, bx.length);
	for (let i = 0; i < len; i++) {
		const an = /^\d+$/.test(ax[i]);
		const bn = /^\d+$/.test(bx[i]);
		if (an && bn) {
			const d = parseInt(ax[i], 10) - parseInt(bx[i], 10);
			if (d) return d;
		} else if (ax[i] !== bx[i]) {
			return ax[i] < bx[i] ? -1 : 1;
		}
	}
	return ax.length - bx.length;
}

function dirOf(path) {
	const i = path.lastIndexOf('/');
	return i === -1 ? '' : path.slice(0, i);
}

function baseName(path) {
	const i = path.lastIndexOf('/');
	return i === -1 ? path : path.slice(i + 1);
}

/** 目录名能不能当话名（images/、OEBPS/ 这类容器名不行） */
function usableDirName(dir) {
	const name = decodeURIComponent(dir.split('/').pop() || '').replace(/[_-]+/g, ' ').trim();
	if (!name) return '';
	if (GENERIC_DIRS.has(name.toLowerCase())) return '';
	if (/^[0-9a-f]{8,}$/i.test(name)) return '';
	if (!/[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{1,}/.test(name)) return '';
	return cleanMetaText(name).slice(0, 40);
}

/** 把按顺序排列的页面切成话 */
function groupPages(pages) {
	const dirs = [...new Set(pages.map((p) => p.dir))];
	let groups;
	if (dirs.length > 1) {
		groups = dirs
			.map((dir) => ({ dir, pages: pages.filter((p) => p.dir === dir) }))
			.filter((g) => g.pages.length);
	} else {
		groups = [{ dir: dirs[0] || '', pages }];
	}

	const out = [];
	for (const g of groups) {
		const dirTitle = usableDirName(g.dir || '');
		const chunks = [];
		for (let i = 0; i < g.pages.length; i += PAGES_PER_CHAPTER) {
			chunks.push(g.pages.slice(i, i + PAGES_PER_CHAPTER));
		}
		// 单话太长（一整卷塞一个目录）→ 再切，保证每话不超过 40 页
		const split = [];
		for (const chunk of chunks) {
			if (chunk.length <= MAX_PAGES_PER_CHAPTER) {
				split.push(chunk);
				continue;
			}
			for (let i = 0; i < chunk.length; i += MAX_PAGES_PER_CHAPTER) {
				split.push(chunk.slice(i, i + MAX_PAGES_PER_CHAPTER));
			}
		}
		split.forEach((chunk, i) => {
			out.push({
				title: dirTitle && split.length === 1 ? dirTitle : '',
				pages: chunk
			});
		});
	}

	out.forEach((ch, i) => {
		if (!ch.title) ch.title = `第 ${i + 1} 话`;
	});
	return out;
}

function toChapters(groups, files) {
	const chapters = [];
	let totalBytes = 0;
	let totalImages = 0;
	for (const g of groups) {
		const images = [];
		for (const p of g.pages) {
			const bytes = files[p.path];
			if (!bytes || !bytes.length) continue;
			totalBytes += bytes.length;
			totalImages++;
			if (totalImages > MAX_TOTAL_IMAGES) {
				throw new Error(`图片数量过多（超过 ${MAX_TOTAL_IMAGES} 页），请在电脑上先分卷再导入`);
			}
			if (totalBytes > MAX_TOTAL_BYTES) {
				throw new Error('文件体积过大（超过 320MB），请先分卷再导入');
			}
			images.push({ mime: p.mime || mimeOfPath(p.path) || 'image/jpeg', bytes });
		}
		if (images.length) chapters.push({ title: g.title, images });
	}
	return chapters;
}

/** 从 OPF 读书名/作者/清单/spine */
function readOpf(files, DOMParserImpl) {
	const decode = (path) => {
		const f = files[path];
		return f ? strFromU8(f) : '';
	};
	let opfPath = '';
	const container = decode('META-INF/container.xml');
	const m = container.match(/full-path="([^"]+)"/);
	if (m) opfPath = m[1];
	if (!opfPath) opfPath = Object.keys(files).find((k) => k.toLowerCase().endsWith('.opf')) || '';
	if (!opfPath) throw new Error('不是有效的 EPUB（缺少 OPF）');

	const opf = decode(opfPath);
	const doc = new DOMParserImpl().parseFromString(opf, 'text/xml');
	const grab = (re) => ((opf.match(re) || [])[1] || '').trim();
	const stripTags = (v) => String(v || '').replace(/<[^>]*>/g, '');
	const title = cleanMetaText(stripTags(grab(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || doc.querySelector('title')?.textContent || ''));
	const author = cleanMetaText(stripTags(grab(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || doc.querySelector('creator')?.textContent || ''));

	const manifest = new Map();
	for (const item of doc.querySelectorAll('manifest > item')) {
		const id = item.getAttribute('id');
		const href = item.getAttribute('href');
		if (!id || !href) continue;
		manifest.set(id, { href, type: item.getAttribute('media-type') || '' });
	}

	/**
	 * 解析相对路径。
	 * 注意 fromPath：manifest 的 href 相对 OPF 所在目录，
	 * 而 XHTML 里的 <img src> 相对**那一页 XHTML**所在目录——
	 * 混用会把 `text/../images/1.png` 算成 `images/1.png`，整本图都找不到。
	 */
	const resolve = (href, fromPath = opfPath) => {
		const raw = String(href || '').split('#')[0].split('?')[0];
		if (!raw) return '';
		if (/^https?:/i.test(raw)) return '';
		const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : '';
		const parts = (raw.startsWith('/') ? raw.slice(1) : fromDir + raw).split('/');
		const out = [];
		for (const p of parts) {
			if (p === '..') out.pop();
			else if (p !== '.' && p !== '') out.push(p);
		}
		return out.join('/');
	};

	const spineEls = [...doc.querySelectorAll('spine > itemref')];
	const spine = spineEls.length ? spineEls.map((el) => el.getAttribute('idref')) : [...manifest.keys()];

	return { title, author, manifest, spine, resolve };
}

/**
 * 解析漫画 EPUB
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {Function} DOMParserImpl
 */
export function parseComicEpub(buffer, DOMParserImpl, preloadedFiles = null) {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	const files = preloadedFiles || unzipSync(bytes);
	const { title, author, manifest, spine, resolve } = readOpf(files, DOMParserImpl);

	const pages = [];
	const seen = new Set();
	const pushPage = (path, mime) => {
		if (!path || seen.has(path)) return;
		if (!files[path]) return;
		seen.add(path);
		pages.push({ path, dir: dirOf(path), mime: mime || mimeOfPath(path) });
	};

	for (const idref of spine) {
		const item = manifest.get(idref);
		if (!item) continue;
		const path = resolve(item.href);
		if (!path) continue;
		if (/^image\//i.test(item.type) || isImagePath(path)) {
			pushPage(path, item.type);
			continue;
		}
		// XHTML 包一层 <img>：从页面里取图片地址（漫画 EPUB 的常见形态）
		if (!/html|xml/i.test(item.type) && !/\.(x?html?|xml)$/i.test(path)) continue;
		const html = files[path] ? strFromU8(files[path]) : '';
		if (!html) continue;
		const doc = new DOMParserImpl().parseFromString(html, 'text/html');
		doc.querySelectorAll('script,style,nav').forEach((el) => el.remove());
		for (const img of doc.querySelectorAll('img,image')) {
			const raw = img.getAttribute('src')
				|| img.getAttribute('xlink:href')
				|| img.getAttribute('data-src')
				|| img.getAttribute('href');
			const abs = resolve(raw || '', path);
			if (abs && isImagePath(abs)) pushPage(abs);
		}
	}

	// spine 里没有图片（有些 EPUB 只把图放 manifest）→ 用清单里的图片兜底
	if (!pages.length) {
		const imgs = [...manifest.values()]
			.filter((it) => /^image\//i.test(it.type) || isImagePath(resolve(it.href)))
			.map((it) => resolve(it.href))
			.filter(Boolean)
			.sort(naturalCompare);
		imgs.forEach((p) => pushPage(p));
	}

	if (!pages.length) throw new Error('这本 EPUB 里没有图片');

	const groups = groupPages(pages);
	const chapters = toChapters(groups, files);
	if (!chapters.length) throw new Error('漫画图片解析失败');
	return { kind: 'comic', title: title || '', author, chapters };
}

/**
 * 解析 CBZ（漫画 ZIP：里面就是按顺序排好的图片）
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} filename 用来取书名
 */
export function parseCbz(buffer, filename = '') {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	const files = unzipSync(bytes);
	const pages = Object.keys(files)
		.filter((p) => isImagePath(p) && !/(^|\/)__MACOSX\//.test(p) && !/(^|\/)\._/.test(p))
		.sort(naturalCompare)
		.map((p) => ({ path: p, dir: dirOf(p), mime: mimeOfPath(p) }));
	if (!pages.length) throw new Error('压缩包里没有图片');
	const groups = groupPages(pages);
	const chapters = toChapters(groups, files);
	if (!chapters.length) throw new Error('漫画图片解析失败');
	return {
		kind: 'comic',
		title: cleanMetaText(String(filename || '').replace(/\.[^.]+$/, '')) || '',
		author: '',
		chapters
	};
}

/** 是否是漫画容器（按扩展名/魔数） */
export function looksLikeComicFile(filename, buffer) {
	if (/\.(cbz|cbr)$/i.test(String(filename || ''))) return true;
	if (/\.(epub|zip)$/i.test(String(filename || ''))) return false; // EPUB 由调用方先试文字解析
	return false;
}

/** 统计一本漫画的页数与字节数（导入提示 / 书架展示用） */
export function comicStats(parsed) {
	let pages = 0;
	let bytes = 0;
	for (const ch of parsed.chapters || []) {
		for (const img of ch.images || []) {
			pages++;
			bytes += img.bytes?.length || 0;
		}
	}
	return { pages, bytes, chapters: parsed.chapters?.length || 0 };
}

/**
 * 判断一本 EPUB 是不是漫画。
 *
 * 不能只看「有没有图片」：大量小说带插图。可靠的信号是
 * **整页都是图、几乎没有文字**的页面数量是否占多数。
 * 导入时先跑这个判断，命中就直接走漫画解析，避免
 * 「封面页有一行字 → 被当文字书 → 只解析出一章封面」。
 */
export function isComicEpub(buffer, DOMParserImpl) {
	return inspectEpub(buffer, DOMParserImpl).isComic;
}

/**
 * 一次解压，同时给出「是不是漫画」和文件表。
 * 导入流程用这个：漫画只需解压一次（300MB 的包解压两次很容易 OOM）。
 * @returns {{ files: object|null, isComic: boolean }}
 */
export function inspectEpub(buffer, DOMParserImpl) {
	try {
		const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
		const files = unzipSync(bytes);
		const { manifest, spine, resolve } = readOpf(files, DOMParserImpl);
		let imagePages = 0;
		let textPages = 0;

		for (const idref of spine) {
			const item = manifest.get(idref);
			if (!item) continue;
			const path = resolve(item.href);
			if (!path || !files[path]) continue;
			if (/^image\//i.test(item.type) || isImagePath(path)) {
				imagePages++;
				continue;
			}
			if (!/html|xml/i.test(item.type) && !/\.(x?html?|xml)$/i.test(path)) continue;
			const html = strFromU8(files[path]);
			const doc = new DOMParserImpl().parseFromString(html, 'text/html');
			doc.querySelectorAll('script,style,nav').forEach((el) => el.remove());
			const text = (doc.body?.textContent || '').replace(/\s+/g, '');
			const imgs = doc.querySelectorAll('img,image').length;
			if (imgs && text.length < 120) imagePages++;
			else if (text.length >= 200) textPages++;
		}

		return { files, isComic: imagePages >= 2 && imagePages > textPages };
	} catch {
		return { files: null, isComic: false };
	}
}
