/**
 * 漫画阅读器冒烟测试（Node + linkedom）
 *
 * 真机上踩过两次「运行时才炸」的坑（TDZ：Cannot access 'b' before initialization），
 * 而 Vite 构建、单元测试都发现不了。这里把 comic-reader.js 打包成可在 Node 运行的
 * 模块，配一个最小 DOM / IndexedDB，实际跑一遍：
 *   旧版「整话图片」章节 → 渲染 → 后台迁移
 *   新版「按页存储」章节 → 异步读取图片
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { install } from './helpers/fake-idb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const id = (p) => pathToFileURL(path.join(rootDir, p)).href;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 最小浏览器环境 ----------
install();
const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = document;
try {
	Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
} catch { /* ignore */ }

const mem = new Map();
globalThis.localStorage = {
	getItem: (k) => (mem.has(k) ? mem.get(k) : null),
	setItem: (k, v) => mem.set(k, String(v)),
	removeItem: (k) => mem.delete(k)
};
// linkedom 没有 scrollTo / scroll 行为，补一个最小实现（真机 WebView 自带）
const elProto = window.Element?.prototype;
if (elProto && !elProto.scrollTo) {
	elProto.scrollTo = function scrollTo(opts) {
		if (opts && typeof opts === 'object') {
			if (typeof opts.left === 'number') this.scrollLeft = opts.left;
			if (typeof opts.top === 'number') this.scrollTop = opts.top;
		}
	};
}
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);
globalThis.requestIdleCallback = (fn) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 0);
globalThis.IntersectionObserver = class {
	constructor() {}
	observe() {}
	unobserve() {}
	disconnect() {}
};
// Node 自带 Blob / URL.createObjectURL；旧版本 Node 兜底
if (typeof URL.createObjectURL !== 'function') {
	let n = 0;
	URL.createObjectURL = () => `blob:mock/${++n}`;
	URL.revokeObjectURL = () => {};
}

// ---------- 打包阅读器（CSS 置空，依赖的同步/统计模块用桩） ----------
const stub = {
	name: 'stub',
	setup(b) {
		b.onResolve({ filter: /(sync|stats|wakelock)\.js$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
		b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
			let contents = '';
			if (args.path.includes('sync')) contents = 'export function scheduleSyncAfterRead(){}; export function isSyncEnabled(){return false}';
			else if (args.path.includes('stats')) contents = "export function addReadingSeconds(){}; export function loadSettings(){return { theme: 'paper' }}";
			else contents = 'export function keepAwake(){}';
			return { contents, loader: 'js' };
		});
	}
};

const built = await build({
	entryPoints: [path.join(rootDir, 'src/ui/comic-reader.js')],
	bundle: true,
	format: 'esm',
	write: false,
	platform: 'browser',
	loader: { '.css': 'empty' },
	plugins: [stub],
	logLevel: 'silent'
});
const code = built.outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const db = await import(id('src/store/db.js'));
const bf = await import(id('src/store/book-files.js'));

const PNG = Uint8Array.from(Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
));

function makeApp(book, pageIdx = 0) {
	return {
		state: { reader: { book, chapterIdx: 0, pageIdx } },
		go() {},
		exitReader() {},
		refresh() {}
	};
}

console.log('== 1. 旧版章节（图片存在章节记录里）==');
{
	await db.addBook({ id: 'old_comic', title: '旧漫画', author: '', sourceId: 'local', kind: 'comic', totalChapters: 2, addedAt: Date.now() });
	await db.saveToc('old_comic', [{ title: '第1话' }, { title: '第2话' }]);
	await db.saveChapters('old_comic', [
		{ idx: 0, title: '第1话', images: [{ bytes: PNG, mime: 'image/png' }] },
		{ idx: 1, title: '第2话', images: [{ bytes: PNG, mime: 'image/png' }] }
	]);
	const book = await db.getBook('old_comic');
	const el = document.createElement('div');
	document.body.appendChild(el);

	await mod.renderComicReader(el, makeApp(book));
	await sleep(30);

	const error = el.querySelector('.comic-error');
	check('没有落到错误页', !error, error?.textContent?.slice(0, 80));
	check('渲染出书页', el.querySelectorAll('.comic-page').length === 1, String(el.querySelectorAll('.comic-page').length));
	check('图片拿到 blob 地址', String(el.querySelector('.comic-page img')?.getAttribute('src') || '').startsWith('blob:'));
	check('进度条页码显示', /1 \/ 1 页/.test(el.querySelector('#comic-counter')?.textContent || ''), el.querySelector('#comic-counter')?.textContent);

	// 立刻切下一话：此时当前话的迁移任务还没跑完，
	// 这是真机上「点下一话就闪退」的场景（旧话+新话内存叠加）
	el.querySelector('#comic-next')?.dispatchEvent(new window.Event('click'));
	await sleep(400);
	check('能切到下一话', /2 \/ 2/.test(el.querySelector('#comic-chapter')?.textContent || ''), el.querySelector('#comic-chapter')?.textContent);
	check('下一话有图', String(el.querySelector('.comic-page img')?.getAttribute('src') || '').startsWith('blob:'));
	check('切话没有错误页', !el.querySelector('.comic-error'), el.querySelector('.comic-error')?.textContent?.slice(0, 80));

	el.querySelector('#comic-mode')?.dispatchEvent(new window.Event('click'));
	await sleep(200);
	check('切到横向翻页模式', el.querySelector('#comic-body')?.dataset.mode === 'paged', el.querySelector('#comic-body')?.dataset.mode);

	// 回到第一话并停留：迁移会在空闲时完成（切话会中断迁移，回来时应自动重试）
	el.querySelector('#comic-prev')?.dispatchEvent(new window.Event('click'));
	await sleep(900);
	const migrated0 = await db.getChapter('old_comic', 0);
	check('旧章节已迁移为页元信息', migrated0?.pages?.length === 1 && !migrated0?.images, JSON.stringify(Object.keys(migrated0 || {})));
	check('迁移后页字节可读', (await db.getComicPage('old_comic', 0, 0))?.bytes?.length > 50);
	check('重新打开后仍是正常页', !!el.querySelector('.comic-page img') && !el.querySelector('.comic-error'));
	mod.unmountComicReader();
	el.remove();
}

console.log('\n== 2. 新版按页存储的章节 ==');
{
	await db.addBook({ id: 'new_comic', title: '新漫画', author: '', sourceId: 'local', kind: 'comic', totalChapters: 1, totalPages: 1, addedAt: Date.now() });
	await db.saveToc('new_comic', [{ title: '第1话' }]);
	await bf.saveParsedChapters('new_comic', {
		kind: 'comic',
		chapters: [{ title: '第1话', images: [{ bytes: PNG, mime: 'image/png', w: 1, h: 1 }] }]
	});
	const book = await db.getBook('new_comic');
	const el = document.createElement('div');
	document.body.appendChild(el);

	await mod.renderComicReader(el, makeApp(book));
	await sleep(300);

	const error = el.querySelector('.comic-error');
	check('没有落到错误页', !error, error?.textContent?.slice(0, 80));
	check('按页取出图片并绑定', String(el.querySelector('.comic-page img')?.getAttribute('src') || '').startsWith('blob:'));
	check('页占位比例来自元信息', el.querySelector('.comic-page')?.style.getPropertyValue('--ar') === '1', el.querySelector('.comic-page')?.style.getPropertyValue('--ar'));
	mod.unmountComicReader();
	el.remove();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
