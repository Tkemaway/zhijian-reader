/**
 * legado（阅读3.0）书源适配器
 * 把 legado 规则转换为统一的搜索/目录/章节操作
 */
import { createParser, normalizeWhitespace } from './html.js';
import { extractLegado, parseSearchUrl } from './legado.js';
import { buildFormBody, originOf } from './http.js';

/** 解析书源自带的 header 配置（JSON 字符串） */
function parseHeaderConfig(source) {
	if (!source.header) return {};
	try {
		const h = JSON.parse(source.header);
		const out = {};
		for (const [k, v] of Object.entries(h)) {
			if (k === 'User-Agent') continue; // 统一由请求层控制
			out[k] = String(v);
		}
		return out;
	} catch {
		return {};
	}
}

/** 构造搜索请求 */
export function buildSearchRequest(source, keyword) {
	const parsed = parseSearchUrl(source.searchUrl || '', keyword, { baseUrl: source.url });
	if (!parsed) return null;
	const headers = {
		Referer: originOf(source.url || parsed.url),
		...parseHeaderConfig(source)
	};
	let body = null;
	if (parsed.method === 'post' && parsed.body != null) {
		// body 已是 "k=v&k2=v2" 形式（可能含未编码中文）→ 逐对编码
		try {
			const pairs = parsed.body.split('&').map((kv) => {
				const i = kv.indexOf('=');
				if (i === -1) return [kv, ''];
				return [kv.slice(0, i), kv.slice(i + 1)];
			});
			body = buildFormBody(pairs);
		} catch {
			body = parsed.body;
		}
		headers['Content-Type'] = 'application/x-www-form-urlencoded';
	}
	return { url: parsed.url, method: (parsed.method || 'get').toUpperCase(), body, headers, charset: parsed.charset };
}

/** 解析搜索结果页 */
export function parseSearchResults(html, baseUrl, source, DOMParserImpl, keyword = '') {
	const rule = source.ruleSearch;
	if (!rule || !rule.bookList) return [];
	const parser = createParser(DOMParserImpl);
	const doc = parser.parse(html, baseUrl);
	const ctx = { doc, baseUrl, book: {} };

	const rows = collectRows(doc, rule.bookList, ctx);
	const results = [];
	for (const row of rows) {
		const bookName = normalizeWhitespace(
			legadoSafe(() => extractLegado(row, rule.name, { ...ctx, row }))
		);
		if (!bookName) continue;
		let bookUrl = legadoSafe(() => extractLegado(row, rule.bookUrl, { ...ctx, row }));
		// bookUrl 相对路径 → 绝对化
		bookUrl = absolutize(bookUrl, baseUrl);
		results.push({
			bookName,
			author: legadoSafe(() => extractLegado(row, rule.author, { ...ctx, row })),
			category: legadoSafe(() => extractLegado(row, rule.kind, { ...ctx, row })),
			latestChapter: legadoSafe(() => extractLegado(row, rule.lastChapter, { ...ctx, row })),
			lastUpdateTime: legadoSafe(() => extractLegado(row, rule.updateTime, { ...ctx, row })),
			intro: legadoSafe(() => extractLegado(row, rule.intro, { ...ctx, row })),
			bookUrl,
			sourceId: source.id,
			sourceName: source.name
		});
	}

	// 完全匹配直达详情页：bookList 为空但页面标题即书名
	if (!results.length && keyword) {
		const titleEl = doc.querySelector('title');
		const title = titleEl ? normalizeWhitespace(titleEl.textContent) : '';
		const head = title.slice(0, 15);
		if (title && head.includes(keyword.slice(0, 6))) {
			let bookName = title.split(/[-_|—–·]/)[0].trim() || keyword;
			if (bookName.includes('搜索') || bookName.length > 30) bookName = keyword;
			results.push({
				bookName,
				author: '',
				category: '',
				latestChapter: '',
				lastUpdateTime: '',
				intro: '',
				bookUrl: baseUrl,
				sourceId: source.id,
				sourceName: source.name,
				directHit: true
			});
		}
	}

	return results;
}

/** 解析 bookList 得到行元素数组（bookList 可能是 CSS/XPath/多规则） */
function collectRows(doc, bookListRule, ctx) {
	// 简单规则直接用 extractLegado 的元素返回能力
	const { parseRuleString, navigate } = getLegadoInternals();
	const parsed = parseRuleString(bookListRule);
	let elements = [doc];
	for (const seg of parsed.nav) {
		elements = navigate(elements, seg, doc);
	}
	return elements;
}

let _legadoInternals = null;
function getLegadoInternals() {
	if (!_legadoInternals) {
		// 动态导入避免循环依赖
		// eslint-disable-next-line global-require
		_legadoInternals = legadoModule;
	}
	return _legadoInternals;
}
import * as legadoModule from './legado.js';

/** 解析详情页 */
export function parseBookInfo(html, baseUrl, source, DOMParserImpl) {
	const rule = source.ruleBookInfo;
	const parser = createParser(DOMParserImpl);
	const doc = parser.parse(html, baseUrl);
	const ctx = { doc, baseUrl, book: {} };
	const info = {};
	if (!rule) return info;
	for (const [key, field] of [
		['name', 'name'], ['author', 'author'], ['intro', 'intro'],
		['coverUrl', 'coverUrl'], ['latestChapter', 'lastChapter'],
		['tocUrl', 'tocUrl']
	]) {
		if (rule[field]) {
			let v = legadoSafe(() => extractLegado(doc, rule[field], ctx));
			if (field === 'coverUrl' || field === 'tocUrl') v = absolutize(v, baseUrl);
			info[key] = v;
		}
	}
	return info;
}

/** 解析目录页 */
export function parseToc(html, baseUrl, source, DOMParserImpl) {
	const rule = source.ruleToc;
	if (!rule || !rule.chapterList) return [];
	const parser = createParser(DOMParserImpl);
	const doc = parser.parse(html, baseUrl);
	const ctx = { doc, baseUrl, book: {} };

	const rows = collectRows(doc, rule.chapterList, ctx);
	const chapters = [];
	for (const row of rows) {
		const title = normalizeWhitespace(
			legadoSafe(() => extractLegado(row, rule.chapterName || 'text', { ...ctx, row }))
		);
		let url = legadoSafe(() => extractLegado(row, rule.chapterUrl || 'href', { ...ctx, row }));
		url = absolutize(url, baseUrl);
		if (!url) continue;
		chapters.push({ title, url });
	}
	return chapters;
}

/** 目录分页链接列表 */
export function parseTocNextPages(html, baseUrl, source, DOMParserImpl) {
	const rule = source.ruleToc;
	if (!rule?.nextTocUrl) return [];
	const parser = createParser(DOMParserImpl);
	const doc = parser.parse(html, baseUrl);
	const ctx = { doc, baseUrl, book: {} };

	// nextTocUrl 可能返回多个 URL（逗号或换行分隔）
	const raw = legadoSafe(() => extractLegado(doc, rule.nextTocUrl, ctx));
	if (!raw) return [];
	return String(raw)
		.split(/[,\n]/)
		.map((s) => absolutize(s.trim(), baseUrl))
		.filter((s) => /^https?:\/\//.test(s));
}

/** 解析章节内容页 */
export function parseChapter(html, baseUrl, source, DOMParserImpl) {
	const rule = source.ruleContent;
	if (!rule || !rule.content) return { title: '', contentHtml: '' };
	const parser = createParser(DOMParserImpl);
	const doc = parser.parse(html, baseUrl);
	const ctx = { doc, baseUrl, book: {} };

	let content = legadoSafe(() => extractLegado(doc, rule.content, ctx));

	// 提取结果是元素对象时取 innerHTML
	if (content && typeof content === 'object') {
		content = content.innerHTML || content.outerHTML || '';
	}

	// textNodes 等纯文本结果 → 按行转段落
	if (content && !/<(p|div|br|span|section|article)[\s>/]/i.test(content)) {
		content = plainTextToParagraphs(content);
	}

	// replaceRegex 清洗（## 语法）
	if (rule.replaceRegex) {
		content = applyReplaceRegex(content, rule.replaceRegex);
	}

	return { title: '', contentHtml: content || '' };
}

/** 纯文本 → <p> 段落（转义 HTML 特殊字符） */
function plainTextToParagraphs(text) {
	return String(text)
		.split(/\n+/)
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => `<p>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
		.join('');
}

function applyReplaceRegex(text, rule) {
	if (!text || !rule) return text;
	const idx = String(rule).indexOf('##');
	if (idx === -1) return text;
	const tokens = String(rule).slice(idx).split('##');
	let s = text;
	for (let i = 1; i < tokens.length; i += 2) {
		const regex = tokens[i];
		const repl = i + 1 < tokens.length ? tokens[i + 1] : '';
		try {
			s = s.replace(new RegExp(regex, 'g'), repl);
		} catch { /* ignore */ }
	}
	return s;
}

/** 章节分页（nextContentUrl） */
export function parseChapterNextPage(html, baseUrl, source, DOMParserImpl) {
	const rule = source.ruleContent;
	if (!rule?.nextContentUrl) return '';
	const parser = createParser(DOMParserImpl);
	const doc = parser.parse(html, baseUrl);
	const ctx = { doc, baseUrl, book: {} };
	let url = legadoSafe(() => extractLegado(doc, rule.nextContentUrl, ctx));
	url = absolutize(url, baseUrl);
	return url || '';
}

function legadoSafe(fn) {
	try {
		const v = fn();
		return v == null ? '' : String(v);
	} catch (e) {
		return '';
	}
}

function absolutize(url, baseUrl) {
	if (!url) return '';
	if (/^https?:\/\//i.test(url)) return url;
	if (/^(javascript:|#)/i.test(url)) return '';
	const first = url.split(/[,\n]/)[0].trim();
	try {
		return new URL(first, baseUrl || 'http://localhost').href;
	} catch {
		return first;
	}
}
