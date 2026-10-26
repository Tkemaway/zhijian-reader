/**
 * 番茄小说 App 协议源（实验性）
 *
 * 通过仿真字节 App 的请求签名（X-Argus / X-Ladon）+ 设备参数直连官方 API：
 *   搜索 / 目录 / 正文（CM 通道 + DH 密钥交换 + AES 解密）
 * 签名与解密逻辑为开源书源的内嵌 jsLib（原样引用），本文件提供其运行所需的
 * java.* API 在 Web 环境下的等价实现。
 *
 * 注意：属于实验性能力——基于逆向协议，官方接口变更时需更新 fanqie-jslib-source.js。
 */
import md5 from 'js-md5';
import { sha512 } from 'js-sha512';
import aesjs from 'aes-js';
import { gzipSync, gunzipSync } from 'fflate';
import JSLIB_SOURCE from './fanqie-jslib-source.js';
import { requestBytes } from './http.js';

const FQ_FIXED_POOL = '2884201529849104,2884201529849104,,|2884201529849104,2884201529849104,,'; // 兜底设备×2（满足 FQ_ensure 的补位逻辑，避免触发设备注册）

const BASE_PARAMS = 'ac=wifi&channel=xiaomi_1967_64&aid=1967&app_name=novelapp&version_code=65132&version_name=6.5.1.32&device_platform=android&os=android&ssmix=a&device_type=FRD-AL10&device_brand=honor&language=zh&os_api=28&os_version=9&manifest_version_code=65132&resolution=1080*1920&dpi=480&update_version_code=65132&pv_player=65132&need_personal_recommend=1&player_so_load=1&is_android_pad_screen=0&host_abi=arm64-v8a&dragon_device_type=phone&compliance_status=0';

// ============================================================
//  确定性随机源（重放一致性）
//  同步的 jsLib 需要"预取重放"才能跑在异步网络层上：
//  每轮重放用同一随机种子，保证生成的请求参数完全一致，
//  从而能安全复用上一轮预取的响应（DH 密钥等不会错配）。
// ============================================================

let _rng = 0x9e3779b9;
function seedRng(s = 0x9e3779b9) { _rng = (s >>> 0) || 1; }
function rngNext() {
	let x = _rng;
	x ^= x << 13; x >>>= 0;
	x ^= x >>> 17;
	x ^= x << 5; x >>>= 0;
	_rng = x || 1;
	return _rng;
}
function rngBytes(n) {
	const u = new Uint8Array(n);
	for (let i = 0; i < n; i++) u[i] = rngNext() & 0xff;
	return u;
}
function rngUUID() {
	const b = rngBytes(16);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// 注入给 jsLib 的 Math（random 确定性化）
const fqMath = Object.create(null);
for (const k of Object.getOwnPropertyNames(Math)) fqMath[k] = Math[k];
fqMath.random = () => rngNext() / 0x100000000;

// ============================================================
//  字节工具（Uint8Array 世界）
// ============================================================

const _textEnc = new TextEncoder();
const _textDec = new TextDecoder('utf-8');

function latin1ToBytes(s) {
	const u = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
	return u;
}

function bytesToLatin1(b) {
	const arr = b instanceof Uint8Array ? b : new Uint8Array(b);
	let s = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < arr.length; i += CHUNK) s += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
	return s;
}

function bytesToB64(b) {
	const arr = b instanceof Uint8Array ? b : new Uint8Array(b);
	let bin = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < arr.length; i += CHUNK) bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
	return btoa(bin);
}

function b64ToBytes(s) {
	const bin = atob(String(s));
	const u = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
	return u;
}

function concatBytes(...arrs) {
	const total = arrs.reduce((n, a) => n + a.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const a of arrs) { out.set(a, off); off += a.length; }
	return out;
}

function utf8ToBytes(s) { return _textEnc.encode(s); }
function bytesToUtf8(b) { return _textDec.decode(b instanceof Uint8Array ? b : new Uint8Array(b)); }

function hexToBytes(hex) {
	const out = new Uint8Array(hex.length >> 1);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
	return out;
}

// ============================================================
//  同步 HTTP 桥接（预取重放）
//  jsLib 是同步范式（java.ajax / openConnection），而真机必须走
//  Capacitor 原生请求（绕过 CORS）。做法：
//   第一次运行：请求处记录参数并抛出 FQ_NEED_HTTP → 上层异步预取响应
//   重放运行：按序从缓存返回响应（随机种子复位，请求参数一致）
// ============================================================

const _replay = { queue: [], cache: [], pos: 0, active: false };

const FQ_NEED_HTTP = 'FQ_NEED_HTTP';

function httpSync(method, url, headers, body) {
	if (_replay.active && _replay.pos < _replay.cache.length) {
		return _replay.cache[_replay.pos++];
	}
	_replay.queue.push({ method, url, headers, body });
	const e = new Error(FQ_NEED_HTTP);
	e.code = FQ_NEED_HTTP;
	throw e;
}

async function fetchOnce(req) {
	const bodyBytes = req.body && req.body.length ? req.body : null;
	const headers = { ...(req.headers || {}) };
	// 一律要求明文响应（identity），不允许任何压缩：
	//  1) 手动设置 Accept-Encoding 会关闭 Android HttpURLConnection 的透明解压；
	//  2) 而 CapacitorHttp 对 application/json 响应会无视 responseType，直接把原始流
	//     按文本读取（parseJSON 失败时还把乱码字符串原样返回）——压缩二进制一旦走这条
	//     通道就变成不可恢复的乱码（表现为 "Unexpected token '�' ... is not valid JSON"）。
	// identity 从源头杜绝（顺带避免 br 在渲染层无法解压的问题）。
	for (const k of Object.keys(headers)) {
		if (k.toLowerCase() === 'accept-encoding') delete headers[k];
	}
	headers['Accept-Encoding'] = 'identity';
	const r = await requestBytes(req.url, {
		method: req.method || 'GET',
		headers,
		body: bodyBytes,
		timeout: 25000
	});
	// HTTP 错误透明化（否则 jsLib 会在 JSON 解析处吞掉真实错误）
	if (r.status >= 400) {
		let preview = '';
		try {
			preview = new TextDecoder('utf-8').decode((r.bytes || new Uint8Array(0)).slice(0, 150)).replace(/\s+/g, ' ').trim();
		} catch { /* ignore */ }
		throw new Error(`接口返回 HTTP ${r.status}${preview ? '：' + preview : ''}`);
	}
	let bytes = r.bytes || new Uint8Array(0);
	// 兜底：服务端无视 identity 仍返回 gzip 时手动解压（魔数 1f 8b）
	if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
		try { bytes = gunzipSync(bytes); } catch { /* 保留原样 */ }
	}
	return { status: r.status ?? 0, body: bytes };
}

/** 运行 jsLib 操作（自动预取重放直到完成） */
async function runFq(runner) {
	const cache = [];
	for (let round = 0; round < 8; round++) {
		seedRng(0x5f3759df);
		_replay.cache = cache;
		_replay.pos = 0;
		_replay.queue = [];
		_replay.active = cache.length > 0;
		try {
			return runner();
		} catch (e) {
			if (e?.code !== FQ_NEED_HTTP || !_replay.queue.length) throw e;
			for (const req of _replay.queue) {
				cache.push(await fetchOnce(req));
			}
		}
	}
	throw new Error('番茄请求重放轮次超限');
}

// ============================================================
//  java.* API 模拟（jsLib 运行环境）
// ============================================================

class BigIntegerShim {
	constructor(a, b) {
		if (typeof a === 'number' && typeof b === 'number') {
			// new BigInteger(bitLength, random)
			const bytes = rngBytes(Math.ceil(a / 8));
			this.v = BigInt('0x' + [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('') || '0');
		} else if (typeof a === 'string') {
			this.v = b === 16 ? BigInt('0x' + a) : BigInt(a);
		} else {
			this.v = BigInt(a ?? 0);
		}
	}
	static _from(v) { const o = Object.create(BigIntegerShim.prototype); o.v = v; return o; }
	mod(m) { return BigIntegerShim._from(this.v % m.v); }
	add(o) { return BigIntegerShim._from(this.v + o.v); }
	subtract(o) { return BigIntegerShim._from(this.v - o.v); }
	modPow(e, m) {
		let base = this.v % m.v, exp = e.v, result = 1n;
		while (exp > 0n) {
			if (exp & 1n) result = (result * base) % m.v;
			base = (base * base) % m.v;
			exp >>= 1n;
		}
		return BigIntegerShim._from(result);
	}
	toString(radix) { return this.v.toString(radix || 10); }
	static valueOf(n) { return BigIntegerShim._from(BigInt(n)); }
}
BigIntegerShim.ONE = BigIntegerShim._from(1n);

class MessageDigestShim {
	constructor(alg) {
		this.alg = String(alg).toUpperCase();
		if (this.alg === 'MD5') this.h = md5.create();
		else if (this.alg === 'SHA-512') this.h = sha512.create();
		else throw new Error('不支持的哈希算法: ' + alg);
	}
	static getInstance(alg) { return new MessageDigestShim(alg); }
	update(b) {
		const arr = b instanceof Uint8Array ? b : latin1ToBytes(String(b));
		this.h.update(arr);
		return this;
	}
	digest() { return Uint8Array.from(this.h.array()); }
}

class CipherShim {
	static ENCRYPT_MODE = 1;
	static DECRYPT_MODE = 2;
	static getInstance(alg) { return new CipherShim(alg); }
	constructor(alg) { this.usePadding = !/NoPadding/i.test(String(alg || '')); }
	init(mode, keySpec, ivSpec) {
		this.mode = mode;
		this.key = keySpec.key instanceof Uint8Array ? keySpec.key : new Uint8Array(keySpec.key);
		this.iv = (ivSpec && ivSpec.iv) ? (ivSpec.iv instanceof Uint8Array ? ivSpec.iv : new Uint8Array(ivSpec.iv)) : new Uint8Array(16);
	}
	doFinal(data) {
		const buf = data instanceof Uint8Array ? data : latin1ToBytes(String(data));
		const cbc = new aesjs.ModeOfOperation.cbc(this.key, this.iv);
		if (this.mode === CipherShim.ENCRYPT_MODE) {
			const input = this.usePadding ? aesjs.padding.pkcs7.pad(buf) : buf;
			return cbc.encrypt(input);
		}
		const out = cbc.decrypt(buf);
		return this.usePadding ? aesjs.padding.pkcs7.strip(out) : out;
	}
}

class ByteArrayOutputStreamShim {
	constructor() { this.chunks = []; }
	write(b, off, len) {
		if (typeof b === 'number') { this.chunks.push(new Uint8Array([b & 0xff])); return; }
		const arr = b instanceof Uint8Array ? b : new Uint8Array(b);
		this.chunks.push((off !== undefined && len !== undefined) ? arr.subarray(off, off + len) : arr);
	}
	toByteArray() { return concatBytes(...this.chunks); }
	close() {}
	flush() {}
}

class GZIPOutputStreamShim {
	constructor(out) { this.out = out; this.chunks = []; }
	write(b, off, len) {
		const arr = b instanceof Uint8Array ? b : new Uint8Array(b);
		this.chunks.push((off !== undefined && len !== undefined) ? arr.subarray(off, off + len) : arr);
	}
	close() { this.out.write(gzipSync(concatBytes(...this.chunks))); }
	finish() { this.close(); }
	flush() {}
}

class InputStreamShim {
	constructor(buf) { this.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf || 0); }
	_readAll() { return bytesToUtf8(this.buf); }
	_readAllBuf() { return this.buf; }
}

class GZIPInputStreamShim {
	constructor(is) {
		const raw = is._readAllBuf ? is._readAllBuf() : new Uint8Array(0);
		try { this.data = gunzipSync(raw); } catch { this.data = raw; }
	}
	_readAll() { return bytesToUtf8(this.data); }
	_readAllBuf() { return this.data; }
}

class BufferedReaderShim {
	constructor(reader) {
		let text = '';
		try { text = reader._readAll(); } catch { text = ''; }
		this.lines = text.split(/\r?\n/);
		this.idx = 0;
	}
	readLine() { return this.idx < this.lines.length ? this.lines[this.idx++] : null; }
	close() {}
}

class InputStreamReaderShim {
	constructor(stream) { this.stream = stream; }
	_readAll() { return this.stream._readAll(); }
}

class HttpURLConnectionShim {
	constructor(url) { this.url = url; this.headers = {}; this.method = 'GET'; this.body = null; this._done = false; }
	setRequestMethod(m) { this.method = m; }
	setDoOutput() {}
	setDoInput() {}
	setRequestProperty(k, v) { this.headers[k] = v; }
	setConnectTimeout() {}
	setReadTimeout() {}
	getOutputStream() {
		const self = this;
		return {
			write(b, off, len) {
				const arr = b instanceof Uint8Array ? b : new Uint8Array(b);
				self.body = (off !== undefined && len !== undefined) ? arr.subarray(off, off + len) : arr;
			},
			close() {},
			flush() {}
		};
	}
	_send() {
		if (this._done) return;
		this._done = true;
		const r = httpSync(this.method, this.url, this.headers, this.body);
		this.code = r.status;
		this.resp = r.body;
	}
	getResponseCode() { this._send(); return this.code; }
	getInputStream() { this._send(); return new InputStreamShim(this.resp); }
	getErrorStream() { this._send(); return this.code >= 400 ? new InputStreamShim(this.resp) : null; }
	getHeaderField() { return null; }
	disconnect() {}
}

function makeJavaShim() {
	class JString {
		constructor(...args) {
			if (args.length >= 2 && args[1] && args[1].name) {
				this._s = bytesToLatin1(args[0] instanceof Uint8Array ? args[0] : new Uint8Array(args[0]));
			} else {
				this._s = args[0] == null ? '' : String(args[0]);
			}
		}
		toString() { return this._s; }
		valueOf() { return this._s; }
		getBytes() { return latin1ToBytes(this._s); }
		get length() { return this._s.length; }
		substring(a, b) { return this._s.substring(a, b); }
		charAt(i) { return this._s.charAt(i); }
	}

	const java = {
		lang: {
			String: JString,
			Integer: { parseInt: (s) => parseInt(s, 10), valueOf: (n) => n },
			StringBuilder: class { constructor() { this.p = []; } append(s) { this.p.push(s); return this; } toString() { return this.p.join(''); } }
		},
		nio: { charset: { Charset: { forName: (name) => ({ name, toString: () => name }) } } },
		security: {
			MessageDigest: MessageDigestShim,
			SecureRandom: class {
				generateSeed(n) { return rngBytes(n); }
				nextBytes(b) { b.set(rngBytes(b.length)); }
			}
		},
		util: {
			Base64: {
				getDecoder: () => ({ decode: (s) => b64ToBytes(String(s)) }),
				getEncoder: () => ({ encodeToString: (b) => bytesToB64(b), encode: (b) => bytesToB64(b) })
			},
			Arrays: { copyOfRange: (arr, from, to) => arr.slice(from, to) },
			UUID: { randomUUID: () => rngUUID() },
			zip: { GZIPInputStream: GZIPInputStreamShim, GZIPOutputStream: GZIPOutputStreamShim }
		},
		math: { BigInteger: BigIntegerShim },
		net: { URL: class { constructor(u) { this.u = u; } openConnection() { return new HttpURLConnectionShim(this.u); } } },
		io: { BufferedReader: BufferedReaderShim, InputStreamReader: InputStreamReaderShim, ByteArrayOutputStream: ByteArrayOutputStreamShim, InputStream: InputStreamShim },
		javax: {
			crypto: {
				Cipher: CipherShim,
				spec: {
					SecretKeySpec: class { constructor(key, alg) { this.key = key instanceof Uint8Array ? key : latin1ToBytes(String(key)); this.alg = alg; } },
					IvParameterSpec: class { constructor(iv) { this.iv = iv instanceof Uint8Array ? iv : latin1ToBytes(String(iv)); } }
				}
			}
		},
		ajax: (arg) => {
			// legado 同步 ajax："url,{options}"
			const i = arg.lastIndexOf(',{');
			const url = i > 0 ? arg.slice(0, i) : String(arg).split(',')[0];
			let headers = {};
			if (i > 0) {
				try { headers = JSON.parse(arg.slice(i + 1)).headers || {}; } catch { /* ignore */ }
			}
			const r = httpSync('GET', url, headers, null);
			return bytesToUtf8(r.body);
		}
	};
	return java;
}

// ============================================================
//  jsLib 运行器
// ============================================================

function makeSourceStore() {
	const KEY = 'zj-fqapp-';
	const mem = new Map(); // 内存兜底：localStorage 不可用（Node 测试/隐私模式）时仍能读写
	return {
		get(k) {
			try {
				const v = localStorage.getItem(KEY + k);
				if (v) return v;
			} catch { /* ignore */ }
			return mem.get(k) || '';
		},
		put(k, v) {
			mem.set(k, String(v));
			try { localStorage.setItem(KEY + k, String(v)); } catch { /* ignore */ }
		},
		set(k, v) { this.put(k, v); }
	};
}

let _fq = null;

function getFq() {
	if (_fq) return _fq;
	const java = makeJavaShim();
	const Packages = { java, javax: java.javax };
	const source = makeSourceStore();
	// 内嵌 jsLib 运行在同一作用域，暴露所需函数（注入确定性 Math）
	const factory = new Function(
		'java', 'Packages', 'source', 'Math',
		JSLIB_SOURCE + '\nreturn { search: FQ_search, api: FQ_api, cmGet: FQ_cmGet, ensure: FQ_ensure, getPool: FQ_getPool, registerOne: FQ_registerOne };'
	);
	const lib = factory(java, Packages, source, fqMath);
	_fq = { lib, java, source };
	return _fq;
}

/** 确保设备池可用（设备注册接口当前不可用，直接使用实测可用的兜底设备） */
function ensurePool() {
	const fq = getFq();
	let pool = fq.lib.getPool(fq.source);
	if (!pool.length) {
		fq.source.put('fqPool', FQ_FIXED_POOL);
		pool = fq.lib.getPool(fq.source);
	}
	return pool;
}

// ============================================================
//  对外能力：搜索 / 目录 / 正文
// ============================================================

// 官方搜索的固定参数（来自开源书源实现）
const SEARCH_Q_TAIL = '&offset=0&enterfrom_aid=&enter_from=inner_search&app_name=news_article&version_name=7.0.8&app_version=7.0.8&channel=tt_huawei2019_yz&version_code=708&device_platform=android&parent_enterfrom=novel_list&novel_host=&aid=13&scm_version=1.0.0.4112&device_type=25053RT47C&device_brand=Redmi&language=zh&os_api=35&os_version=15&openudid=0123456789abcdef&update_version_code=70899&plugin=0&tma_jssdk_version=1.10.0.0&rom_version=miui__os2.0.209.0.volcnxm';

function mapSearchItems(items) {
	return (items || []).map((it) => ({
		bookName: String(it.name || ''),
		author: it.author ? `作者：${it.author}` : '',
		bookUrl: String(it.bookUrl || ''),
		intro: String(it.intro || '').slice(0, 120),
		kind: String(it.kind || '')
	})).filter((x) => x.bookName && /page\/\d+/.test(x.bookUrl));
}

/** 搜索（官方域名 + 签名直连；异常或空结果时回退第三方反代） */
let _officialSearchBroken = false; // 官方搜索路径 404 后不再重试（会话级）
export async function fqAppSearch(keyword) {
	const kw = String(keyword || '');
	// 1. 官方接口（更稳定，不依赖第三方域名）
	if (!_officialSearchBroken) {
		try {
			const results = await runFq(() => {
				const fq = getFq();
				ensurePool();
				const q = 'q=' + encodeURIComponent(kw) + SEARCH_Q_TAIL;
				const raw = String(fq.lib.api(fq.java, fq.source, '/api/novel/channel/homepage/search/search/v1/', q, 'https://api5-normal-sinfonlineb.fqnovel.com', 13));
				let d;
				try { d = JSON.parse(raw); } catch { return []; }
				return mapSearchItems((d.data && d.data.ret_data) || []);
			});
			if (results.length) return results;
		} catch (e) {
			if (/HTTP 404/.test(e.message || '')) _officialSearchBroken = true;
		}
	}
	// 2. 回退：第三方反代（原始实现）
	return runFq(() => {
		const fq = getFq();
		const list = fq.lib.search(fq.source, kw, '1') || [];
		return mapSearchItems(list);
	});
}

/** 目录（返回 { title, author, chapters: [{title, url}] }） */
export async function fqAppToc(bookId) {
	return runFq(() => {
		const fq = getFq();
		ensurePool();
		const q = 'book_type=0&item_data_list_md5=&catalog_data_md5=&book_id=' + bookId + '&book_info_md5=&need_version=true&' + BASE_PARAMS;
		const raw = String(fq.lib.api(fq.java, fq.source, '/reading/bookapi/directory/all_items/v', q, undefined, 1967));
		let data;
		try { data = JSON.parse(raw); } catch { throw new Error('目录数据异常'); }
		const dd = data.data || {};
		const cats = dd.catalog_data || dd.item_data_list || [];
		const chapters = [];
		for (const c of cats) {
			const itemId = String(c.item_id || c.catalog_id || '');
			if (!itemId) continue;
			chapters.push({
				title: String(c.catalog_title || c.title || `第 ${chapters.length + 1} 章`),
				url: `https://fanqienovel.com/page/${bookId}#${itemId}`
			});
		}
		if (!chapters.length) throw new Error('目录为空（接口可能已变化）');
		return { title: '', author: '', chapters };
	});
}

/** 章节正文（返回段落数组；url 形如 …/page/{bookId}#{itemId}） */
export async function fqAppChapter(chapterUrl) {
	return runFq(() => {
		const mBook = String(chapterUrl).match(/page\/(\d+)/);
		const mItem = String(chapterUrl).match(/#(\d+)/);
		if (!mBook || !mItem) throw new Error('章节地址无效');
		const fq = getFq();
		const pool = ensurePool();
		const dev = pool[0].d;
		const iid = pool[0].i;
		const res = fq.lib.cmGet(fq.java, mBook[1], [mItem[1]], dev, iid);
		let content = res[mItem[1]];
		if (!content) throw new Error('正文获取失败（可稍后重试）');
		// 兼容两种返回：字符串或字节数组
		if (typeof content !== 'string') {
			try { content = bytesToUtf8(content instanceof Uint8Array ? content : new Uint8Array(content)); } catch { content = String(content); }
		}
		// 数字串形态（Uint8Array 被隐式转字符串）→ 还原
		if (/^\d+(,\d+)+$/.test(content.slice(0, 40))) {
			const nums = content.split(',').map(Number);
			content = bytesToUtf8(Uint8Array.from(nums));
		}
		// 提取段落（<p idx="N">…</p>）
		const paragraphs = [];
		const re = /<p[^>]*>([\s\S]*?)<\/p>/g;
		let pm;
		while ((pm = re.exec(content))) {
			const t = pm[1]
				.replace(/<[^>]+>/g, '')
				.replace(/[\u200b-\u200d\ufeff]/g, '')
				.replace(/&nbsp;/g, ' ')
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#x27;/g, "'")
				.trim();
			if (t) paragraphs.push(t);
		}
		if (!paragraphs.length) {
			// 兜底：无 <p> 标记时按行拆
			const text = content.replace(/<[^>]+>/g, '\n').replace(/\n{2,}/g, '\n').trim();
			text.split('\n').map((s) => s.trim()).filter(Boolean).forEach((s) => paragraphs.push(s));
		}
		return paragraphs;
	});
}
