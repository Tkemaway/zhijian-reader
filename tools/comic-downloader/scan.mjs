/**
 * 通用页面扫描 —— 给「链接下载」用
 *
 * 不依赖任何书源规则：给一个漫画页/目录页，尽量猜出
 *   - 标题
 *   - 这一页的图片（复用 App 的取图过滤）
 *   - 章节链接（「第 12 话」这类文字）
 *   - 下一话链接
 * 猜不准的地方交给界面让用户确认，不静默乱下。
 */
import { collectComicImages } from '../../src/core/engine.js';

const CHAPTER_TEXT_RE = /第\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,8}\s*[话話章卷回节節篇]/;
const NEXT_TEXT_RE = /^(下一\s*[话話章卷回节節篇]|next\s*(chapter|episode|chap)|›|»|→)\s*$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|bmp)(?:$|[?#])/i;

/** Windows / macOS 都能用的文件名片段 */
export function sanitizeSegment(name, max = 80) {
	let s = String(name || '')
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[.\s]+|[.\s]+$/g, '')
		.trim();
	if (!s) s = '未命名';
	if (s.length > max) s = s.slice(0, max).trim();
	return s;
}

/** 从 <title> / <h1> 取一个像书名的标题 */
export function pickTitle(doc, fallback = '') {
	const h1 = doc.querySelector('h1');
	const h1Text = (h1?.textContent || '').replace(/\s+/g, ' ').trim();
	if (h1Text && h1Text.length <= 60 && !/^(目录|章节列表|漫画)$/.test(h1Text)) return h1Text;
	const title = (doc.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
	if (!title) return fallback;
	return title.split(/[_|—–·]/)[0].trim() || fallback;
}

/** 章节号（只认阿拉伯数字，用于判断目录是否倒序） */
function chapterNumber(text) {
	const m = String(text).match(/第\s*([0-9０-９]{1,6})\s*[话話章卷回节節篇]/);
	if (!m) return null;
	const n = parseInt(m[1].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)), 10);
	return Number.isFinite(n) ? n : null;
}

/** 从页面里找章节链接（同源、文字像「第 N 话」） */
export function findChapterLinks(doc, baseUrl) {
	const base = new URL(baseUrl);
	const seen = new Set();
	const out = [];
	for (const a of doc.querySelectorAll('a[href]')) {
		const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
		if (!text || text.length > 40 || !CHAPTER_TEXT_RE.test(text)) continue;
		let url;
		try { url = new URL(a.getAttribute('href'), baseUrl).href; } catch { continue; }
		if (!/^https?:/i.test(url) || url.startsWith('javascript:')) continue;
		try {
			const u = new URL(url);
			if (u.hostname !== base.hostname) continue; // 站外链接通常是广告
		} catch { continue; }
		if (seen.has(url)) continue;
		seen.add(url);
		out.push({ title: text, url, num: chapterNumber(text) });
	}
	if (out.length < 2) return [];

	// 不少站点目录是倒序（最新在前）。至少 3 条且持续递减 → 反转，保证下载顺序从第 1 话开始
	const nums = out.map((c) => c.num).filter((n) => n != null);
	let descending = 0;
	for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) descending++;
	const reversed = nums.length >= 3 && descending >= nums.length - 2;
	if (reversed) out.reverse();

	return out.map(({ title, url }) => ({ title, url }));
}

/** 下一话链接 */
export function findNextLink(doc, baseUrl) {
	for (const a of doc.querySelectorAll('a[href]')) {
		const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
		if (!NEXT_TEXT_RE.test(text)) continue;
		try {
			const url = new URL(a.getAttribute('href'), baseUrl).href;
			if (/^https?:/i.test(url)) return url;
		} catch { /* ignore */ }
	}
	return '';
}

/**
 * 扫一页
 * @returns {{title:string, images:string[], chapters:Array, nextUrl:string, finalUrl:string}}
 */
export function scanHtml(html, finalUrl, DOMParserImpl) {
	const doc = new DOMParserImpl().parseFromString(String(html || ''), 'text/html');
	doc.querySelectorAll('script,style,noscript').forEach((el) => el.remove());

	const images = collectComicImages(doc, finalUrl, {}, DOMParserImpl)
		.filter((u) => /^data:image\//i.test(u) || IMAGE_EXT_RE.test(u) || !/\.(html?|php|aspx?)$/i.test(u));

	return {
		title: pickTitle(doc, ''),
		images,
		chapters: findChapterLinks(doc, finalUrl),
		nextUrl: findNextLink(doc, finalUrl),
		finalUrl
	};
}
