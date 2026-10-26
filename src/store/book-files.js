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
import { requestBytes, requestText } from '../core/http.js';
import {
	getBooks, getBook, updateBook, addBook, saveToc, saveChapters, saveComicChapters, getToc, getChapter,
	saveBookFile, getBookFile
} from './db.js';
import { parseBookFile } from '../core/importer.js';
import { buildEpubFromChapters, epubFileName } from '../core/epub-build.js';

const CFG_KEY = 'zj-files-v1';
/**
 * 云端目录名。
 * 坚果云不允许在 WebDAV 根目录直接创建文件（根目录 GET 返回 403、PUT 返回 404），
 * 必须先有一个文件夹再往里写——Zotero/legado 等应用也是这么做的。
 * 首次使用需要用户在坚果云网页版根目录新建同名文件夹。
 */
const DAV_FOLDER = 'zhijian';
const DEFAULTS = { enabled: false, url: 'https://dav.jianguoyun.com/dav/', user: '', pass: '' };

/** 坚果云 WebDAV 地址（预填；其它服务可自行修改） */
export const JIANGUOYUN_DAV = 'https://dav.jianguoyun.com/dav/';

/**
 * 规范化 WebDAV 地址：
 *  - 补协议 https://
 *  - 坚果云必须带 /dav 路径（只填 dav.jianguoyun.com 会 404）
 *  - 结尾补 /
 */
/** 去掉复制粘贴常见的不可见字符（零宽空格 / 方向符 / BOM / 全角空格 / 普通空白） */
export function stripInvisible(raw) {
	return String(raw ?? '')
		.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff\u3000]/g, '')
		.replace(/[\s\u00a0]+/g, '')
		.trim();
}

export function normalizeDavUrl(raw) {
	let u = stripInvisible(raw);
	if (!u) return '';
	if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
	try {
		const url = new URL(u);
		if (/^dav\.jianguoyun\.com$/i.test(url.hostname) && !/^\/dav(\/|$)/i.test(url.pathname)) {
			url.pathname = '/dav/';
		}
		if (!url.pathname.endsWith('/')) url.pathname += '/';
		return url.toString();
	} catch {
		return u;
	}
}

export function loadFileSyncConfig() {
	try {
		const raw = localStorage.getItem(CFG_KEY);
		const cfg = { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
		cfg.url = normalizeDavUrl(cfg.url || DEFAULTS.url) || DEFAULTS.url;
		return cfg;
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveFileSyncConfig(patch) {
	const next = { ...loadFileSyncConfig(), ...patch };
	if (patch.url !== undefined) next.url = normalizeDavUrl(patch.url);
	if (patch.user !== undefined) next.user = stripInvisible(patch.user);
	if (patch.pass !== undefined) next.pass = String(patch.pass ?? '').replace(/[\u200b-\u200f\ufeff]/g, '').trim();
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

const davPath = (name) => `${DAV_FOLDER}/${name}`;

async function davPut(cfg, name, bytes) {
	const r = await davRequest(cfg, 'PUT', davPath(name), {
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
	// 先尝试自动建目录（Android 的 HttpURLConnection 不支持 MKCOL，会失败并忽略）
	try { await davRequest(cfg, 'MKCOL', DAV_FOLDER); } catch { /* 忽略 */ }
	const probe = `zhijian-probe-${Date.now()}.txt`;
	const r = await davRequest(cfg, 'PUT', davPath(probe), {
		body: new TextEncoder().encode('zhijian webdav probe'),
		headers: { 'Content-Type': 'text/plain' }
	});
	if (r.status === 401) throw new Error('账号或密码不正确（坚果云需使用「应用密码」，不是登录密码）');
	if (r.status === 403) throw new Error('账号无写入权限');
	if (r.status === 404) {
		// 404 有两种可能：地址路径不对，或认证其实没通过（部分服务端不返回 401）。
		// 再探一次根目录，把结果一起告诉用户，便于定位。
		let rootStatus = '未知';
		try {
			const root = await davRequest(cfg, 'GET', '', {});
			rootStatus = root.status === 401 ? '401（账号/应用密码不正确）' : `HTTP ${root.status}`;
		} catch { rootStatus = '网络不可达'; }
		throw new Error(`坚果云不允许在根目录直接建文件（根目录探测：${rootStatus}）。请先在坚果云网页版 → 我的文件 → 新建文件夹「${DAV_FOLDER}」，然后再点重试（只需建一次）`);
	}
	if (r.status === 409) throw new Error('云端目录不存在（HTTP 409）');
	if (r.status >= 400) throw new Error(`连接失败（HTTP ${r.status}）：${cfg.url}`);
	// 读回校验：确认不只是"能写"，也确实能读
	const back = await davRequest(cfg, 'GET', davPath(probe));
	if (back.status >= 400) throw new Error(`写入成功但读回失败（HTTP ${back.status}）`);
	await davRequest(cfg, 'DELETE', davPath(probe)).catch(() => { /* 清理失败不影响结论 */ });
	return true;
}

async function davGet(cfg, name) {
	const r = await davRequest(cfg, 'GET', davPath(name));
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

/** 漫画总页数（书架展示与导入提示用） */
export function comicPageCount(parsed) {
	let n = 0;
	for (const ch of parsed?.chapters || []) n += ch.images?.length || 0;
	return n;
}

/**
 * 把解析结果写进章节表（文字 / 漫画共用）。
 * 漫画一章就是一组图片，单条记录可能有几十 MB，批次要小得多。
 */
export async function saveParsedChapters(bookId, parsed) {
	if (parsed.kind === 'comic') {
		// 漫画按页存：章节记录只放 w/h/mime，字节进 comicPages。
		// 一次只交 3 话给写入层，避免把整本书的图片数组同时压在内存里。
		const list = parsed.chapters.map((c, idx) => ({ idx, title: c.title, images: c.images, url: '' }));
		for (let i = 0; i < list.length; i += 3) {
			await saveComicChapters(bookId, list.slice(i, i + 3));
		}
		return list.length;
	}
	const list = parsed.chapters.map((c, idx) => ({
		idx,
		title: c.title,
		paragraphs: c.paragraphs,
		url: '',
		totalChars: (c.paragraphs || []).join('').length
	}));
	for (let i = 0; i < list.length; i += 80) {
		await saveChapters(bookId, list.slice(i, i + 80));
	}
	return list.length;
}

/** 把解析结果写入书架（本地导入 / 云端下载共用） */
async function importParsedBook({ parsed, name, hash, remoteName, size }) {
	const total = parsed.chapters.length;
	const isComic = parsed.kind === 'comic';
	const book = {
		id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
		title: parsed.title || String(name).replace(/\.[^.]+$/, ''),
		author: parsed.author || '',
		coverStyle: localGradient(parsed.title || name),
		sourceId: 'local',
		sourceName: '本地导入',
		kind: isComic ? 'comic' : '',
		bookUrl: '',
		tocUrl: '',
		totalChapters: total,
		totalPages: isComic ? comicPageCount(parsed) : 0,
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
	await saveParsedChapters(realId, parsed);
	return saved;
}

/** 从字节导入一本书（链接下载 / 云端下载共用），并记住原文件供同步 */
export async function importBookFromBytes(bytes, fileName) {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const buf = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
	const parsed = parseBookFile(buf, fileName, typeof DOMParser !== 'undefined' ? DOMParser : undefined);
	if (!parsed?.chapters?.length) throw new Error('无法解析这个文件');
	const saved = await importParsedBook({ parsed, name: fileName, hash: '', remoteName: '', size: buf.byteLength });
	await rememberImportedFile({ ...saved, id: saved.id }, { bytes: arr, fileName }).catch(() => {});
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
/**
 * 给"没有原文件"的旧本地书重建一个 EPUB（用已缓存的章节）
 * @returns {Promise<object|null>} 更新后的书籍记录
 */
async function rebuildLocalFile(book) {
	// 漫画无法用「缓存章节」重建成文件（原图已在章节里），只能提示重新导入
	if (book.kind === 'comic') return null;
	const toc = (await getToc(book.id)) || [];
	if (!toc.length) return null;
	const chapters = [];
	for (let i = 0; i < toc.length; i++) {
		const ch = await getChapter(book.id, i);
		if (ch?.paragraphs?.length) {
			chapters.push({ title: ch.title || toc[i]?.title || `第 ${i + 1} 章`, paragraphs: ch.paragraphs });
		}
	}
	if (!chapters.length) return null;
	const bytes = buildEpubFromChapters({ title: book.title, author: book.author, id: book.id, chapters });
	await rememberImportedFile(book, { bytes, fileName: epubFileName(book.title) });
	return getBook(book.id);
}

/**
 * 批量上传所有待同步的本地书。
 * 旧版本导入的书没有原文件 → 自动用已缓存章节重新打包成 EPUB 再上传。
 * @returns {{uploaded:number, failed:number, skipped:number, total:number, missing:string[]}}
 */
export async function uploadAllPending({ onProgress } = {}) {
	const cfg = loadFileSyncConfig();
	if (!isFileSyncEnabled()) return { uploaded: 0, failed: 0, skipped: 0, total: 0, missing: [] };
	const locals = (await getBooks()).filter((b) => b.sourceId === 'local');
	const pending = locals.filter((b) => !b.fileUploadedAt);
	let uploaded = 0;
	let failed = 0;
	const missing = [];
	for (const raw of pending) {
		let b = raw;
		try {
			// 旧版本导入的书没有原文件 → 先打包成 EPUB
			if (!b.fileHash) {
				onProgress?.(`正在打包《${b.title}》`, uploaded, pending.length);
				const rebuilt = await rebuildLocalFile(b);
				if (!rebuilt?.fileHash) { missing.push(b.title || '未命名'); continue; }
				b = rebuilt;
			}
			onProgress?.(`正在上传《${b.title}》`, uploaded, pending.length);
			await uploadLocalBookFile(b, { force: true });
			uploaded++;
		} catch {
			failed++;
		}
	}
	return { uploaded, failed, skipped: locals.length - pending.length, total: locals.length, missing };
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


// ---------- JSON 快照读写（跨设备同步走坚果云时用）----------

/** 读取云端 JSON 文本（不存在返回 null） */
export async function davReadText(name) {
	const cfg = loadFileSyncConfig();
	if (!isFileSyncEnabled()) throw new Error('坚果云同步未配置');
	const r = await requestText(davUrl(cfg, davPath(name)), {
		headers: { Authorization: basicAuth(cfg.user, cfg.pass) },
		timeout: 30000
	});
	if (r.status === 404) return null;
	if (r.status === 401) throw new Error('坚果云账号或应用密码不正确');
	if (r.status >= 400) throw new Error(`云端读取失败（HTTP ${r.status}）`);
	return r.text;
}

/** 写入云端 JSON 文本 */
export async function davWriteText(name, text) {
	const cfg = loadFileSyncConfig();
	if (!isFileSyncEnabled()) throw new Error('坚果云同步未配置');
	const r = await requestText(davUrl(cfg, davPath(name)), {
		method: 'PUT',
		body: text,
		headers: {
			Authorization: basicAuth(cfg.user, cfg.pass),
			'Content-Type': 'application/json; charset=utf-8'
		},
		timeout: 30000
	});
	if (r.status === 401) throw new Error('坚果云账号或应用密码不正确');
	if (r.status >= 400) throw new Error(`云端写入失败（HTTP ${r.status}）`);
}
