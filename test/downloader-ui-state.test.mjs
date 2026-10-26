/**
 * 下载器前端状态回归
 *
 * 背景：pollJobs 里用了 state.statuses.get(...)，但 state 里从没声明过
 * statuses，于是每轮轮询都抛 TypeError（Cannot read properties of
 * undefined (reading 'get')），被 catch 静默吞掉 ——
 * 表现就是「界面上没有下载进度、下载完成也不提示」。
 *
 * 这类「引用了未声明的 state 字段」的错很难在静态检查里发现，
 * 所以这里直接把前端脚本在无头 DOM 里跑起来，逐项断言。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..', 'tools', 'comic-downloader', 'public');
const HTML = path.join(APP, 'index.html');
const APPJS = path.join(APP, 'app.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

console.log('== 1. state 字段完整性（静态） ==');
{
	const src = fs.readFileSync(APPJS, 'utf8');
	const block = src.match(/const state = \{([\s\S]*?)\n\};/);
	check('能解析出 state 定义', !!block);
	const defined = new Set([...(block?.[1] || '').matchAll(/^\t(\w+):/gm)].map((m) => m[1]));
	check('声明了 statuses（曾导致 .get 抛错）', defined.has('statuses'));
	const used = new Set([...src.matchAll(/state\.(\w+)/g)].map((m) => m[1]));
	const missing = [...used].filter((u) => !defined.has(u));
	check('没有引用未声明的 state 字段', missing.length === 0, missing.join(', '));
}

console.log('\n== 2. pollJobs 在无头 DOM 里不抛错 ==');
{
	const { window, document } = parseHTML(fs.readFileSync(HTML, 'utf8'));
	const src = fs.readFileSync(APPJS, 'utf8').replace(/^import .*$/gm, '');
	const factory = new Function(
		'window', 'document', 'fetch', 'localStorage', 'setTimeout', 'clearTimeout', 'console',
		src + '\nreturn { pollJobs: pollJobs, state: state, renderJobs: renderJobs };'
	);
	// 假的 /api/jobs 响应：一个已完成任务
	const fakeFetch = async () => ({
		ok: true,
		status: 200,
		json: async () => ({
			jobs: [{ id: 'j1', title: '测试漫画', status: 'done', mode: 'source', doneChapters: 2, totalChapters: 2, pages: 40, bytes: 1048576, cbz: 'X.cbz', log: [] }]
		})
	});
	const api = factory(window, document, fakeFetch, { getItem: () => null, setItem: () => {} }, () => 0, () => {}, { error: () => {}, log: () => {} });
	check('statuses 是 Map', api.state.statuses instanceof Map);
	let threw = null;
	try { await api.pollJobs(true); } catch (e) { threw = e.message; }
	check('pollJobs 不抛异常', !threw, threw);
	check('任务已写入 state', api.state.jobs.length === 1);
	check('状态已记录', api.state.statuses.get('j1') === 'done');
	const jobsText = (document.querySelector('#jobs')?.textContent || '').replace(/\s+/g, ' ');
	check('任务卡片已渲染到页面', jobsText.includes('测试漫画'), jobsText.slice(0, 80));
	check('渲染了话数进度', jobsText.includes('2/2'), jobsText.slice(0, 120));
}

console.log('\n== 3. 轮询失败不再静默 ==');
{
	const src = fs.readFileSync(APPJS, 'utf8');
	check('catch 里有 console.error', /catch[\s\S]{0,400}console\.error/.test(src));
	check('页面有 jobs-status 容器', fs.readFileSync(HTML, 'utf8').includes('jobs-status'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
