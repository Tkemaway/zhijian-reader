/**
 * 番茄小说源 —— 官方网页版解析（试读源）
 *
 * 说明：番茄网页版对未登录访客只开放每本书的官方免费章节（通常前 10 章），
 * 其余章节仅提供一小段试读。本模块忠实解析官方页面，不绕过平台限制。
 *
 * 正文为字符级混淆（PUA 私有区字符 + 专用字体渲染），
 * 使用离线构建的固定映射表还原（番茄的混淆字体长期固定，映射表见 fanqie-map.json）。
 */
import FANQIE_MAP from './fanqie-map.js';

const BASE = 'https://fanqienovel.com';

// ---------- 账号授权（可选）：用用户自己的登录态访问官方网页 ----------
// 凭证仅存本机 localStorage，仅发往 fanqienovel.com；不经过任何第三方。
const COOKIE_KEY = 'zj-fanqie-cookie';

export function loadFanqieCookie() {
	try {
		return (typeof localStorage !== 'undefined' ? localStorage.getItem(COOKIE_KEY) : '') || '';
	} catch {
		return '';
	}
}

export function saveFanqieCookie(cookie) {
	try {
		const v = String(cookie || '').trim();
		if (v) localStorage.setItem(COOKIE_KEY, v);
		else localStorage.removeItem(COOKIE_KEY);
	} catch { /* ignore */ }
}

export function hasFanqieCookie() {
	return !!loadFanqieCookie();
}

/** 番茄请求头（带授权凭证时附带 Cookie） */
export function fanqieHeaders(extra = {}) {
	const headers = { Referer: 'https://fanqienovel.com/', ...extra };
	const cookie = loadFanqieCookie();
	if (cookie) headers.Cookie = cookie;
	return headers;
}

/** 从 URL / 纯数字 ID 中提取番茄书籍 ID */
export function extractFanqieId(input) {
	const s = String(input || '').trim();
	if (/^\d{15,20}$/.test(s)) return s;
	const m = s.match(/fanqienovel\.com\/page\/(\d{15,20})/);
	if (m) return m[1];
	const m2 = s.match(/fanqienovel\.com\/reader\/(\d{15,20})/);
	if (m2) return null; // 章节链接不含书籍 ID，无法直接入架
	return null;
}

/** 是否像番茄的链接/ID（用于搜索框识别） */
export function looksLikeFanqie(input) {
	return extractFanqieId(input) !== null;
}

/** 解密：把 PUA 混淆字符替换为真实字符（映射表外的字符原样保留） */
export function decryptFanqieText(text) {
	if (!text) return text;
	let out = '';
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp >= 0xe000 && cp <= 0xf8ff) {
			out += FANQIE_MAP[cp.toString(16).toUpperCase().padStart(4, '0')] || ch;
		} else {
			out += ch;
		}
	}
	return out;
}

/** 解析目录页 HTML → { title, author, chapters: [{title, url, locked}], freeCount } */
export function parseFanqieToc(html) {
	const title = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1] || '';
	const author = (html.match(/"author":"([^"]+)"/) || [])[1] || '';
	const chapters = [];
	// 每章一个 chapter-item 容器；带 chapter-item-lock 的是试读章
	const itemRe = /<div class="chapter-item">([\s\S]*?)<\/div>/g;
	let m;
	while ((m = itemRe.exec(html))) {
		const seg = m[1];
		const link = seg.match(/href="\/reader\/(\d+)"/);
		const name = seg.match(/>([^<]+)<\/a>/);
		if (!link || !name) continue;
		chapters.push({
			title: name[1].trim(),
			url: `${BASE}/reader/${link[1]}`,
			locked: seg.includes('chapter-item-lock')
		});
	}
	const freeCount = chapters.filter((c) => !c.locked).length;
	return { title: title.trim(), author: author.trim(), chapters, freeCount };
}

/**
 * 解析章节页 HTML → { title, paragraphs, statedChars, preview }
 * preview=true 表示该章仅有官方试读片段（正文远少于标注字数）
 */
export function parseFanqieChapter(html) {
	const title = (html.match(/<h1[^>]*class="muye-reader-title"[^>]*>([^<]+)<\/h1>/) || html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1] || '';
	const statedM = html.match(/本章字数[：:]<\/span>(\d+)/) || html.match(/本章字数[：:](\d+)字/);
	const statedChars = statedM ? parseInt(statedM[1], 10) : 0;

	// 正文容器：muye-reader-content noselect → 内部 <p> 段落
	const bodyM = html.match(/muye-reader-content noselect">([\s\S]*?)<\/div><\/div>/);
	const paragraphs = [];
	if (bodyM) {
		const pRe = /<p>([\s\S]*?)<\/p>/g;
		let pm;
		while ((pm = pRe.exec(bodyM[1]))) {
			// 去标签 + 去零宽字符 + 解密 + 反转义常见实体
			const raw = pm[1]
				.replace(/<[^>]+>/g, '')
				.replace(/[\u200b\u200c\u200d\ufeff]/g, '')
				.replace(/&nbsp;/g, ' ')
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#x27;/g, "'")
				.trim();
			if (raw) paragraphs.push(decryptFanqieText(raw));
		}
	}

	const totalChars = paragraphs.join('').length;
	// 官方试读判定：有标注字数且实际内容不足其 60%（试读一般只有几十到百来字）
	const preview = statedChars > 500 && totalChars < statedChars * 0.6;
	return { title: title.trim(), paragraphs, statedChars, preview };
}

/** 构造书对象（供入架流程使用） */
export function buildFanqieBook(parsedToc, bookId) {
	return {
		title: parsedToc.title,
		author: parsedToc.author,
		sourceId: 'fanqie',
		sourceName: '番茄小说（官方试读）',
		bookUrl: `${BASE}/page/${bookId}`,
		tocUrl: `${BASE}/page/${bookId}`,
		totalChapters: parsedToc.chapters.length
	};
}
