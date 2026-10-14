/**
 * so-novel 书源适配器
 * 把 so-novel 规则(main.json 格式)转换为统一的搜索/目录/章节操作
 */
import { extract, extractWithType, select, nodeText, absUrl, createParser, normalizeWhitespace } from './html.js';
import { executeDsl } from './dsl.js';
import { buildFormBody, originOf } from './http.js';

/** search.url 处理：@js: 动态 / %s 替换 */
export function processSearchUrl(url, keyword) {
	if (!url) return '';
	if (url.includes('@js:')) {
		const code = url.slice(url.indexOf('@js:') + 4);
		return executeDsl('@js:' + code, keyword);
	}
	return url.replace('%s', encodeURIComponent(keyword));
}

/** 解析 form data 模板 {k1: v1, k2: %s} → [[k,v],...]（%s 替换为关键词） */
export function parseFormTemplate(tpl, keyword) {
	if (!tpl) return [];
	let inner = String(tpl).trim();
	if (inner.startsWith('{')) inner = inner.slice(1);
	if (inner.endsWith('}')) inner = inner.slice(0, -1);

	const pairs = [];
	// 按顶层逗号分割（书源模板值中无逗号）
	for (const part of inner.split(',')) {
		const idx = part.indexOf(':');
		if (idx === -1) continue;
		const k = part.slice(0, idx).trim().replace(/^['"]|['"]$/g, '');
		let v = part.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
		if (v === '%s') v = keyword;
		pairs.push([k, v]);
	}
	return pairs;
}

/** cookies 模板 {k: v} → Cookie 头 */
export function parseCookies(cookieTpl) {
	if (!cookieTpl) return '';
	try {
		const obj = JSON.parse(cookieTpl);
		return Object.entries(obj)
			.map(([k, v]) => `${k}=${v}`)
			.join('; ');
	} catch {
		return '';
	}
}

/** 构造搜索请求 */
export function buildSearchRequest(source, keyword) {
	const rule = source.rule?.search;
	if (!rule) return null;
	const url = processSearchUrl(rule.url, keyword);
	const method = (rule.method || 'get').toUpperCase();
	const headers = {
		Referer: originOf(source.url || url)
	};
	const cookies = parseCookies(rule.cookies);
	if (cookies) headers.Cookie = cookies;

	let body = null;
	if (method === 'POST') {
		const pairs = parseFormTemplate(rule.data || '{}', keyword);
		body = buildFormBody(pairs);
		headers['Content-Type'] = 'application/x-www-form-urlencoded';
	}
	return { url, method, body, headers };
}

/**
 * 解析搜索结果页
 * 复刻 SearchParser.getSearchResults
 * @returns [{bookName, author, latestChapter, lastUpdateTime, bookUrl, intro, coverUrl}]
 */
export function parseSearchResults(html, baseUrl, source, DOMParserImpl) {
	const rule = source.rule?.search;
	if (!rule) return [];
	const parser = createParser(DOMParserImpl);
	let bodyHtml = html;

	// result 含 @js: → 先对响应体做转换
	if (rule.result && rule.result.includes('@js:')) {
		const code = rule.result.slice(rule.result.indexOf('@js:') + 4);
		bodyHtml = executeDsl('@js:' + code, html);
	}

	const doc = parser.parse(bodyHtml, baseUrl);
	const resultSelector = rule.result && rule.result.includes('@js:')
		? rule.result.slice(0, rule.result.indexOf('@js:'))
		: rule.result;

	const rows = select(doc, resultSelector);
	const results = [];

	for (const row of rows) {
		const bookName = extractWithType(row, rule.bookName, 'text');
		if (!bookName) continue;
		const bookUrl = extractWithType(row, rule.bookName, 'href');
		results.push({
			bookName: normalizeWhitespace(bookName),
			author: rule.author ? extractWithType(row, rule.author, 'text') : '',
			category: rule.category ? extractWithType(row, rule.category, 'text') : '',
			latestChapter: rule.latestChapter ? extractWithType(row, rule.latestChapter, 'text') : '',
			lastUpdateTime: rule.lastUpdateTime ? extractWithType(row, rule.lastUpdateTime, 'text') : '',
			bookUrl: bookUrl || '',
			sourceId: source.id,
			sourceName: source.name
		});
	}

	// 完全匹配直接跳详情页的情况
	if (!results.length && rule.bookName) {
		const bookDoc = parser.parse(html, baseUrl);
		const nameEl = select(bookDoc, source.rule?.book?.bookName || '');
		if (nameEl.length) {
			const name = nodeText(nameEl[0]);
			if (name) {
				results.push({
					bookName: normalizeWhitespace(name),
					author: source.rule?.book?.author ? extract(bookDoc, source.rule.book.author) : '',
					latestChapter: source.rule?.book?.latestChapter ? extract(bookDoc, source.rule.book.latestChapter) : '',
					lastUpdateTime: source.rule?.book?.lastUpdateTime ? extract(bookDoc, source.rule.book.lastUpdateTime) : '',
					bookUrl: baseUrl,
					sourceId: source.id,
					sourceName: source.name
				});
			}
		}
	}

	return results;
}

/**
 * 解析详情页（封面/简介/tocUrl）
 */
export function parseBookInfo(html, baseUrl, source, DOMParserImpl) {
	const rule = source.rule?.book;
	if (!rule) return {};
	const parser = createParser(DOMParserImpl);
	const doc = parser.parse(html, baseUrl);
	const info = {};
	if (rule.bookName) info.name = extract(doc, rule.bookName);
	if (rule.author) info.author = extract(doc, rule.author);
	if (rule.intro) info.intro = extract(doc, rule.intro);
	if (rule.coverUrl) info.coverUrl = extract(doc, rule.coverUrl);
	if (rule.latestChapter) info.latestChapter = extract(doc, rule.latestChapter);
	return info;
}

/**
 * 解析目录页
 * @returns [{title, url}]
 */
export function parseToc(html, baseUrl, source, DOMParserImpl) {
	const rule = source.rule?.toc;
	if (!rule) return [];
	const parser = createParser(DOMParserImpl);
	let doc = parser.parse(html, baseUrl);

	// toc.list：先提取子 HTML 再解析（ul 容器）
	let scope = doc;
	if (rule.list) {
		const tocHtml = extractWithType(doc, rule.list, 'html');
		if (tocHtml) scope = parser.parse(tocHtml, baseUrl);
	}

	const rows = select(scope, rule.item);
	const chapters = [];
	for (const row of rows) {
		const title = normalizeWhitespace(nodeText(row));
		let url = absUrl(row, 'href');
		// 行元素不是 a 时（如 dd/li），向下找第一个 a
		if (!url) {
			const a = row.querySelector?.('a');
			if (a) url = absUrl(a, 'href');
		}
		if (!url) continue;
		chapters.push({ title, url });
	}

	if (rule.isDesc) chapters.reverse();
	return chapters;
}

/** 目录分页链接（下拉菜单 / 下一页按钮） */
export function parseTocNextPages(html, baseUrl, source, DOMParserImpl) {
	const rule = source.rule?.toc;
	if (!rule?.nextPage) return [];
	const parser = createParser(DOMParserImpl);
	const doc = parser.parse(html, baseUrl);
	const els = select(doc, rule.nextPage);
	const urls = [];
	let hasHref = false;
	for (const el of els) {
		const h = absUrl(el, 'href');
		if (h) { hasHref = true; urls.push(h); }
	}
	if (!hasHref) {
		// option value 形式
		for (const el of els) {
			const v = el.getAttribute('value');
			if (v) urls.push(v);
		}
	}
	return urls;
}

/**
 * 解析章节页
 * @returns {title, contentHtml}
 */
export function parseChapter(html, baseUrl, source, DOMParserImpl) {
	const rule = source.rule?.chapter;
	if (!rule) return { title: '', contentHtml: '' };
	const parser = createParser(DOMParserImpl);
	const doc = parser.parse(html, baseUrl);

	const title = rule.title ? extract(doc, rule.title) : '';
	let contentHtml = '';
	if (rule.content) {
		contentHtml = extractWithType(doc, rule.content, 'html');
	}
	return { title: normalizeWhitespace(title), contentHtml };
}

/** 章节分页的下一页链接 */
export function parseChapterNextPage(html, baseUrl, source, DOMParserImpl) {
	const rule = source.rule?.chapter;
	if (!rule?.nextPage) return '';
	const parser = createParser(DOMParserImpl);
	const doc = parser.parse(html, baseUrl);
	const els = select(doc, rule.nextPage);
	if (!els.length) return '';
	const url = absUrl(els[0], 'href');
	// 通用判断：不指向下一章时才算分页
	const text = nodeText(els[0]);
	if (text && /(下一章|没有了|>>|书末页)/.test(text) && !/[-_]\d\.html/.test(url)) return '';
	return url;
}
