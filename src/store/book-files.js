/**
 * 本地书文件云同步（WebDAV）
 *
 * 为什么选 WebDAV（而不是自建服务器 / 对象存储 / GitHub）：
 *  - 国内速度快：坚果云 WebDAV 走国内节点，10MB 的 EPUB 通常几秒传完
 *  - 免费额度够用：坚果云免费版每月 1GB 上传流量（约 100 本 EPUB）
 *  - 零运维：不用买 VPS、不用装服务端；Nextcloud / AList / 雨云自建也都能用
 *
 * 同步的是**原始文件本身**，不是解析后的文本：
 *  - 另一台设备下载同一个文件再解析，章节结构、插图与两端完全一致
 *  - 以 SHA-256 内容哈希命名，天然去重；重复导入/换设备不会重复上传
 *  - 书籍元数据（哈希/文件名/大小）随进度快照走 GitHub Gist，文件走 WebDAV
 */
import { requestBytes } from '../core/http.js';
import {
	getBooks, updateBook, addBook, saveToc, saveChapters,
	saveBookFile, getBookFile, hasBookFile
} from './db.js';
import { parseBookFile } from '../core/importer.js';

const CFG_KEY = 'zj-files-v1';
const DEFAULTS = { enabled: false, url: 'https://dav.jianguoyun.com/dav/', user: '', pass: '' };

/** 坚果云 WebDAV 地址（预填；其它服务可自行修改） */
export const JIANGUOYUN_DAV = 'https://dav.jianguoyun.com/dav/';

export function loadFileSyncConfig() {
	try {
		const raw = localStorage.getItem(CFG_KEY);
		return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveFileSyncConfig(patch) {
	const next = { ...loadFileSyncConfig(), ...patch };
	try { localStorage.setItem(CFG_KEY, JSON.stringify(next)); } catch { /* ignore */ }
	return next;
}

export function isFileSyncEnabled() {
	const c = loadFileSyncConfig();
	return !!(c.enabled && c.url && c.user && c.pass);
}

// ---------- 哈希与文件命名 ----------

/** 56 位非加密哈希（crypto.subtle 不可用时的兜底，仅用于去重标识） */
function fallbackHash(bytes) {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < bytes.length; i++) {
		const ch = bytes[i];
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** SHA-256（十六进制）；WebView 非安全上下文时退化为内容哈希 */
export async function sha256Hex(input) {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	try {
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	} catch {
		return fallbackHash(bytes);
	}
}

/** 安全的文件名（保留中文/字母数字，扩展名保留） */
function safeFileName(name) {
	const raw = String(name || 'book.epub');
	const m = raw.match(/\.[a-z0-9]{1,5}$/i);
	const ext = (m ? m[0] : '.epub').toLowerCase();
	const base = (m ? raw.slice(0, -m[0].length) : raw)
		.replace(/[\s\u3000]+/g, '_')
		.replace(/[^\p{L}\p{N}._-]+/gu, '')
		.slice(0, 60) || 'book';
	return `${base}${ext}`;
}

/**
 * 云端文件名：zhijian- 前缀 + 内容哈希前 16 位 + 原名。
 * 统一放在 WebDAV 根目录而不是子目录：Android 的 HttpURLConnection 不接受
 * MKCOL / PROPFIND 这类非标准方法（会抛 ProtocolException），建目录不可靠；
 * 用前缀命名既不建目录、又能把所有书归在一起，同名同内容天然去重。
 */
export function remoteNameFor(hash, fileName) {
	return `zhijian-${String(hash || '').slice(0, 16)}-${safeFileName(fileName)}`;
}

// ---------- WebDAV 客户端 ----------

function basicAuth(user, pass) {
	const bytes = new TextEncoder().encode(`${user}:${pass}`);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return `Basic ${btoa(bin)}`;
}

function davUrl(cfg, path) {
	const base = String(cfg.url || '').trim().replace(/\/+$/, '');
	const segs = String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
	return `${base}/${segs}`;
}

async function davRequest(cfg, method, path, { body = null, headers = {} } = {}) {
	return requestBytes(davUrl(cfg, path), {
		method,
		body,
		headers: { Authorization: basicAuth(cfg.user, cfg.pass), ...headers },
		timeout: 60000
	});
}

async function davPut(cfg, name, bytes) {
	const r = await davRequest(cfg, 'PUT', name, {
		body: bytes,
		headers: { 'Content-Type': 'application/octet-stream' }
	});
	if (r.status === 401) throw new Error('账号或密码不正确');
	if (r.status === 403) throw new Error('网盘无写入权限');
	if (r.status && (r.status < 200 || r.status >= 300)) throw new Error(`上传失败（HTTP ${r.status}）`);
}

/**
 * 测试连接：PUT 一个探针文件再删除（只用标准方法，Android 全兼容）。
 * 能区分「账号密码错」与「网络/服务不可达」。
 */
export async function testFileSyncConnection() {
	const cfg = loadFileSyncConfig();
	if (!cfg.url || !cfg.user || !cfg.pass) throw new Error('请先填写地址、账号和密码');
	const probe = `zhijian-probe-${Date.now()}.txt`;
	const r = await davRequest(cfg, 'PUT', probe, {
		body: new TextEncoder().encode('zhijian webdav probe'),
		headers: { 'Content-Type': 'text/plain' }
	});
	if (r.status === 401) throw new Error('账号或密码不正确（坚果云需使用「应用密码」）');
	if (r.status === 403) throw new Error('账号无写入权限');
	if (r.status >= 400) throw new Error(`连接失败（HTTP ${r.status}）`);
	await davRequest(cfg, 'DELETE', probe).catch(() => { /* 清理失败不影响结论 */ });
	return true;
}

async function davGet(cfg, name) {
	const r = await davRequest(cfg, 'GET', name);
	if (r.status === 404) throw new Error('云端没有这个文件');
	if (r.status && r.status >= 400) throw new Error(`下载失败（HTTP ${r.status}）`);
	return r.bytes || new Uint8Array(0);
}

// ---------- 导入 / 上传 / 下载 ----------

/** 与书架一致的封面色（避免依赖 UI 模块） */
function localGradient(str) {
	let h = 0;
	for (let i = 0; i < String(str || '').length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360;
	return `linear-gradient(145deg, hsl(${h} 24% 34%), hsl(${(h + 40) % 360} 30% 22%))`;
}

/** 把解析结果写入书架（本地导入 / 云端下载共用） */
async function importParsedBook({ parsed, name, hash, remoteName, size }) {
	const total = parsed.chapters.length;
	const book = {
		id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
		title: parsed.title || String(name).replace(/\.[^.]+$/, ''),
		author: parsed.author || '',
		coverStyle: localGradient(parsed.title || name),
		sourceId: 'local',
		sourceName: '本地导入',
		bookUrl: '',
		tocUrl: '',
		totalChapters: total,
		cachedChapters: total,
		addedAt: Date.now(),
		lastReadAt: 0,
		fileHash: hash || '',
		fileName: name || '',
		fileSize: size || 0,
		fileRemoteName: remoteName || '',
		fileUploadedAt: remoteName ? Date.now() : 0 // 来自云端 → 无需再上传
	};
	const saved = await addBook(book);
	const realId = saved?.id || book.id;
	await saveToc(realId, parsed.chapters.map((c) => ({ title: c.title, url: '' })));
	const list = parsed.chapters.map((c, idx) => ({
		idx,
		title: c.title,
		paragraphs: c.paragraphs,
		url: '',
		totalChars: (c.paragraphs || []).join('').length
	}));
	for (let i = 0; i < list.length; i += 80) {
		await saveChapters(realId, list.slice(i, i + 80));
	}
	return saved;
}

/** 导入时记住原始文件（供跨设备同步；失败不影响导入本身） */
export async function rememberImportedFile(book, { bytes, fileName }) {
	try {
		const hash = await sha256Hex(bytes);
		const remoteName = remoteNameFor(hash, fileName || book?.title);
		await saveBookFile(hash, bytes, { name: fileName });
		await updateBook(book.id, {
			fileHash: hash,
			fileName: fileName || '',
			fileSize: bytes.byteLength ?? bytes.length ?? 0,
			fileRemoteName: remoteName,
			fileUploadedAt: 0
		});
		return { hash, remoteName };
	} catch {
		return null;
	}
}

/** 上传一本书的原始文件（已上传则跳过） */
export async function uploadLocalBookFile(book, { force = false } = {}) {
	const cfg = loadFileSyncConfig();
	if (!isFileSyncEnabled() || !book?.fileHash) return false;
	if (!force && book.fileUploadedAt) return true;
	const rec = await getBookFile(book.fileHash);
	if (!rec) return false;
	const name = book.fileRemoteName || remoteNameFor(book.fileHash, book.fileName || book.title);
	await davPut(cfg, name, new Uint8Array(rec.bytes));
	await updateBook(book.id, { fileUploadedAt: Date.now(), fileRemoteName: name });
	return true;
}

/** 批量上传所有待同步的本地书 */
export async function uploadAllPending({ onProgress } = {}) {
	const cfg = loadFileSyncConfig();
	if (!isFileSyncEnabled()) return { uploaded: 0, failed: 0, skipped: 0, total: 0 };
	const locals = (await getBooks()).filter((b) => b.sourceId === 'local' && b.fileHash);
	const pending = locals.filter((b) => !b.fileUploadedAt);
	let uploaded = 0;
	let failed = 0;
	for (const b of pending) {
		try {
			onProgress?.(`正在上传《${b.title}》`, uploaded, pending.length);
			await uploadLocalBookFile(b, { force: true });
			uploaded++;
		} catch {
			failed++;
		}
	}
	return { uploaded, failed, skipped: locals.length - pending.length, total: locals.length };
}

/** 下载并导入云端本地书（items 来自同步快照的待下载列表） */
export async function downloadAndImport(items, { onProgress } = {}) {
	const cfg = loadFileSyncConfig();
	if (!isFileSyncEnabled()) return { downloaded: 0, failed: 0, total: 0 };
	const list = (items || []).filter((x) => x?.fileRemoteName);
	let downloaded = 0;
	let failed = 0;
	for (const it of list) {
		try {
			onProgress?.(`正在下载《${it.title || it.fileName || '本地书'}》`, downloaded, list.length);
			let buf = null;
			const cached = it.fileHash ? await getBookFile(it.fileHash) : null;
			if (cached?.bytes) {
				buf = cached.bytes;
			} else {
				const bytes = await davGet(cfg, it.fileRemoteName);
				if (!bytes.length) throw new Error('文件为空');
				buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
				if (it.fileHash) await saveBookFile(it.fileHash, bytes, { name: it.fileName || '' });
			}
			const name = it.fileName || `${it.title || '本地书'}.epub`;
			const parsed = parseBookFile(buf, name, typeof DOMParser !== 'undefined' ? DOMParser : undefined);
			if (!parsed?.chapters?.length) throw new Error('无法解析该书文件');
			await importParsedBook({
				parsed,
				name,
				hash: it.fileHash || '',
				remoteName: it.fileRemoteName,
				size: buf.byteLength
			});
			downloaded++;
		} catch {
			failed++;
		}
	}
	return { downloaded, failed, total: list.length };
}
