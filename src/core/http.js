/**
 * 请求层 —— 统一 Node / 浏览器 / Capacitor(Android) 三端的网络请求
 * 关键能力: 原始字节获取 + 自动编码检测(UTF-8/GBK/GB18030/Big5)
 */

export const DEFAULT_UA =
	'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/** 运行环境检测 */
export function getEnv() {
	if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) return 'capacitor';
	if (typeof window !== 'undefined' && typeof document !== 'undefined') return 'browser';
	return 'node';
}

function getCapacitorHttp() {
	if (typeof window !== 'undefined' && window.Capacitor?.Plugins?.CapacitorHttp) {
		return window.Capacitor.Plugins.CapacitorHttp;
	}
	return null;
}

/** base64 → Uint8Array */
function base64ToBytes(b64) {
	if (typeof atob === 'function') {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	}
	// Node 环境
	const buf = Buffer.from(b64, 'base64');
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** 字节 → base64（CapacitorHttp 的复杂类型体：base64 + dataType:'file'） */
function bytesToBase64(bytes) {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (typeof btoa === 'function') {
		let bin = '';
		const CHUNK = 0x8000;
		for (let i = 0; i < arr.length; i += CHUNK) bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
		return btoa(bin);
	}
	return Buffer.from(arr).toString('base64');
}

/**
 * 部分站点无视 Accept-Encoding 强制返回 gzip 压缩流（magic: 1f 8b）
 * 检测并解压，保证后续编码判断正确
 */
async function maybeDecompress(bytes) {
	if (!(bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
	try {
		if (typeof DecompressionStream !== 'undefined') {
			const ds = new DecompressionStream('gzip');
			const stream = new Blob([bytes]).stream().pipeThrough(ds);
			const buf = await new Response(stream).arrayBuffer();
			return new Uint8Array(buf);
		}
		// Node 兜底（浏览器构建时忽略该分支）
		if (typeof process !== 'undefined' && process.versions?.node) {
			const zlib = await import(/* @vite-ignore */ 'node:zlib');
			return new Uint8Array(zlib.gunzipSync(bytes));
		}
		return bytes;
	} catch {
		return bytes;
	}
}

/** 开发预览模式下经本地代理转发（绕过 CORS），打包后不使用 */
function proxiedUrl(url) {
	try {
		if (import.meta.env?.DEV) {
			return `/__proxy?url=${encodeURIComponent(url)}`;
		}
	} catch { /* ignore */ }
	return url;
}

/**
 * 发起请求，返回原始字节 + 最终 URL
 * @returns {Promise<{bytes: Uint8Array, finalUrl: string, contentType: string}>}
 */
export async function requestBytes(url, opts = {}) {
	const { method = 'GET', body = null, headers = {}, timeout = 20000, signal } = opts;
	signal?.throwIfAborted();
	const env = getEnv();

	if (env === 'capacitor') {
		const CapacitorHttp = getCapacitorHttp();
		if (CapacitorHttp) {
			try {
				// 字节数组请求体：
				// - 文本类 Content-Type（JSON/表单/XML 等）→ 解码为字符串发送
				//   （CapacitorHttp 对 application/json 会按字符串原文发送，
				//    若传 base64+dataType:'file'，JSON 分支优先级更高会导致 body 错误）
				// - 其他（真二进制）→ 官方推荐的 base64 + dataType:'file'
				let reqData = body;
				let reqDataType;
				if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
					const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
					const ct = String(headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
					if (ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('form') || ct === '') {
						reqData = new TextDecoder('utf-8').decode(bytes);
					} else {
						reqData = bytesToBase64(bytes);
						reqDataType = 'file';
					}
				}
				const res = await CapacitorHttp.request({
					url,
					method: method.toUpperCase(),
					headers: { 'User-Agent': DEFAULT_UA, ...headers },
					data: reqData || undefined,
					dataType: reqDataType,
					responseType: 'arraybuffer',
					connectTimeout: timeout,
					readTimeout: timeout
				});
				signal?.throwIfAborted();
				let data = res.data;
				if (typeof data === 'string') {
					// ARRAYBUFFER 响应 → base64 字符串；
					// 但错误响应（4xx 的 HTML 等）会以原文返回 → 尝试 base64 失败则按文本处理
					const compact = data.replace(/\s+/g, '');
					try {
						data = compact ? base64ToBytes(compact) : new Uint8Array(0);
					} catch {
						// 含 U+FFFD 替换符 → 二进制流被当作文本读取后的乱码（字节已丢失，
						// 不可恢复）。明确报错，避免上层出现莫名其妙的 JSON 解析错误。
						if (data.includes('\uFFFD')) {
							throw new Error('响应为不可解码的压缩数据（请反馈此提示）');
						}
						data = new TextEncoder().encode(data);
					}
				} else if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
					// Node Buffer 形状（JSBridge 序列化）
					data = new Uint8Array(data.data);
				} else if (data instanceof ArrayBuffer) {
					data = new Uint8Array(data);
				} else if (ArrayBuffer.isView(data)) {
					data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
				} else if (data && typeof data === 'object') {
					// CapacitorHttp 在响应 Content-Type 为 application/json 时会无视
					// responseType，直接把响应解析成对象（Android HttpRequestHandler.readData
					// 的行为，GitHub API 等接口会命中）→ 序列化回 JSON 文本交给上层解析
					try {
						data = new TextEncoder().encode(JSON.stringify(data));
					} catch {
						data = new Uint8Array(0);
					}
				} else {
					data = new Uint8Array(0);
				}
				data = await maybeDecompress(data);
				const finalUrl = res.url || url;
				const contentType = res.headers?.['content-type'] || res.headers?.['Content-Type'] || '';
				return { bytes: data, finalUrl, contentType, status: res.status };
			} catch (e) {
				if (signal?.aborted) throw signal.reason;
				throw new Error(`网络请求失败: ${e.message || e}`);
			}
		}
	}

	// 浏览器 / Node: fetch
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal?.addEventListener('abort', abort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeout);
	const isBrowser = typeof window !== 'undefined';
	const useProxy = isBrowser && import.meta.env?.DEV;
	try {
		let fetchUrl = url;
		let fetchHeaders = { ...headers };
		if (useProxy) {
			// 经本地代理：UA/Referer 通过自定义头传递
			if (headers['User-Agent'] || headers['user-agent']) {
				fetchHeaders['x-zj-ua'] = headers['User-Agent'] || headers['user-agent'];
				delete fetchHeaders['User-Agent'];
				delete fetchHeaders['user-agent'];
			} else {
				fetchHeaders['x-zj-ua'] = DEFAULT_UA;
			}
			if (headers.Referer || headers['referer']) {
				fetchHeaders['x-zj-referer'] = headers.Referer || headers['referer'];
				delete fetchHeaders.Referer;
				delete fetchHeaders['referer'];
			}
			if (headers.Cookie || headers['cookie']) {
				fetchHeaders['x-zj-cookie'] = headers.Cookie || headers['cookie'];
				delete fetchHeaders.Cookie;
				delete fetchHeaders['cookie'];
			}
			fetchUrl = proxiedUrl(url);
		}

		const res = await fetch(fetchUrl, {
			method: method.toUpperCase(),
			headers: fetchHeaders,
			body,
			redirect: 'follow',
			signal: controller.signal
		});
		const buf = await res.arrayBuffer();
		const bytes = await maybeDecompress(new Uint8Array(buf));
		// 代理模式下从响应头取最终 URL
		const finalUrl = useProxy
			? res.headers.get('X-Zj-Final-Url') || url
			: res.url || url;
		return {
			bytes,
			finalUrl,
			contentType: res.headers.get('content-type') || '',
			status: res.status
		};
	} catch (e) {
		if (signal?.aborted) throw signal.reason;
		throw new Error(`网络请求失败: ${e.name === 'AbortError' ? '超时' : e.message}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', abort);
	}
}

/** 编码名归一化 */
export function normalizeCharset(cs) {
	if (!cs) return null;
	const c = String(cs).toLowerCase().trim();
	if (c === 'gb2312' || c === 'gbk' || c === 'gb18030' || c === 'x-gbk') return 'gb18030';
	if (c === 'utf8' || c === 'utf-8') return 'utf-8';
	if (c === 'big5' || c === 'big5-hkscs' || c === 'cp950') return 'big5';
	return c;
}

/** 从字节流检测编码（BOM → meta → 无） */
export function sniffCharset(bytes, contentType = '') {
	// BOM
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';

	// Content-Type 头
	const ctm = contentType.match(/charset\s*=\s*["']?([\w-]+)/i);
	if (ctm) return normalizeCharset(ctm[1]);

	// HTML meta（前 4KB，ASCII 扫描）
	const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 4096));
	const m = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) || head.match(/charset\s*=\s*["']?([\w-]+)/i);
	if (m) return normalizeCharset(m[1]);

	return null;
}

/** 用指定编码解码（不可用时降级 utf-8 不抛错） */
export function decodeBytes(bytes, charset) {
	try {
		return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(bytes);
	} catch {
		return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	}
}

/** 乱码检测：U+FFFD 替换符比例 */
function replacementRatio(text) {
	if (!text.length) return 0;
	let count = 0;
	const n = Math.min(text.length, 4000);
	for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 0xfffd) count++;
	return count / n;
}

/** 高频汉字（正常中文文本特征），用于乱码对比评分 */
const COMMON_CJK =
	'的一是不了在人有这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克';

export function textScore(text) {
	const n = Math.min(text.length, 3000);
	if (!n) return 0;
	let s = 0;
	for (let i = 0; i < n; i++) {
		if (COMMON_CJK.includes(text[i])) s++;
	}
	return s / n;
}

// ============ 反转码修复（服务端双重编码 mojibake） ============

let _gbkMap = null;

/** 构建"字符 → GBK 字节对"映射（一次性，运行时生成） */
function getGbkEncodeMap() {
	if (_gbkMap) return _gbkMap;
	_gbkMap = new Map();
	try {
		const pairList = [];
		for (let hi = 0x81; hi <= 0xfe; hi++) {
			for (let lo = 0x40; lo <= 0xfe; lo++) {
				if (lo === 0x7f) continue;
				pairList.push(hi, lo);
			}
		}
		const buf = new Uint8Array(pairList);
		const decoded = new TextDecoder('gbk', { fatal: false }).decode(buf);
		let idx = 0;
		for (let hi = 0x81; hi <= 0xfe; hi++) {
			for (let lo = 0x40; lo <= 0xfe; lo++) {
				if (lo === 0x7f) continue;
				const ch = decoded[idx++];
				if (ch && ch !== '\uFFFD' && !_gbkMap.has(ch)) {
					_gbkMap.set(ch, [hi, lo]);
				}
			}
		}
	} catch { /* 环境不支持 gbk 时放弃 */ }
	return _gbkMap;
}

/** 文本 → GBK 字节（无映射字符用 UTF-8 字节保底） */
function gbkEncodeLossy(text) {
	const map = getGbkEncodeMap();
	const out = [];
	for (const ch of text) {
		const code = ch.codePointAt(0);
		if (code < 0x80) {
			out.push(code);
			continue;
		}
		const pair = map.get(ch);
		if (pair) {
			out.push(pair[0], pair[1]);
		} else {
			const utf8 = new TextEncoder().encode(ch);
			for (const b of utf8) out.push(b);
		}
	}
	return new Uint8Array(out);
}

/**
 * 尝试修复 mojibake：GBK_encode(text) → UTF-8_decode
 * 若修复后"更像正常中文文本"则采用
 */
export function tryFixMojibake(text) {
	if (!text || text.length < 8) return text;
	const before = textScore(text);
	if (before > 0.02) return text; // 已是正常文本
	try {
		const bytes = gbkEncodeLossy(text);
		const fixed = decodeBytes(bytes, 'utf-8');
		const after = textScore(fixed);
		if (after > Math.max(before * 2.5, 0.015)) {
			// 清理不可逆损伤产生的替换符（显示为 � 反而更碍眼）
			return cleanReplacementChars(fixed);
		}
	} catch { /* ignore */ }
	return text;
}

/** 清理替换符（U+FFFD）：源数据字节丢失的痕迹，直接移除让文本更干净 */
function cleanReplacementChars(s) {
	if (!s.includes('\uFFFD')) return s;
	const cleaned = s.replace(/\uFFFD+/g, '');
	// 若清理后几乎为空（损伤过重），仍返回清理结果但至少保留空白结构
	return cleaned;
}

/**
 * 请求并解码为文本（多候选编码对比，选"最像正常文本"的；含 mojibake 修复）
 * @param {object} opts { method, body, headers, charset, timeout }
 * @returns {Promise<{text, finalUrl, charset, status}>}
 */
export async function requestText(url, opts = {}) {
	const { charset, ...rest } = opts;
	const { bytes, finalUrl, contentType, status } = await requestBytes(url, rest);

	// 候选编码：显式 > 嗅探 > 兜底双雄
	const candidates = [];
	if (charset) candidates.push(normalizeCharset(charset));
	const sniffed = sniffCharset(bytes, contentType);
	if (sniffed) candidates.push(sniffed);
	candidates.push('utf-8', 'gb18030');

	let best = null;
	for (const cs of [...new Set(candidates)]) {
		if (!cs) continue;
		const text = decodeBytes(bytes, cs);
		const bad = replacementRatio(text);
		if (bad > 0.05) continue; // 超过 5% 坏字符才淘汰
		const score = textScore(text) - bad * 5;
		if (!best || score > best.score) best = { text, charset: cs, score };
	}
	if (best) {
		return { text: tryFixMojibake(best.text), finalUrl, charset: best.charset, status };
	}

	// 全部失败：UTF-8 尽最大努力
	return { text: tryFixMojibake(decodeBytes(bytes, 'utf-8')), finalUrl, charset: 'utf-8', status };
}

/** 构造 form 请求体 */
export function buildFormBody(pairs) {
	return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** 从 URL 取 origin（Referer 用） */
export function originOf(url) {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host}`;
	} catch {
		return url;
	}
}

/** 延迟 */
export function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/** 随机间隔 */
export function randomInterval(min = 200, max = 600) {
	return Math.floor(min + Math.random() * (max - min));
}
