import { cleanMetaText } from './text-clean.js';
import { parseComicEpub, parseCbz, inspectEpub } from './comic-book.js';
/**
 * 本地书籍导入 —— TXT / EPUB / CBZ 解析
 *
 * EPUB：ZIP → META-INF/container.xml → OPF（书名/作者/spine 顺序）→ 各章节 XHTML → 段落
 * TXT：编码检测（BOM / UTF-8 / GBK）→ 章节标题正则切分（无标题则按字数兜底切分）
 *
 * 纯解析模块：解压与 DOMParser 均由调用方提供（便于 Node 测试）。
 */
import { unzipSync, strFromU8 } from 'fflate';

const decoderCache = new Map();
function decodeWith(bytes, encoding) {
	try {
		let dec = decoderCache.get(encoding);
		if (!dec) {
			dec = new TextDecoder(encoding, { fatal: false });
			decoderCache.set(encoding, dec);
		}
		return dec.decode(bytes);
	} catch {
		return '';
	}
}

function replacementRatio(s) {
	if (!s.length) return 0;
	let bad = 0;
	for (const ch of s) if (ch === '\uFFFD') bad++;
	return bad / s.length;
}

/** 智能解码（BOM → UTF-8 → GBK） */
export function decodeTextSmart(bytes) {
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return decodeWith(bytes.subarray(2), 'utf-16le');
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeWith(bytes.subarray(2), 'utf-16be');
	const start = (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ? 3 : 0;
	const utf8 = decodeWith(bytes.subarray(start), 'utf-8');
	if (replacementRatio(utf8) < 0.005) return utf8;
	const gbk = decodeWith(bytes, 'gbk');
	if (gbk && replacementRatio(gbk) < replacementRatio(utf8)) return gbk;
	return utf8;
}

// ============================================================
//  EPUB
// ============================================================

/** 从 XHTML/HTML 提取段落（去脚本样式；p/div 直接文本） */
function extractParagraphs(html, DOMParserImpl) {
	const doc = new DOMParserImpl().parseFromString(html, 'text/html');
	doc.querySelectorAll('script,style,nav,header,footer').forEach((el) => el.remove());
	const root = doc.body || doc.documentElement;
	if (!root) return { title: '', paragraphs: [] };

	// 章节名：优先第一个 h1~h3
	let title = '';
	for (const h of root.querySelectorAll('h1,h2,h3,h4')) {
		const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
		if (t) { title = t; break; }
	}

	const paragraphs = [];
	for (const el of root.querySelectorAll('p,div')) {
		// 跳过含块级子元素的容器 div（避免文本重复）
		if (el.tagName === 'DIV' && el.querySelector('p,div')) continue;
		const t = (el.textContent || '').replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
		if (t) paragraphs.push(t);
	}
	// 兜底：如果没有任何 <p>/<div>，用 body 纯文本按行拆
	if (!paragraphs.length) {
		const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
		if (text) paragraphs.push(text);
	}
	return { title, paragraphs };
}

/**
 * 解析 EPUB
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {Function} DOMParserImpl DOMParser 构造器
 */
export function parseEpub(buffer, DOMParserImpl) {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	const files = unzipSync(bytes);

	const decode = (path) => {
		const f = files[path];
		if (!f) return '';
		return strFromU8(f);
	};

	// 1. container.xml → OPF 路径
	let opfPath = '';
	const container = decode('META-INF/container.xml');
	if (container) {
		const m = container.match(/full-path="([^"]+)"/);
		if (m) opfPath = m[1];
	}
	if (!opfPath) {
		// 兜底：找第一个 .opf
		opfPath = Object.keys(files).find((k) => k.toLowerCase().endsWith('.opf')) || '';
	}
	if (!opfPath) throw new Error('不是有效的 EPUB（缺少 OPF）');

	// 2. OPF：书名/作者/manifest/spine
	const opf = decode(opfPath);
	const parser = new DOMParserImpl();
	const opfDoc = parser.parseFromString(opf, 'text/xml');

	// 元数据用正则提取（跨解析器对 XML 命名空间的处理差异更稳）
	const grab = (re) => ((opf.match(re) || [])[1] || '').trim();
	// 书名/作者常带 HTML 实体（甚至双重转义）与内嵌标签，统一清洗后再用
	const stripTags = (v) => String(v || '').replace(/<[^>]*>/g, '');
	const title = cleanMetaText(stripTags(grab(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || opfDoc.querySelector('title')?.textContent || ''));
	const author = cleanMetaText(stripTags(grab(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || opfDoc.querySelector('creator')?.textContent || ''));

	const manifest = new Map();
	for (const item of opfDoc.querySelectorAll('manifest > item')) {
		const id = item.getAttribute('id');
		const href = item.getAttribute('href');
		const type = item.getAttribute('media-type') || '';
		if (id && href) manifest.set(id, { href, type });
	}
	const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

	const resolvePath = (href) => {
		const raw = href.split('#')[0];
		try {
			// 处理 ../ 等相对路径
			const parts = (baseDir + raw).split('/');
			const out = [];
			for (const p of parts) {
				if (p === '..') out.pop();
				else if (p !== '.' && p !== '') out.push(p);
			}
			return out.join('/');
		} catch {
			return raw;
		}
	};

	const chapters = [];
	const spineEls = [...opfDoc.querySelectorAll('spine > itemref')];
	const spine = spineEls.length ? spineEls.map((el) => el.getAttribute('idref')) : [...manifest.keys()];

	for (const idref of spine) {
		const item = manifest.get(idref);
		if (!item) continue;
		if (item.type && !/html/i.test(item.type)) continue;
		const path = resolvePath(item.href);
		const html = decode(path);
		if (!html) continue;
		let { title: chTitle, paragraphs } = extractParagraphs(html, DOMParserImpl);
		if (!paragraphs.length) continue;
		if (!chTitle) chTitle = `第 ${chapters.length + 1} 章`;
		chapters.push({ title: chTitle, paragraphs });
	}

	if (!chapters.length) throw new Error('EPUB 中没有解析到正文');
	return { kind: 'text', title: title || '未命名书籍', author, chapters };
}

// ============================================================
//  TXT
// ============================================================

const CHAPTER_LINE_RE = /^[ \t　]*(第[0-9０-９一二三四五六七八九十百千万零〇两]{1,12}[章节卷回篇部集][^\n]{0,30})[ \t]*$/;

/**
 * 解析 TXT（自动切章；无章节标记时按字符数兜底分段）
 * @param {ArrayBuffer|Uint8Array} buffer
 */
export function parseTxt(buffer, filename = '') {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	const text = decodeTextSmart(bytes).replace(/\r\n?/g, '\n');

	const cleanTitle = (filename || '').replace(/\.(txt|text)$/i, '').trim();

	const lines = text.split('\n');
	const chapters = [];
	let current = null;
	let preamble = [];

	for (const line of lines) {
		const m = line.match(CHAPTER_LINE_RE);
		if (m) {
			if (current) chapters.push(current);
			current = { title: m[1].trim(), lines: [] };
		} else if (current) {
			current.lines.push(line);
		} else {
			preamble.push(line);
		}
	}
	if (current) chapters.push(current);

	// 前言区处理：提取书名/作者，正文并入第一章（过滤书名行/作者行/空行）
	const preText = preamble.join('\n');
	const titleFromPre = (preText.match(/《([^》]{1,30})》/) || [])[1]?.trim() || '';
	const authorFromPre = (preText.match(/作\s*者[：:]\s*([^\n]{1,20})/) || [])[1]?.trim() || '';
	if (chapters.length) {
		const kept = preamble.filter((l) => {
			const t = l.trim();
			return t && !/^《[^》]{1,30}》\s*$/.test(t) && !/^作\s*者[：:]/.test(t);
		});
		if (kept.length) chapters[0].lines.unshift(...kept);
	}

	// 无章节结构 → 按字数兜底切分
	if (!chapters.length) {
		const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
		const CHUNK = 5000;
		let buf = [];
		let size = 0;
		let n = 1;
		for (const p of paras) {
			buf.push(p);
			size += p.length;
			if (size >= CHUNK) {
				chapters.push({ title: `第 ${n} 章`, lines: buf });
				buf = [];
				size = 0;
				n++;
			}
		}
		if (buf.length) chapters.push({ title: `第 ${n} 章`, lines: buf });
	}

	const out = chapters.map((c) => ({
		title: c.title,
		paragraphs: c.lines.map((l) => l.trim()).filter(Boolean)
	})).filter((c) => c.paragraphs.length);

	if (!out.length) throw new Error('TXT 中没有解析到正文');
	return {
		kind: 'text',
		title: cleanMetaText(titleFromPre || cleanTitle || '未命名书籍'),
		author: cleanMetaText(authorFromPre),
		chapters: out
	};
}

/**
 * 按文件扩展名分派解析
 *
 * EPUB 的判定要两段：先按文字书解析（章节 XHTML 有正文），
 * 失败再按漫画解析（spine 里是图片、或 XHTML 只包了一层 <img>）。
 * 漫画 EPUB 用文字解析一定会抛「没有解析到正文」，正好作为降级信号。
 */
export function parseBookFile(buffer, filename, DOMParserImpl) {
	const name = String(filename || '');
	if (/\.(txt|text)$/i.test(name)) return parseTxt(buffer, name);
	if (/\.cbz$/i.test(name)) return parseCbz(buffer, name);
	if (/\.cbr$/i.test(name)) throw new Error('暂不支持 CBR（RAR 压缩）；请转成 CBZ 或 EPUB 再导入');

	if (/\.epub$/i.test(name)) {
		// 漫画优先：整页是图的 EPUB 用文字解析往往只得到「封面那一行字」。
		// 复用这次解压结果，避免大文件解压两遍
		const info = inspectEpub(buffer, DOMParserImpl);
		if (info.isComic && info.files) {
			try { return parseComicEpub(buffer, DOMParserImpl, info.files); } catch { /* 退回文字解析 */ }
		}
		try {
			return parseEpub(buffer, DOMParserImpl);
		} catch (textErr) {
			try {
				return parseComicEpub(buffer, DOMParserImpl);
			} catch {
				throw textErr;
			}
		}
	}

	// 未知扩展名：ZIP magic（PK）先按 EPUB 试，再按 CBZ 试；否则当 TXT
	const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	const head = view.slice(0, 4);
	if (head[0] === 0x50 && head[1] === 0x4b) {
		const zipInfo = inspectEpub(buffer, DOMParserImpl);
		if (zipInfo.isComic && zipInfo.files) {
			try { return parseComicEpub(buffer, DOMParserImpl, zipInfo.files); } catch { /* 退回文字解析 */ }
		}
		try {
			return parseEpub(buffer, DOMParserImpl);
		} catch (textErr) {
			try {
				return parseComicEpub(buffer, DOMParserImpl);
			} catch {
				try {
					return parseCbz(buffer, name);
				} catch {
					throw textErr;
				}
			}
		}
	}
	return parseTxt(buffer, name);
}
