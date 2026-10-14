/**
 * legado（阅读 3.0）书源规则适配器
 *
 * 支持的语法子集（覆盖 XIU2/Yuedu 全部书源用到的语法）：
 *  - 默认导航: class.xxx.0 / tag.xxx.1 / id.xxx.0 / text.文本
 *  - CSS 片段: ".cls"、"a"、"[property$=author]"、".a li b"
 *  - XPath:   "xpath://div[@id='x']" 或 "//div..."
 *  - 索引/切片: ".0" ".-1" "[0:1]"（含头含尾）
 *  - 提取器:  @text @html @ownText @textNodes @all @href @src @content(任意属性) @js:code
 *  - 清洗:    ##regex##replacement（可多组）
 *  - 组合:    && 拼接多规则、|| 短路
 */

import { nodeText, normalizeWhitespace } from './html.js';

const DEFAULT_NAV_PREFIXES = ['class.', 'tag.', 'id.', 'text.'];

/** 已知提取器名 */
const EXTRACTORS = new Set([
	'text', 'html', 'ownText', 'textNodes', 'all', 'textHtml',
	'href', 'src', 'content', 'value'
]);

/** 常见 HTML 标签（用于区分"属性提取器"与"标签 CSS"） */
const COMMON_TAGS = new Set([
	'a', 'p', 'div', 'span', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table',
	'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'strong', 'i', 'b',
	'u', 's', 'br', 'hr', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code',
	'font', 'center', 'body', 'html', 'head', 'meta', 'link', 'script',
	'style', 'form', 'input', 'button', 'select', 'option', 'textarea',
	'nav', 'header', 'footer', 'section', 'article', 'aside', 'main',
	'figure', 'figcaption', 'small', 'sub', 'sup', 'label', 'iframe'
]);

/**
 * 解析单条规则字符串 → { nav: [{...}], extractor: string|null, jsCode: string|null, cleans: [] }
 */
export function parseRuleString(ruleStr) {
	const result = { nav: [], extractor: null, jsCode: null, cleans: [] };
	if (!ruleStr) return result;

	let body = ruleStr.trim();

	// 1. 剥离 ## 清洗（成对解析：##regex##replacement##regex2##replacement2）
	const cleanIdx = body.indexOf('##');
	if (cleanIdx !== -1) {
		const cleanPart = body.slice(cleanIdx);
		body = body.slice(0, cleanIdx);
		const tokens = cleanPart.split('##');
		// tokens[0] 为空；之后两两成对
		for (let i = 1; i < tokens.length; i += 2) {
			result.cleans.push({
				regex: tokens[i],
				replacement: i + 1 < tokens.length ? tokens[i + 1] : ''
			});
		}
	}

	// 2. 剥离 @js:（代码一直到串尾）
	const jsIdx = body.indexOf('@js:');
	if (jsIdx !== -1) {
		result.jsCode = body.slice(jsIdx + 4);
		body = body.slice(0, jsIdx);
	}

	// 3. 按 @ 分割导航链与提取器
	//    注意 "xpath://div[@x='y']/@href" 内的 @ 不能分割 → 先做保护
	const segments = splitByAt(body);
	let sawExtractor = false;
	for (const seg of segments) {
		if (!seg) continue;
		if (isExtractorSeg(seg, segments)) {
			sawExtractor = true;
			result.extractor = seg;
		} else {
			result.nav.push(parseNavSegment(seg));
		}
	}
	// extractor 出现在导航之前的（极少），保留即可
	return result;
}

/**
 * 按 @ 拆分，但保护 xpath 中的 @（[@id=...]、节点属性选择）
 */
function splitByAt(body) {
	const parts = [];
	let buf = '';
	let depth = 0; // [ ] 深度
	let inQuote = null;
	let inXPath = false;

	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (inQuote) {
			buf += ch;
			if (ch === inQuote && body[i - 1] !== '\\') inQuote = null;
			continue;
		}
		if (ch === '[' || ch === '(') { depth++; buf += ch; continue; }
		if (ch === ']' || ch === ')') { depth--; buf += ch; continue; }
		if (ch === '"' || ch === "'") { inQuote = ch; buf += ch; continue; }

		// 检测 xpath: 前缀或 // 开头 → 后续 @ 都是 xpath 属性，不分割
		if (!inXPath) {
			const rest = body.slice(i);
			if (rest.startsWith('xpath:') || rest.startsWith('//') || rest.startsWith('css:')) {
				inXPath = rest.startsWith('xpath:') || rest.startsWith('//');
			}
		}

		if (ch === '@') {
			// xpath 中 [@xx=] 的 @ 前面是 '['，不分割；其他以 @ 开头的属性语法 [@ 也跳过
			if (depth > 0) { buf += ch; continue; }
			// " //div ... /@href" 形式：/@ 不分割
			if (inXPath && (body[i - 1] === '/' || body[i - 1] === '[' )) { buf += ch; continue; }
		if (inXPath) { buf += ch; continue; }
			parts.push(buf);
			buf = '';
			continue;
		}
		buf += ch;
	}
	if (buf) parts.push(buf);
	return parts.map((s) => s.trim()).filter(Boolean);
}

/** 判定一个段是否是"提取器" */
function isExtractorSeg(seg, allSegs) {
	if (EXTRACTORS.has(seg)) return true;
	// 纯标识符且不是常见标签 → 视为属性提取器（如 data-src / alt / title / property）
	if (/^[a-zA-Z_][\w-]*$/.test(seg) && !COMMON_TAGS.has(seg.toLowerCase())) {
		// 但如果它是第一段且像标签（无前缀），按导航处理（已在上面被 COMMON_TAGS 拦截）
		return true;
	}
	return false;
}

/**
 * 解析一段导航：class.x.0 / tag.a.1 / id.list.0 / text.下一页.0 / 纯 CSS / css: / xpath:
 * → { kind, name, idx, slice, exclude, sel }
 */
export function parseNavSegment(raw) {
	const seg = { kind: 'css', name: raw, idx: null, slice: null, exclude: null };

	let s = raw;

	// 显式前缀
	if (s.startsWith('css:')) { seg.kind = 'css'; s = s.slice(4); seg.name = s; }
	else if (s.startsWith('xpath:')) { seg.kind = 'xpath'; s = s.slice(6); seg.name = s; }
	else if (s.startsWith('//') || s.startsWith('/') || s.startsWith('(')) { seg.kind = 'xpath'; seg.name = s; }
	else {
		// 排除语法 NAME!N（如 tr!0 → 全部 tr 但排除第 0 个）
		const exclM = s.match(/!(-?\d+)$/);
		if (exclM) {
			seg.exclude = parseInt(exclM[1], 10);
			s = s.slice(0, -exclM[0].length);
		}
		// 尾部切片 [m:n]
		const sliceM = s.match(/\[(-?\d+):(-?\d+)\]$/);
		if (sliceM) {
			seg.slice = [parseInt(sliceM[1], 10), parseInt(sliceM[2], 10)];
			s = s.slice(0, -sliceM[0].length);
		}
		// 尾部索引 .N / .-N（避免误伤类选择器 .xxx：只匹配纯数字）
		const idxM = s.match(/\.(-?\d+)$/);
		if (idxM) {
			seg.idx = parseInt(idxM[1], 10);
			s = s.slice(0, -idxM[0].length);
		}
		// 带前缀的默认导航
		if (s.startsWith('class.')) { seg.kind = 'class'; seg.name = s.slice(6); }
		else if (s.startsWith('tag.')) { seg.kind = 'tag'; seg.name = s.slice(4); }
		else if (s.startsWith('id.')) { seg.kind = 'id'; seg.name = s.slice(3); }
		else if (s.startsWith('text.')) { seg.kind = 'text'; seg.name = s.slice(5); }
		else { seg.kind = 'css'; seg.name = s; }
	}

	return seg;
}

/** 在元素集合上执行一段导航 → 新元素集合 */
export function navigate(elements, seg, doc) {
	let out = [];
	const pool = elements.length ? elements : [doc];

	if (seg.kind === 'css') {
		for (const el of pool) {
			try {
				// 特殊伪语法处理：末尾的 .N 已剥离；直接查询
				out.push(...el.querySelectorAll(seg.name));
			} catch {
				/* 无效选择器跳过 */
			}
		}
	} else if (seg.kind === 'xpath') {
		for (const el of pool) {
			try {
				const d = el.ownerDocument || el;
				const res = d.evaluate(seg.name, el, null, 7, null);
				for (let i = 0; i < res.snapshotLength; i++) {
					const n = res.snapshotItem(i);
					if (n && n.nodeType === 1) out.push(n);
				}
			} catch {
				/* ignore */
			}
		}
	} else if (seg.kind === 'class') {
		for (const el of pool) out.push(...el.querySelectorAll('.' + cssEscape(seg.name)));
	} else if (seg.kind === 'tag') {
		for (const el of pool) out.push(...el.querySelectorAll(seg.name));
	} else if (seg.kind === 'id') {
		for (const el of pool) {
			try {
				const found = el.querySelector('#' + cssEscape(seg.name));
				if (found) out.push(found);
			} catch { /* ignore */ }
		}
	} else if (seg.kind === 'text') {
		for (const el of pool) {
			// 文档序查找：文本包含目标且自身是"最小"命中
			const all = el.querySelectorAll('*');
			for (const node of all) {
				if (nodeText(node).includes(seg.name)) {
					out.push(node);
				}
			}
		}
	}

	// 去重（保持顺序）
	out = dedupe(out);

	// 应用排除（!N）
	if (seg.exclude != null) {
		const ex = seg.exclude < 0 ? out.length + seg.exclude : seg.exclude;
		out = out.filter((_, i) => i !== ex);
	}
	// 应用切片/索引
	if (seg.slice) {
		const [a, b] = seg.slice;
		out = out.slice(Math.max(0, a), b + 1 > 0 ? b + 1 : undefined);
	}
	if (seg.idx != null) {
		if (seg.idx < 0) out = out.length + seg.idx >= 0 ? [out[out.length + seg.idx]] : [];
		else out = out.length > seg.idx ? [out[seg.idx]] : [];
	}
	return out;
}

function dedupe(arr) {
	const seen = new Set();
	const out = [];
	for (const x of arr) {
		if (!seen.has(x)) { seen.add(x); out.push(x); }
	}
	return out;
}

function cssEscape(name) {
	if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(name);
	return String(name).replace(/([^\w-])/g, '\\$1');
}

/** 应用提取器（对导航结果） */
function applyExtractor(elements, extractor, ctx) {
	if (!elements.length) return '';
	if (!extractor) {
		// 无提取器 → 返回元素本身（供 @js 使用等）
		return elements.length === 1 ? elements[0] : elements;
	}
	const name = extractor;
	if (name === 'text') {
		return elements.map(nodeText).join('');
	}
	if (name === 'html') {
		return elements[0].innerHTML || '';
	}
	if (name === 'ownText') {
		return ownText(elements[0]);
	}
	if (name === 'textNodes') {
		return elements.map((el) => allTextNodes(el)).join('');
	}
	if (name === 'all') {
		return elements[0].outerHTML || '';
	}
	// 属性提取（href/src/content/alt/data-xxx...）
	return elements[0].getAttribute(name) || '';
}

function ownText(el) {
	if (!el) return '';
	let s = '';
	for (const n of el.childNodes) {
		if (n.nodeType === 3) s += n.nodeValue || '';
	}
	return normalizeWhitespace(s);
}

function allTextNodes(el) {
	// legado 语义：所有文本节点用 \n 连接
	const nodes = [];
	const walk = (n) => {
		if (n.nodeType === 3) {
			const t = (n.nodeValue || '').trim();
			if (t) nodes.push(t);
		} else if (n.nodeType === 1) {
			for (const c of n.childNodes) walk(c);
		}
	};
	walk(el);
	return nodes.join('\n');
}

/** 应用 ## 清洗 */
function applyCleans(text, cleans) {
	let s = text;
	for (const { regex, replacement } of cleans) {
		if (!regex) continue;
		try {
			s = s.replace(new RegExp(regex, 'g'), replacement ?? '');
		} catch {
			try {
				s = s.split(regex).join(replacement ?? '');
			} catch { /* ignore */ }
		}
	}
	return s;
}

/**
 * 执行一条完整规则（含 && / || 组合）
 * @param {Element} root  当前上下文元素（搜索时为 bookList 行元素）
 * @param {string} ruleStr
 * @param {object} ctx    { doc, baseUrl, book }
 */
export function extractLegado(root, ruleStr, ctx = {}) {
	if (!ruleStr) return '';
	const doc = ctx.doc || root?.ownerDocument || root;

	// 空规则特殊情形
	let s = String(ruleStr).trim();
	if (!s) return '';

	// || 短路（罕见，但支持）
	if (s.includes('||')) {
		for (const part of s.split('||')) {
			const v = extractLegado(root, part, ctx);
			if (v) return v;
		}
		return '';
	}
	// {{...}} 模板先不支持（含模板的字段返回空）
	if (s.includes('{{')) return '';

	// && 拼接
	if (s.includes('&&')) {
		return s
			.split('&&')
			.map((p) => extractLegado(root, p.trim(), ctx))
			.join('');
	}

	const parsed = parseRuleString(s);

	// 导航
	let elements = [root];
	for (const seg of parsed.nav) {
		elements = navigate(elements, seg, doc);
		if (!elements.length) {
			// 导航中断：若还有 js 需要元素，返回空
			return parsed.jsCode ? runLegadoJs(null, parsed.jsCode, ctx) : '';
		}
	}

	// 提取
	let value = applyExtractor(elements, parsed.extractor, ctx);

	// 相对 URL 绝对化（href/src 提取器）
	if (parsed.extractor === 'href' || parsed.extractor === 'src') {
		value = absUrl(value, ctx.baseUrl);
	}

	// @js 处理
	if (parsed.jsCode) {
		value = runLegadoJs(value, parsed.jsCode, ctx);
	}

	// ## 清洗
	if (parsed.cleans.length) {
		value = applyCleans(typeof value === 'string' ? value : String(value), parsed.cleans);
	}

	return value == null ? '' : String(value);
}

function absUrl(url, baseUrl) {
	if (!url) return '';
	if (/^https?:\/\//i.test(url)) return url;
	if (/^(javascript:|#|data:)/i.test(url)) return '';
	try {
		return new URL(url, baseUrl || 'http://localhost').href;
	} catch {
		return url;
	}
}

/** 执行 legado 的 @js 代码（result / book / baseUrl / java 变量，取 eval 完成值） */
export function runLegadoJs(input, code, ctx = {}) {
	try {
		// legado 语义：取代码的"完成值"（最后一个表达式/赋值的结果），
		// 未产生完成值时回退到 result 变量
		const factory = new Function(
			'result', 'book', 'baseUrl', 'java', 'code',
			'var __v = eval(code);\nreturn __v !== undefined ? __v : result;'
		);
		const java = createJavaBridge(ctx);
		const out = factory(input, ctx.book || {}, ctx.baseUrl || '', java, code);
		if (out == null) return '';
		return typeof out === 'string' ? out : String(out);
	} catch (e) {
		console.warn('[legado] js failed:', e.message);
		return typeof input === 'string' ? input : '';
	}
}

/** java.ajax 等 Java 接口桥（同步不可行 → 仅声明占位，由上层预处理替换） */
function createJavaBridge(ctx) {
	return {
		ajax(url) {
			// 同步 JS 无法直接发请求；若 ctx.javaResponses 缓存中存在则返回
			if (ctx.javaResponses && ctx.javaResponses[url]) return ctx.javaResponses[url];
			throw new Error('java.ajax not available in sync context');
		},
		base64Encode: (s) => btoa(unescape(encodeURIComponent(s))),
		base64Decode: (s) => decodeURIComponent(escape(atob(s)))
	};
}

/**
 * 解析 searchUrl
 * 形态1: "/path?q={{key}}"
 * 形态2: "/path,{'method':'post','body':'k={{key}}','charset':'gbk'}"
 * relativeUrlBase: 书源 URL（相对路径拼接用）
 */
export function parseSearchUrl(searchUrl, key, opts = {}) {
	if (!searchUrl) return null;
	const { baseUrl = '', page = 1 } = opts;
	let urlPart = searchUrl;
	let conf = {};

	const commaIdx = searchUrl.indexOf(',');
	if (commaIdx !== -1 && searchUrl.trimStart().indexOf(',{') !== -1) {
		urlPart = searchUrl.slice(0, commaIdx);
		const confStr = searchUrl.slice(commaIdx + 1);
		conf = parseLooseJson(confStr);
	}

	// {{key}} / {{page}} 替换
	urlPart = urlPart
		.replace(/\{\{\s*key\s*\}\}/g, encodeURIComponent(key))
		.replace(/\{\{\s*page\s*\}\}/g, String(page))
		.replace(/\{\{\s*\}\}/g, '');

	// 相对路径拼书源地址
	let url = urlPart;
	if (baseUrl && !/^https?:\/\//i.test(url) && !url.startsWith('data:')) {
		try {
			url = new URL(url, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').href;
		} catch { /* keep raw */ }
	}

	const body = conf.body ? String(conf.body).replace(/\{\{\s*key\s*\}\}/g, key) : null;
	return {
		url,
		method: (conf.method || 'get').toLowerCase(),
		body,
		charset: conf.charset || null,
		headers: conf.headers || null
	};
}

/** 宽松 JSON 解析（单引号 / 无引号 key） */
export function parseLooseJson(str) {
	if (!str) return {};
	// 先试标准 JSON
	try { return JSON.parse(str); } catch { /* continue */ }

	// 单引号 → 双引号（保护字符串内部的符号）
	let s = str.trim();
	if (!s.startsWith('{')) return {};
	let out = '';
	let inSingle = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "'") {
			inSingle = !inSingle;
			out += '"';
		} else if (ch === '"' && inSingle) {
			out += '\\"';
		} else {
			out += ch;
		}
	}
	try { return JSON.parse(out); } catch { /* continue */ }

	// 终极兜底：正则抽取
	const conf = {};
	const mMethod = str.match(/['"]method['"]\s*:\s*['"](\w+)['"]/);
	if (mMethod) conf.method = mMethod[1];
	const mBody = str.match(/['"]body['"]\s*:\s*['"]([\s\S]*?)['"]\s*[,}\n]/);
	if (mBody) conf.body = mBody[1];
	const mCharset = str.match(/['"]charset['"]\s*:\s*['"]([\w-]+)['"]/);
	if (mCharset) conf.charset = mCharset[1];
	return conf;
}
