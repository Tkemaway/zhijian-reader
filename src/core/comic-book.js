/**
 * 漫画文件解析 —— EPUB / CBZ
 *
 * 与文字书不同，漫画的一「话」是一串图片，没有段落。
 * 解析结果统一为：
 *   { kind:'comic', title, author, chapters:[{ title, images:[{ mime, bytes, w, h }] }] }
 *
 * w/h 是从图片头里读出来的像素尺寸（不解码）。阅读器用它给未加载的页
 * 预留正确高度：既不会「滚动条乱跳」，也不必为了恢复位置把前面所有图
 * 都加载出来（那是长章节卡顿/闪退的主因）。
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

/**
 * 从图片字节头里读出像素尺寸，不解码、不占额外内存。
 * 支持 JPEG / PNG / GIF / WebP / BMP（漫画里 99% 是前两种）。
 * 读不出来返回 { w: 0, h: 0 }，阅读器会退回默认竖版比例。
 */
export function imageSize(bytes) {
	const b = bytes;
	if (!b || b.length < 24) return { w: 0, h: 0 };
	const u16be = (o) => (b[o] << 8) | b[o + 1];
	const u16le = (o) => b[o] | (b[o + 1] << 8);
	const u32be = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
	const u32le = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
	const u24le = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

	// PNG：IHDR 宽高在 16/20
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return { w: u32be(16), h: u32be(20) };
	}
	// GIF：逻辑屏幕宽高（小端）
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
		return { w: u16le(6), h: u16le(8) };
	}
	// BMP
	if (b[0] === 0x42 && b[1] === 0x4d) {
		return { w: Math.abs(u32le(18) | 0) || u32le(18), h: Math.abs(u32le(22) | 0) || u32le(22) };
	}
	// WebP：RIFF....WEBP，三种子格式
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
		const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]);
		if (fmt === 'VP8X') return { w: 1 + u24le(24), h: 1 + u24le(27) };
		if (fmt === 'VP8 ') return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
		if (fmt === 'VP8L') {
			const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
			return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
		}
	}
	// JPEG：逐段找 SOFn（跳过 C4/C8/CC）
	if (b[0] === 0xff && b[1] === 0xd8) {
		let o = 2;
		while (o + 9 < b.length) {
			if (b[o] !== 0xff) { o++; continue; }
			const marker = b[o + 1];
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
			const len = u16be(o + 2);
			if (len < 2) break;
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { w: u16be(o + 7), h: u16be(o + 5) };
			}
			o += 2 + len;
		}
	}
	return { w: 0, h: 0 };
}

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
			const mime = p.mime || mimeOfPath(p.path) || 'image/jpeg';
			const dim = imageSize(bytes);
			images.push({ mime, bytes, w: dim.w, h: dim.h });
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
