/**
 * 本地下载器端到端：模拟漫画站 → 书源搜索/目录/取图 → 下载 → CBZ
 * 不访问外网；下载器以子进程启动，用 ZJ_DL_ALLOW_LOCAL 允许 mock 站点。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const { parseCbz } = await import(pathToFileURL(path.join(root, 'src/core/comic-book.js')).href);

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 模拟漫画站 ----------
const sitePort = 18091;
const site = http.createServer((req, res) => {
	const u = new URL(req.url, `http://127.0.0.1:${sitePort}`);
	if (u.pathname === '/search') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(`<html><body><div class="item"><a href="/book/1">测试漫画</a><span>某作者</span></div></body></html>`);
		return;
	}
	if (u.pathname === '/book/1') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(`<html><body><h1>测试漫画</h1><ul id="list">
			<li><a href="/ch/1">第1话</a></li><li><a href="/ch/2">第2话</a></li>
		</ul></body></html>`);
		return;
	}
	const ch = u.pathname.match(/^\/ch\/(\d+)$/);
	if (ch) {
		const n = ch[1];
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(`<html><body><div id="content">
			<img src="/img/${n}-1.png"><img src="/img/${n}-2.png">
		</div></body></html>`);
		return;
	}
	if (/^\/img\/\d+-\d+\.png$/.test(u.pathname)) {
		res.writeHead(200, { 'Content-Type': 'image/png' });
		res.end(PNG);
		return;
	}
	res.writeHead(404); res.end('not found');
});
await new Promise((r) => site.listen(sitePort, '127.0.0.1', r));

// ---------- 启动下载器 ----------
const dlPort = 19000 + Math.floor(Math.random() * 800);
const dlBase = `http://127.0.0.1:${dlPort}`;
const child = spawn(process.execPath, [path.join(root, 'tools/comic-downloader/server.mjs'), '--no-open'], {
	cwd: root,
	env: { ...process.env, ZJ_DL_ALLOW_LOCAL: '1', ZJ_DL_PORT: String(dlPort) },
	stdio: 'ignore'
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zj-dl-e2e-'));

try {
	let up = false;
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`${dlBase}/api/config`);
			if (r.ok) { up = true; break; }
		} catch { /* retry */ }
		await sleep(150);
	}
	check('下载器启动', up);
	if (!up) throw new Error('下载器未能启动');

	const source = {
		id: 'test-src', name: '模拟漫画源', type: 'legado', url: `http://127.0.0.1:${sitePort}`, enabled: true,
		searchUrl: '/search?q={{key}}',
		ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
		ruleToc: { chapterList: '#list a', chapterName: 'text', chapterUrl: 'href' },
		ruleContent: { content: '#content' }
	};

	const searchRes = await fetch(`${dlBase}/api/search`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ source, keyword: '测试' })
	}).then((r) => r.json());
	check('搜索命中 1 条', searchRes.results?.length === 1, JSON.stringify(searchRes));
	check('搜索结果书名', searchRes.results?.[0]?.bookName === '测试漫画', JSON.stringify(searchRes.results?.[0]));

	const tocRes = await fetch(`${dlBase}/api/toc`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ source, bookUrl: searchRes.results[0].bookUrl })
	}).then((r) => r.json());
	check('目录 2 话', tocRes.chapters?.length === 2, JSON.stringify(tocRes));

	const started = await fetch(`${dlBase}/api/download`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			mode: 'source',
			title: '测试漫画',
			source,
			book: { title: '测试漫画', author: '某作者', bookUrl: searchRes.results[0].bookUrl },
			chapters: tocRes.chapters,
			outputRoot: tmp,
			cleanup: false
		})
	}).then((r) => r.json());
	const jobId = started.job?.id;
	check('任务已创建', !!jobId, JSON.stringify(started));

	let job = null;
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		const data = await fetch(`${dlBase}/api/jobs`).then((r) => r.json());
		job = data.jobs?.find((j) => j.id === jobId);
		if (job && ['done', 'error', 'cancelled'].includes(job.status)) break;
	}
	check('任务完成', job?.status === 'done', JSON.stringify({ status: job?.status, error: job?.error, log: job?.log?.slice(-6) }));
	check('下载 4 页', job?.pages === 4, String(job?.pages));
	check('生成 CBZ', !!job?.cbz && fs.existsSync(job.cbz), job?.cbz || '');

	if (job?.cbz && fs.existsSync(job.cbz)) {
		const parsed = parseCbz(new Uint8Array(fs.readFileSync(job.cbz)), '测试漫画.cbz');
		check('CBZ 解析出 2 话', parsed.chapters.length === 2, String(parsed.chapters.length));
		check('每话 2 页', parsed.chapters.every((c) => c.images.length === 2), JSON.stringify(parsed.chapters.map((c) => c.images.length)));
	}
} catch (e) {
	fail++;
	console.log(`  ✗ 异常：${e.message}`);
} finally {
	child.kill();
	await new Promise((r) => site.close(r));
	fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
