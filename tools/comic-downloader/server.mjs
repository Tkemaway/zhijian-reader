#!/usr/bin/env node
/**
 * 纸间 · 本地漫画下载器
 *
 * 一个只跑在本机的网页界面（默认 http://127.0.0.1:8787）：
 *   - 书源模式：粘贴 Legado 漫画书源（JSON 或链接）→ 搜索 → 选书 → 下载全部/指定话
 *   - 链接模式：粘贴漫画页/目录页 → 自动识别图片与「第 N 话」→ 下载
 *   - 进度：话数、页数、速度、失败页、日志；完成后打包成 CBZ，纸间直接导入
 *
 * 复用 App 的书源引擎（搜索/目录/取图），不另写一套规则。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { DOMParser } from 'linkedom';

import { searchSource, fetchToc, fetchComicChapter, detectBlockPage } from '../../src/core/engine.js';
import { requestText, requestBytes } from '../../src/core/http.js';
import { parseSourceInput } from '../../src/core/custom-sources.js';
import { packComicFolder } from '../../scripts/pack-comic.mjs';
import { scanHtml, sanitizeSegment, pickTitle } from './scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_OUTPUT = path.join(os.homedir(), 'Downloads', '纸间漫画');
const IMAGE_CONCURRENCY = 5;
const MAX_JOBS_KEPT = 30;

const jobs = new Map();
const searches = new Map();
const queue = [];
let running = false;
const allowedRoots = new Set([path.resolve(DEFAULT_OUTPUT)]);

// ------------------------------------------------------------
//  工具
// ------------------------------------------------------------

function json(res, code, data) {
	const body = JSON.stringify(data);
	res.writeHead(code, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store'
	});
	res.end(body);
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > 4 * 1024 * 1024) {
				reject(new Error('请求过大'));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			try {
				const text = Buffer.concat(chunks).toString('utf8').trim();
				resolve(text ? JSON.parse(text) : {});
			} catch {
				reject(new Error('请求不是合法 JSON'));
			}
		});
		req.on('error', reject);
	});
}

function isPrivateHost(hostname) {
	// 测试用：允许访问本机模拟站点；正式运行绝不开
	if (process.env.ZJ_DL_ALLOW_LOCAL === '1') return false;
	const h = String(hostname || '').toLowerCase();
	if (!h || h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
	if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
	const m = h.match(/^172\.(\d+)\./);
	if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
	return false;
}

function safeHttpUrl(raw) {
	let u;
	try { u = new URL(String(raw)); } catch { return null; }
	if (!/^https?:$/.test(u.protocol)) return null;
	if (isPrivateHost(u.hostname)) return null;
	return u;
}

function log(job, line) {
	const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
	job.log.push(`[${t}] ${line}`);
	if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
}

function snapshot(job) {
	const { controller, _payload, ...rest } = job;
	const total = job.totalChapters || 0;
	const frac = job.chapterPages ? Math.min(1, job.currentPage / job.chapterPages) : 0;
	// 失败的话也算「处理过」，否则有失败页时进度永远到不了 100%
	const processed = job.doneChapters + job.failedChapters;
	const progress = total
		? Math.min(1, (processed + frac) / total)
		: null;
	const elapsed = ((job.finishedAt || Date.now()) - (job.startedAt || Date.now())) / 1000;
	return {
		...rest,
		log: job.log.slice(-40),
		progress,
		speed: elapsed > 0 ? Math.round(job.bytes / elapsed) : 0
	};
}

function notifyJob(job) {
	// 轮询模式，不需要推送；保留钩子便于以后改成 SSE
	void job;
}

// ------------------------------------------------------------
//  图片下载
// ------------------------------------------------------------

function looksLikeHtml(bytes) {
	if (!bytes?.length) return false;
	let i = 0;
	while (i < Math.min(bytes.length, 12) && [0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf].includes(bytes[i])) i++;
	return bytes[i] === 0x3c;
}

function extFromMime(mime, url) {
	const ct = String(mime || '').toLowerCase();
	if (ct.includes('png')) return 'png';
	if (ct.includes('webp')) return 'webp';
	if (ct.includes('gif')) return 'gif';
	if (ct.includes('avif')) return 'avif';
	if (ct.includes('bmp')) return 'bmp';
	const m = String(url || '').match(/\.([a-z0-9]+)(?:\?|#|$)/i);
	if (m) {
		const ext = m[1].toLowerCase();
		if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
	}
	return 'jpg';
}

async function downloadOneImage(url, filePath, referer, signal) {
	if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1024) return { skipped: true, bytes: 0 };
	const res = await requestBytes(url, {
		headers: referer ? { Referer: referer } : {},
		timeout: 30000,
		signal
	});
	if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
	if (!res.bytes?.length) throw new Error('空文件');
	if (looksLikeHtml(res.bytes)) throw new Error('返回的是网页（可能需要登录/防盗链）');
	const ext = extFromMime(res.contentType, url);
	const finalPath = ext === path.extname(filePath).slice(1) ? filePath : filePath.replace(/\.[^.]+$/, `.${ext}`);
	fs.mkdirSync(path.dirname(finalPath), { recursive: true });
	fs.writeFileSync(finalPath, res.bytes);
	return { skipped: false, bytes: res.bytes.length };
}

/**
 * 下载一话的所有图片
 * @returns {Promise<{ok:number, skipped:number, failed:number}>}
 */
async function downloadChapterImages(job, chapter, dir, referer, signal) {
	const urls = chapter.images || [];
	fs.mkdirSync(dir, { recursive: true });
	job.chapterPages = urls.length;
	job.currentPage = 0;

	let cursor = 0;
	const result = { ok: 0, skipped: 0, failed: 0 };
	const worker = async () => {
		for (;;) {
			if (signal.aborted) return;
			const i = cursor++;
			if (i >= urls.length) return;
			const base = path.join(dir, String(i + 1).padStart(3, '0'));
			try {
				const r = await downloadOneImage(urls[i], `${base}.jpg`, referer, signal);
				if (r.skipped) { result.skipped++; job.skippedPages++; }
				else { result.ok++; job.bytes += r.bytes; }
			} catch (e) {
				if (signal.aborted) return;
				result.failed++;
				job.failedPages++;
				if (job.failedPages <= 20) log(job, `第 ${i + 1} 页失败：${e.message || e}`);
			}
			job.currentPage++;
			notifyJob(job);
		}
	};
	await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, urls.length) }, worker));
	job.pages += result.ok + result.skipped;
	return result;
}

// ------------------------------------------------------------
//  多源聚合搜索
// ------------------------------------------------------------

const SEARCH_CONCURRENCY = 5;
const SEARCH_TIMEOUT = 12000;

function startSearch(sources, keyword) {
	const task = {
		id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
		keyword,
		total: sources.length,
		done: 0,
		status: 'running',
		results: [],
		stats: [],
		startedAt: Date.now(),
		finishedAt: 0
	};
	searches.set(task.id, task);
	// 只保留最近 10 次搜索
	if (searches.size > 10) {
		const oldest = [...searches.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
		if (oldest && oldest.status !== 'running') searches.delete(oldest.id);
	}
	runSearchTask(task, sources, keyword);
	return task;
}

async function searchOne(source, keyword) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ results: [], error: '超时', timedOut: true }), SEARCH_TIMEOUT);
	});
	try {
		const r = await Promise.race([searchSource(source, keyword, DOMParser), timeout]);
		return r || { results: [], error: '' };
	} catch (e) {
		return { results: [], error: e.message || String(e) };
	} finally {
		clearTimeout(timer);
	}
}

async function runSearchTask(task, sources, keyword) {
	const queue = [...sources];
	const worker = async () => {
		for (;;) {
			const source = queue.shift();
			if (!source) return;
			const started = Date.now();
			const r = await searchOne(source, keyword);
			const list = (r.results || []).map((item) => ({
				...item,
				sourceId: item.sourceId || source.id,
				sourceName: item.sourceName || source.name
			}));
			task.results.push(...list);
			task.stats.push({
				sourceId: source.id,
				name: source.name,
				count: list.length,
				error: r.error || '',
				ms: Date.now() - started
			});
			task.done++;
		}
	};
	await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, queue.length) }, worker));
	task.status = 'done';
	task.finishedAt = Date.now();
	setTimeout(() => {
		if (searches.get(task.id)?.status === 'done') searches.delete(task.id);
	}, 10 * 60 * 1000).unref?.();
}

// ------------------------------------------------------------
//  Job
// ------------------------------------------------------------

function enqueueJob(payload) {
	const job = {
		id: `j_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
		mode: payload.mode,
		title: payload.title || '未命名',
		status: 'queued',
		// 单页链接任务按 1 话算，进度条才是确定的；连续抓取时总数未知
		totalChapters: payload.chapters?.length || (payload.mode === 'url' && !payload.followNext ? 1 : 0),
		doneChapters: 0,
		failedChapters: 0,
		currentChapter: '',
		currentPage: 0,
		chapterPages: 0,
		pages: 0,
		failedPages: 0,
		skippedPages: 0,
		bytes: 0,
		output: '',
		cbz: '',
		error: '',
		log: [],
		createdAt: Date.now(),
		startedAt: 0,
		finishedAt: 0,
		_payload: payload
	};
	jobs.set(job.id, job);
	// 只保留最近 N 个任务
	if (jobs.size > MAX_JOBS_KEPT) {
		const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
		if (oldest && oldest.status !== 'running') jobs.delete(oldest.id);
	}
	if (payload.outputRoot) allowedRoots.add(path.resolve(payload.outputRoot));
	queue.push(job);
	pump();
	return job;
}

async function pump() {
	if (running) return;
	running = true;
	try {
		while (queue.length) {
			const job = queue.shift();
			if (job.status !== 'queued') continue;
			await runJob(job);
		}
	} finally {
		running = false;
	}
}

async function runJob(job) {
	job.status = 'running';
	job.startedAt = Date.now();
	const payload = job._payload;
	job.controller = new AbortController();
	const signal = job.controller.signal;
	log(job, `开始：${job.title}`);

	try {
		if (payload.mode === 'source') await runSourceJob(job, payload, signal);
		else await runUrlJob(job, payload, signal);
		if (job.cancelRequested) {
			job.status = 'cancelled';
			log(job, '已取消');
		} else {
			job.status = job.failedChapters && !job.pages ? 'error' : 'done';
			if (job.status === 'error') job.error = '所有话都下载失败，请检查书源或网络';
			log(job, `完成：${job.doneChapters} 话 / ${job.pages} 页${job.failedPages ? ` / ${job.failedPages} 页失败` : ''}`);
		}
	} catch (e) {
		if (job.cancelRequested || e.name === 'AbortError') {
			job.status = 'cancelled';
			log(job, '已取消');
		} else {
			job.status = 'error';
			job.error = e.message || String(e);
			log(job, `失败：${job.error}`);
		}
	} finally {
		job.finishedAt = Date.now();
		job.currentChapter = '';
		notifyJob(job);
	}
}

async function runSourceJob(job, payload, signal) {
	const { source } = payload;
	const chapters = payload.chapters || [];
	if (!chapters.length) throw new Error('没有选择任何话');
	const root = path.join(payload.outputRoot || DEFAULT_OUTPUT, sanitizeSegment(payload.book?.title || job.title));
	job.output = root;
	fs.mkdirSync(root, { recursive: true });
	job.totalChapters = chapters.length;

	for (let i = 0; i < chapters.length; i++) {
		if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
		const ch = chapters[i];
		job.currentChapter = ch.title || `第 ${i + 1} 话`;
		job.currentPage = 0;
		job.chapterPages = 0;
		log(job, `(${i + 1}/${chapters.length}) ${job.currentChapter}`);

		const parsed = await fetchComicChapter(source, ch.url, DOMParser, { signal });
		if (parsed.error) {
			job.failedChapters++;
			log(job, `跳过：${parsed.error}`);
			continue;
		}
		if (!parsed.imageUrls?.length) {
			job.failedChapters++;
			log(job, '跳过：没有找到图片');
			continue;
		}
		const dir = path.join(root, `${String(i + 1).padStart(3, '0')} ${sanitizeSegment(ch.title || '')}`.trim());
		const r = await downloadChapterImages(job, { images: parsed.imageUrls }, dir, ch.url, signal);
		if (!r.ok && !r.skipped) {
			job.failedChapters++;
			log(job, `这一话没有成功下载任何页`);
		} else {
			job.doneChapters++;
			log(job, `  完成 ${r.ok + r.skipped} 页${r.failed ? `，失败 ${r.failed}` : ''}`);
		}
	}
	await finalize(job, root, payload.book?.title || job.title, payload.cleanup);
}

async function runUrlJob(job, payload, signal) {
	const root = path.join(payload.outputRoot || DEFAULT_OUTPUT, sanitizeSegment(payload.title || job.title));
	job.output = root;
	fs.mkdirSync(root, { recursive: true });

	// 1) 已经给出章节列表（从目录页扫出来的）
	if (payload.chapters?.length) {
		job.totalChapters = payload.chapters.length;
		for (let i = 0; i < payload.chapters.length; i++) {
			if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
			const ch = payload.chapters[i];
			job.currentChapter = ch.title || `第 ${i + 1} 话`;
			job.currentPage = 0;
			job.chapterPages = 0;
			log(job, `(${i + 1}/${payload.chapters.length}) ${job.currentChapter}`);
			try {
				const scanned = await fetchAndScan(ch.url, signal);
				const dir = path.join(root, `${String(i + 1).padStart(3, '0')} ${sanitizeSegment(ch.title || scanned.title || '')}`.trim());
				const r = await downloadChapterImages(job, scanned, dir, ch.url, signal);
				if (r.ok || r.skipped) {
					job.doneChapters++;
					log(job, `  完成 ${r.ok + r.skipped} 页${r.failed ? `，失败 ${r.failed}` : ''}`);
				} else {
					job.failedChapters++;
					log(job, '  这一页没有找到图片');
				}
			} catch (e) {
				job.failedChapters++;
				log(job, `跳过：${e.message || e}`);
			}
		}
		await finalize(job, root, payload.title || job.title, payload.cleanup);
		return;
	}

	// 2) 单页 / 顺着「下一话」连续抓
	let url = payload.startUrl;
	let index = 0;
	const max = Math.max(1, Math.min(200, Number(payload.maxChapters) || 1));
	const seen = new Set();
	while (url && index < max) {
		if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
		if (seen.has(url)) break;
		seen.add(url);
		job.currentChapter = `第 ${index + 1} 话`;
		job.currentPage = 0;
		job.chapterPages = 0;
		log(job, `(${index + 1}/${payload.followNext ? `最多 ${max}` : '1'}) 扫描 ${url}`);
		const scanned = await fetchAndScan(url, signal);
		const dir = path.join(root, `${String(index + 1).padStart(3, '0')} ${sanitizeSegment(scanned.title || '')}`.trim());
		const r = await downloadChapterImages(job, scanned, dir, url, signal);
		if (r.ok || r.skipped) {
			job.doneChapters++;
			log(job, `  完成 ${r.ok + r.skipped} 页${r.failed ? `，失败 ${r.failed}` : ''}`);
		} else {
			job.failedChapters++;
			log(job, '  这一页没有找到图片');
		}
		index++;
		if (!payload.followNext) break;
		url = scanned.nextUrl || '';
	}
	await finalize(job, root, payload.title || job.title, payload.cleanup);
}

async function fetchAndScan(url, signal) {
	const target = safeHttpUrl(url);
	if (!target) throw new Error('链接不合法');
	const res = await requestText(url, {
		headers: { Referer: target.origin },
		timeout: 30000,
		signal
	});
	if (res.status >= 400) throw new Error(`页面返回 HTTP ${res.status}`);
	const block = detectBlockPage(res.text);
	if (block) throw new Error(block);
	return scanHtml(res.text, res.finalUrl || url, DOMParser);
}

async function finalize(job, root, title, cleanup) {
	// 统计目录里实际存在的图片，避免「话都失败但照样打包空包」
	let count = 0;
	const walk = (dir) => {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			if (ent.name.startsWith('.')) continue;
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) walk(full);
			else if (/\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(ent.name) && fs.statSync(full).size > 0) count++;
		}
	};
	try { walk(root); } catch { /* ignore */ }
	if (!count) throw new Error('没有下载到任何图片');

	const cbz = path.join(path.dirname(root), `${sanitizeSegment(title)}.cbz`);
	const r = packComicFolder(root, cbz, { includeRoot: false });
	job.cbz = r.output;
	log(job, `已打包 CBZ：${r.output}（${(r.bytes / 1024 / 1024).toFixed(1)} MB）`);

	if (cleanup) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
			job.output = path.dirname(cbz);
			log(job, '已删除中间图片目录（只保留 CBZ）');
		} catch { /* ignore */ }
	}
}

// ------------------------------------------------------------
//  静态文件 & API
// ------------------------------------------------------------

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon'
};

function serveStatic(res, pathname) {
	const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
	const file = path.join(PUBLIC_DIR, rel);
	if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
	fs.readFile(file, (err, buf) => {
		if (err) { res.writeHead(404); res.end('not found'); return; }
		res.writeHead(200, {
			'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
			'Cache-Control': 'no-cache'
		});
		res.end(buf);
	});
}

async function handle(req, res) {
	const u = new URL(req.url, 'http://127.0.0.1');
	const p = u.pathname;

	if (p === '/api/config' && req.method === 'GET') {
		fs.mkdirSync(DEFAULT_OUTPUT, { recursive: true });
		return json(res, 200, { outputRoot: DEFAULT_OUTPUT, version: '1.0' });
	}

	if (p === '/api/proxy' && req.method === 'GET') {
		const target = safeHttpUrl(u.searchParams.get('url'));
		if (!target) return json(res, 400, { error: '图片地址不合法' });
		try {
			const r = await requestBytes(target.href, {
				headers: { Referer: u.searchParams.get('referer') || target.origin },
				timeout: 20000
			});
			if (r.status >= 400) return json(res, 502, { error: `HTTP ${r.status}` });
			res.writeHead(200, {
				'Content-Type': r.contentType || 'image/jpeg',
				'Cache-Control': 'public, max-age=86400'
			});
			return res.end(Buffer.from(r.bytes));
		} catch (e) {
			return json(res, 502, { error: e.message || '图片加载失败' });
		}
	}

	// 内置漫画书源：下载器自带一份，开箱即可搜索，不必手动粘 JSON
	if (p === '/api/sources/builtin' && req.method === 'GET') {
		try {
			const file = path.join(__dirname, 'builtin-sources.json');
			const text = fs.readFileSync(file, 'utf8');
			const parsed = parseSourceInput(text);
			if (parsed.error) return json(res, 500, { error: '内置源解析失败：' + parsed.error });
			return json(res, 200, {
				sources: parsed.list.map((s) => ({
					id: s.id,
					name: s.name,
					url: s.url,
					kind: s.kind,
					scripted: !!s.scripted,
					source: s
				})),
				total: parsed.list.length
			});
		} catch (e) {
			return json(res, 500, { error: '内置源读取失败：' + (e.message || e) });
		}
	}

	if (p === '/api/source' && req.method === 'POST') {
		try {
			const body = await readJson(req);
			let text = String(body.input || '').trim();
			if (!text) return json(res, 400, { error: '请粘贴书源 JSON 或链接' });
			if (/^https?:\/\//i.test(text)) {
				const target = safeHttpUrl(text);
				if (!target) return json(res, 400, { error: '链接不合法' });
				const r = await requestText(text, { timeout: 30000 });
				if (r.status >= 400) return json(res, 400, { error: `下载书源失败：HTTP ${r.status}` });
				text = r.text;
			}
			const parsed = parseSourceInput(text);
			if (parsed.error) return json(res, 400, { error: parsed.error });
			return json(res, 200, {
				sources: parsed.list.map((s) => ({
					id: s.id,
					name: s.name,
					url: s.url,
					kind: s.kind,
					scripted: !!s.scripted,
					source: s
				}))
			});
		} catch (e) {
			return json(res, 400, { error: e.message || String(e) });
		}
	}

	if (p === '/api/search-all' && req.method === 'POST') {
		try {
			const { sources: list, keyword } = await readJson(req);
			if (!Array.isArray(list) || !list.length) return json(res, 400, { error: '没有可搜索的书源' });
			if (!keyword) return json(res, 400, { error: '请输入关键词' });
			const sources = list.map((s) => s.source || s).filter((s) => s && s.id);
			const task = startSearch(sources, String(keyword).trim());
			return json(res, 200, { searchId: task.id, total: task.total });
		} catch (e) {
			return json(res, 400, { error: e.message || String(e) });
		}
	}

	const searchMatch = p.match(/^\/api\/search-all\/([^/]+)$/);
	if (searchMatch && req.method === 'GET') {
		const task = searches.get(searchMatch[1]);
		if (!task) return json(res, 404, { error: '搜索任务不存在或已过期' });
		return json(res, 200, {
			id: task.id,
			status: task.status,
			done: task.done,
			total: task.total,
			results: task.results,
			stats: task.stats,
			startedAt: task.startedAt,
			finishedAt: task.finishedAt
		});
	}

	if (p === '/api/search' && req.method === 'POST') {
		try {
			const { source, keyword } = await readJson(req);
			if (!source || !keyword) return json(res, 400, { error: '缺少书源或关键词' });
			const r = await searchSource(source, String(keyword).trim(), DOMParser);
			return json(res, 200, { results: r.results, error: r.error || '' });
		} catch (e) {
			return json(res, 500, { error: e.message || String(e) });
		}
	}

	if (p === '/api/toc' && req.method === 'POST') {
		try {
			const { source, bookUrl } = await readJson(req);
			if (!source || !bookUrl) return json(res, 400, { error: '缺少书源或书籍地址' });
			const toc = await fetchToc(source, { bookUrl }, DOMParser);
			return json(res, 200, {
				chapters: toc.chapters || [],
				bookTitle: toc.bookTitle || '',
				bookAuthor: toc.bookAuthor || '',
				tocUrl: toc.tocUrl || bookUrl
			});
		} catch (e) {
			return json(res, 500, { error: e.message || String(e) });
		}
	}

	if (p === '/api/scan' && req.method === 'POST') {
		try {
			const { url } = await readJson(req);
			const target = safeHttpUrl(url);
			if (!target) return json(res, 400, { error: '链接不合法' });
			const scanned = await fetchAndScan(target.href, undefined);
			return json(res, 200, scanned);
		} catch (e) {
			return json(res, 500, { error: e.message || String(e) });
		}
	}

	if (p === '/api/download' && req.method === 'POST') {
		try {
			const body = await readJson(req);
			if (!body.mode) return json(res, 400, { error: '缺少下载模式' });
			if (body.mode === 'source') {
				if (!body.source) return json(res, 400, { error: '缺少书源' });
				if (!body.chapters?.length) return json(res, 400, { error: '没有选择话' });
			} else {
				if (!body.chapters?.length && !body.startUrl) return json(res, 400, { error: '缺少章节或起始链接' });
			}
			const job = enqueueJob(body);
			return json(res, 200, { job: snapshot(job) });
		} catch (e) {
			return json(res, 400, { error: e.message || String(e) });
		}
	}

	if (p === '/api/jobs' && req.method === 'GET') {
		return json(res, 200, {
			jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(snapshot)
		});
	}

	const cancelMatch = p.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
	if (cancelMatch && req.method === 'POST') {
		const job = jobs.get(cancelMatch[1]);
		if (!job) return json(res, 404, { error: '任务不存在' });
		job.cancelRequested = true;
		try { job.controller?.abort(); } catch { /* ignore */ }
		if (job.status === 'queued') job.status = 'cancelled';
		return json(res, 200, { ok: true });
	}

	if (p === '/api/open' && req.method === 'POST') {
		try {
			const { target } = await readJson(req);
			const resolved = path.resolve(String(target || ''));
			const allowed = [...allowedRoots].some((root) => resolved === root || resolved.startsWith(root + path.sep));
			if (!allowed) return json(res, 403, { error: '只能打开下载目录内的路径' });
			if (!fs.existsSync(resolved)) return json(res, 404, { error: '目录还不存在' });
			const stat = fs.statSync(resolved);
			const dir = stat.isDirectory() ? resolved : path.dirname(resolved);
			if (process.platform === 'win32') execFile('explorer.exe', [dir]);
			else if (process.platform === 'darwin') execFile('open', [dir]);
			else execFile('xdg-open', [dir]);
			return json(res, 200, { ok: true, path: dir });
		} catch (e) {
			return json(res, 400, { error: e.message || String(e) });
		}
	}

	if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
	serveStatic(res, p);
}

// ------------------------------------------------------------
//  启动
// ------------------------------------------------------------

function openBrowser(url) {
	try {
		if (process.platform === 'win32') execFile('cmd.exe', ['/c', 'start', '', url]);
		else if (process.platform === 'darwin') execFile('open', [url]);
		else execFile('xdg-open', [url]);
	} catch { /* ignore */ }
}

let port = Number(process.env.ZJ_DL_PORT) || 8787;
let attempts = 0;

const server = http.createServer((req, res) => {
	handle(req, res).catch((e) => {
		if (!res.headersSent) json(res, 500, { error: e.message || String(e) });
		else res.end();
	});
});

function startServer(p) {
	server.listen(p, '127.0.0.1', () => {
		const url = `http://127.0.0.1:${p}/`;
		fs.mkdirSync(DEFAULT_OUTPUT, { recursive: true });
		console.log('');
		console.log('  纸间 · 本地漫画下载器');
		console.log(`  ${url}`);
		console.log(`  输出目录：${DEFAULT_OUTPUT}`);
		console.log('  Ctrl+C 停止');
		console.log('');
		if (!process.argv.includes('--no-open')) setTimeout(() => openBrowser(url), 300);
	});
}

server.on('error', (e) => {
	if (e.code === 'EADDRINUSE' && attempts < 10) {
		attempts++;
		port++;
		/** 探测端口：是不是已经有下载器在跑，或已被别的程序占用 */
async function probePort(p) {
	try {
		const res = await fetch(`http://127.0.0.1:${p}/api/config`, { signal: AbortSignal.timeout(600) });
		if (!res.ok) return { busy: true, ours: false };
		const data = await res.json().catch(() => ({}));
		return { busy: true, ours: data?.version === '1.0' };
	} catch {
		return { busy: false, ours: false };
	}
}

(async () => {
	const startPort = port;
	for (let p = startPort; p < startPort + 13; p++) {
		const r = await probePort(p);
		if (r.ours) {
			const url = `http://127.0.0.1:${p}/`;
			console.log(`下载器已经在运行：${url}`);
			if (!process.argv.includes('--no-open')) openBrowser(url);
			return;
		}
		if (!r.busy) {
			port = p;
			startServer(p);
			return;
		}
	}
	startServer(port);
})();
		return;
	}
	console.error(e);
	process.exit(1);
});

/** 探测端口：是不是已经有下载器在跑，或已被别的程序占用 */
async function probePort(p) {
	try {
		const res = await fetch(`http://127.0.0.1:${p}/api/config`, { signal: AbortSignal.timeout(600) });
		if (!res.ok) return { busy: true, ours: false };
		const data = await res.json().catch(() => ({}));
		return { busy: true, ours: data?.version === '1.0' };
	} catch {
		return { busy: false, ours: false };
	}
}

(async () => {
	const startPort = port;
	for (let p = startPort; p < startPort + 13; p++) {
		const r = await probePort(p);
		if (r.ours) {
			const url = `http://127.0.0.1:${p}/`;
			console.log(`下载器已经在运行：${url}`);
			if (!process.argv.includes('--no-open')) openBrowser(url);
			return;
		}
		if (!r.busy) {
			port = p;
			startServer(p);
			return;
		}
	}
	startServer(port);
})();

process.on('SIGINT', () => {
	console.log('\n正在停止…');
	for (const job of jobs.values()) {
		if (job.status === 'running' || job.status === 'queued') {
			job.cancelRequested = true;
			try { job.controller?.abort(); } catch { /* ignore */ }
		}
	}
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 1200);
});
