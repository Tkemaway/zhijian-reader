/**
 * DOM 提取层 —— 复刻 so-novel HtmlExtractor.java 的语义
 * 支持: CSS Selector / XPath / @href / @src / meta[..] / DSL 后置处理
 */
import { executeDsl, stripQuery } from './dsl.js';

function isXPath(selector) {
	return /^(\/|\/\/|\()/.test(selector);
}

function getDocument(el) {
	return el.ownerDocument || el;
}

/**
 * 查询元素（等价 document.select / document.selectXpath）
 * @returns {Element[]}
 */
export function select(el, query) {
	if (!el || !query) return [];
	const selector = stripQuery(query);
	if (!selector) return [];

	if (isXPath(selector)) {
		const doc = getDocument(el);
		const view = doc?.defaultView;
		try {
			const xpathDoc = doc;
			const result = xpathDoc.evaluate(
				selector,
				el,
				null,
				7, // ORDERED_NODE_SNAPSHOT_TYPE
				null
			);
			const nodes = [];
			for (let i = 0, n = result.snapshotLength; i < n; i++) {
				const node = result.snapshotItem(i);
				if (node && node.nodeType === 1) nodes.push(node);
			}
			return nodes;
		} catch (e) {
			console.warn('[html] xpath failed:', selector, e.message);
			return [];
		}
	}

	try {
		return Array.from(el.querySelectorAll(selector));
	} catch (e) {
		// 容错：jsoup 支持而浏览器不支持的少数字法，尝试降级
		try {
			return Array.from(el.querySelectorAll(selector.replace(/:lt\(\d+\)/g, '')));
		} catch {
			console.warn('[html] css selector failed:', selector, e.message);
			return [];
		}
	}
}

/** 复刻 jsoup 文本收集：块级元素间加空格，连续空白归一 */
const BLOCK_TAGS = new Set([
	'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dd', 'dt',
	'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
	'table', 'tbody', 'thead', 'tr', 'td', 'th', 'ul'
]);

function collectText(node) {
	if (node.nodeType === 3) return node.nodeValue || '';
	if (node.nodeType !== 1) return '';
	let out = '';
	for (const child of node.childNodes) {
		const t = collectText(child);
		if (child.nodeType === 3 || !BLOCK_TAGS.has((child.tagName || '').toLowerCase())) {
			out += t;
		} else {
			out += ' ' + t + ' ';
		}
	}
	return out;
}

export function normalizeWhitespace(s) {
	return String(s || '').replace(/[\s\u00a0\u3000]+/g, ' ').trim();
}

/** 元素 text()，等价 jsoup Element.text() */
export function nodeText(el) {
	if (!el) return '';
	return normalizeWhitespace(collectText(el));
}

/** 绝对化 URL，等价 jsoup absUrl（无效输入返回 ''） */
export function absUrl(el, attr) {
	const raw = el.getAttribute ? el.getAttribute(attr) : null;
	if (!raw) return '';
	const rawTrim = raw.trim();
	if (!rawTrim) return '';
	if (/^(javascript:|#|data:)/i.test(rawTrim)) return '';
	try {
		const doc = getDocument(el);
		const base = doc?.location?.href || doc?.__baseUrl || doc?.baseURI || '';
		if (!base || base === 'about:blank') return rawTrim;
		return new URL(rawTrim, base).href;
	} catch {
		return rawTrim;
	}
}

function getContentType(query) {
	if (!query) return 'text';
	if (query.includes('@href')) return 'attr';
	if (query.includes('@src')) return 'attr';
	if (query.startsWith('meta[')) return 'meta';
	return 'text';
}

function getAttrName(query) {
	if (query.includes('@href')) return 'href';
	if (query.includes('@src')) return 'src';
	return 'content';
}

function getContent(elements, query) {
	if (!elements.length) return '';
	const type = getContentType(query);
	if (type === 'attr') {
		return absUrl(elements[0], getAttrName(query));
	}
	if (type === 'meta') {
		return elements[0].getAttribute('content') || '';
	}
	return elements.map(nodeText).join('');
}

/** 查元素并提取内容 + DSL 后置处理（复刻 HtmlExtractor.extract） */
export function extract(el, query) {
	if (!el || !query) return '';
	const elements = select(el, query);
	if (!elements.length) return '';
	const raw = getContent(elements, query);
	return executeDsl(query, raw);
}

/**
 * 强制指定内容类型的提取（复刻 extract(el, query, contentType)）
 * @param {'text'|'html'|'href'|'src'|'content'} type
 */
export function extractWithType(el, query, type = 'text') {
	if (!el || !query) return '';
	const elements = select(el, query);
	if (!elements.length) return '';

	let raw;
	if (type === 'text') {
		raw = elements.map(nodeText).join('');
	} else if (type === 'html') {
		raw = elements[0].innerHTML || '';
	} else if (type === 'href' || type === 'src') {
		raw = absUrl(elements[0], type);
	} else {
		raw = elements[0].getAttribute(type) || '';
	}
	return executeDsl(query, raw);
}

/** 解析 HTML（优先使用注入的 DOMParser，浏览器用原生） */
export function createParser(DOMParserImpl) {
	const DP = DOMParserImpl || (typeof DOMParser !== 'undefined' ? DOMParser : null);
	if (!DP) throw new Error('DOMParser unavailable');
	return {
		parse(html, baseUrl = 'about:blank') {
			let src = String(html || '');
			// 片段内容（无 html/body 标签）自动包完整壳，
			// 规避 linkedom 对裸片段的解析缺陷；浏览器/原生 WebView 同样兼容
			if (!/<html[\s>]/i.test(src) && !/<body[\s>]/i.test(src)) {
				src = `<!DOCTYPE html><html><head></head><body>${src}</body></html>`;
			}
			const doc = new DP().parseFromString(src, 'text/html');
			ensureTbody(doc);
			attachBase(doc, baseUrl);
			return doc;
		}
	};
}

/**
 * 补全 table > tbody（浏览器/jsoup 解析时会自动插入，linkedom 不会）
 * 保证 `table > tbody > tr` 形式的选择器在 Node 测试环境同样有效
 */
function ensureTbody(doc) {
	try {
		const tables = doc.querySelectorAll('table');
		for (const table of tables) {
			const children = Array.from(table.children || []);
			const directRows = children.filter((c) => (c.tagName || '').toLowerCase() === 'tr');
			if (!directRows.length) continue;
			if (children.some((c) => (c.tagName || '').toLowerCase() === 'tbody')) continue;
			const tbody = doc.createElement('tbody');
			table.insertBefore(tbody, directRows[0]);
			for (const row of directRows) tbody.appendChild(row);
		}
	} catch { /* ignore */ }
}

/** 给文档挂基地址（Node 环境 Document.location 不存在时） */
function attachBase(doc, baseUrl) {
	if (!baseUrl || baseUrl === 'about:blank') return;
	try {
		doc.__baseUrl = baseUrl;
	} catch { /* ignore */ }
	try {
		const existing = doc.location;
		if (existing && existing.href && existing.href !== 'about:blank') return;
	} catch { /* ignore */ }
	try {
		Object.defineProperty(doc, 'location', {
			value: { href: baseUrl },
			configurable: true
		});
	} catch { /* 浏览器原生 location 只读，跳过 */ }
}
