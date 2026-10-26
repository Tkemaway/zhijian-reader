/**
 * 漫画阅读器 —— 竖向连续（条漫）与横向翻页两种模式
 *
 * 与文字阅读器分开实现：漫画的「内容」是图片字节，排版、翻页、
 * 进度、预加载的规则都不一样；共用的是路由、返回键、进度表和同步。
 *
 * 图片来源只有一种：本地导入（EPUB / CBZ / ZIP）后，
 * 章节记录里直接存着图片字节。App 不再支持在线漫画，
 * 在线下载请用 PC 上的 tools/comic-downloader，导出 CBZ 再导入。
 */
import './comic-reader.css';
import { imageSize } from '../core/comic-book.js';
import { getToc, getChapter, getComicPage, saveComicChapters, saveProgress, updateBook } from '../store/db.js';
import { addReadingSeconds, loadSettings } from '../store/stats.js';
import { keepAwake } from '../store/wakelock.js';
import { scheduleSyncAfterRead } from '../store/sync.js';
import { icon, showSheet } from './kit.js';

const MODE_KEY = 'zj-comic-mode-v1';
/** 旧版「整话图片存一条记录」的书：每话已迁移过的标记，避免反复写库 */
const migratedChapters = new Set();
let C = null; // 当前漫画会话
/** 正在播放退出动画：这期间再按返回键也要吞掉，不能直接退出 App */
let _closing = false;

const escapeHtml = (s) => String(s ?? '')
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;');

function loadMode() {
	try {
		const m = localStorage.getItem(MODE_KEY);
		if (m === 'paged' || m === 'vertical') return m;
	} catch { /* ignore */ }
	return 'vertical';
}

function saveMode(mode) {
	try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
}

/**
 * 打开漫画阅读器（由 reader.js 在 book.kind === 'comic' 时调用）
 */
export async function renderComicReader(root, app) {
	_closing = false;
	unmountComicReader();

	const { book, chapterIdx = 0 } = app.state.reader || {};
	if (!book) { app.go('library'); return; }

	const settings = loadSettings();
	const el = document.createElement('div');
	el.className = 'reader comic-reader';
	// 跟随「阅读主题」：纸白 / 羊皮 / 墨水 / 夜间 / 护眼绿，和文字阅读器同一套变量
	el.dataset.theme = settings.theme || 'paper';
	root.appendChild(el);
	el.innerHTML = '<div class="comic-loading show"><span class="comic-spinner"></span><em>正在打开…</em></div>';
	// 先挂一个最小会话：读目录期间用户按返回键也能正常退出，
	// 否则 closeReaderView 找不到会话会直接退出 App
	C = { app, book, toc: [], idx: 0, el, destroyed: false, controller: new AbortController(), urls: new Map() };
	// 退出动画期间元素还连着 DOM，但会话已经销毁 —— 用这个判断避免「关掉后又弹回来」
	const alive = () => el.isConnected && !el.classList.contains('leaving');
	/** 下一帧（等浏览器完成一次布局） */
	const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

	const toc = (await getToc(book.id)) || [];
	if (!alive()) return;

	if (!toc.length) {
		el.innerHTML = `
			<div class="comic-empty">
				<p>这本漫画没有可读内容<br><span>请重新导入 EPUB / CBZ 文件</span></p>
				<button class="btn btn-soft btn-sm" id="comic-empty-back">返回</button>
			</div>`;
		el.querySelector('#comic-empty-back').onclick = () => closeComicView();
		C = { app, book, toc, idx: 0, el, destroyed: false, controller: new AbortController(), urls: new Map() };
		return;
	}

	const startIdx = Math.max(0, Math.min(toc.length - 1, Number(chapterIdx) || 0));
	const mode = loadMode();

	el.innerHTML = `
		<div class="comic-body" id="comic-body"></div>
		<div class="comic-top">
			<button class="comic-icon-btn" id="comic-back" aria-label="返回">${icon('back', 22)}</button>
			<div class="comic-head">
				<div class="comic-book">${escapeHtml(book.title || '')}</div>
				<div class="comic-chapter" id="comic-chapter"></div>
			</div>
			<div class="comic-tools">
				<button class="comic-icon-btn" id="comic-toc" aria-label="目录">${icon('list', 20)}</button>
				<button class="comic-icon-btn" id="comic-mode" aria-label="切换翻页方式">${icon(mode === 'paged' ? 'list' : 'columns', 20)}</button>
			</div>
		</div>
		<div class="comic-bottom">
			<button class="comic-nav" id="comic-prev">上一话</button>
			<div class="comic-counter" id="comic-counter">—</div>
			<button class="comic-nav" id="comic-next">下一话</button>
		</div>
		<div class="comic-loading" id="comic-loading"><span class="comic-spinner"></span><em id="comic-loading-text">正在加载…</em></div>
	`;

	const body = el.querySelector('#comic-body');
	const loading = el.querySelector('#comic-loading');
	const loadingText = el.querySelector('#comic-loading-text');
	const chapterLabel = el.querySelector('#comic-chapter');
	const counter = el.querySelector('#comic-counter');
	const prevBtn = el.querySelector('#comic-prev');
	const nextBtn = el.querySelector('#comic-next');

	C = {
		app,
		book,
		toc,
		idx: startIdx,
		mode,
		page: 0,
		pages: [],
		urls: new Map(),
		pageLoads: new Set(), // 正在从 IndexedDB 读的页，避免重复读
		gen: 0, // 每重建一次书页 +1：异步读页回来时用来判断章节是否已经切走
		el,
		body,
		strip: null,
		destroyed: false,
		controller: new AbortController(),
		loading: true,
		saveT: null,
		scrollRaf: 0,
		startedAt: Date.now(),
		lastActiveAt: Date.now(),
		timer: null
	};
	// 注意：这个声明必须在下面 await loadChapter 之前——首次渲染就会用到
	let observer = null;

	// 系统栏跟随阅读主题（退出时由 app.exitReader 还原）
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) {
		const bgMap = { paper: '#fbf7ef', sepia: '#f3ead6', ink: '#f1f0ea', night: '#121315', green: '#dfe9dd' };
		meta.content = document.body.classList.contains('eink') ? '#ffffff' : (bgMap[settings.theme] || '#fbf7ef');
	}
	keepAwake(true);
	body.dataset.mode = mode;
	applyModeChrome();

	C.timer = setInterval(() => {
		if (!C || C.destroyed) return;
		if (document.visibilityState !== 'visible') return;
		addReadingSeconds(15);
	}, 15000);

	// ---------- 交互 ----------
	el.querySelector('#comic-back').addEventListener('click', () => closeComicView());

	const toggleChrome = () => {
		el.classList.toggle('chrome-hidden');
	};

	body.addEventListener('click', (e) => {
		if (e.target.closest('button')) return;
		const rect = body.getBoundingClientRect();
		const x = e.clientX - rect.left;
		if (C.mode === 'paged') {
			if (x < rect.width * 0.26) { turnPage(-1); return; }
			if (x > rect.width * 0.74) { turnPage(1); return; }
		}
		toggleChrome();
	});

	body.addEventListener('scroll', onScroll, { passive: true });

	el.querySelector('#comic-mode').addEventListener('click', () => {
		C.mode = C.mode === 'paged' ? 'vertical' : 'paged';
		saveMode(C.mode);
		body.dataset.mode = C.mode;
		applyModeChrome();
		buildStrip();
		requestAnimationFrame(() => jumpToPage(C.page, { smooth: false }));
		saveProgressSoon();
	});

	el.querySelector('#comic-toc').addEventListener('click', openTocSheet);

	prevBtn.addEventListener('click', () => {
		if (C.idx > 0) loadChapter(C.idx - 1, 'end');
	});
	nextBtn.addEventListener('click', () => {
		if (C.idx < C.toc.length - 1) loadChapter(C.idx + 1, 'start');
	});

	// 键盘翻页（平板外接键盘 / 模拟器调试）
	const onKey = (e) => {
		if (!C || C.destroyed) return;
		if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); C.mode === 'paged' ? turnPage(-1) : loadChapter(Math.max(0, C.idx - 1), 'start'); }
		else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); C.mode === 'paged' ? turnPage(1) : loadChapter(Math.min(C.toc.length - 1, C.idx + 1), 'start'); }
		else if (e.key === 'Escape') closeComicView();
		else if (e.key === ' ') { e.preventDefault(); toggleChrome(); }
	};
	window.addEventListener('keydown', onKey);
	C.onKey = onKey;

	const onResize = () => {
		if (!C || C.destroyed) return;
		requestAnimationFrame(() => jumpToPage(C.page, { smooth: false }));
	};
	window.addEventListener('resize', onResize);
	window.addEventListener('orientationchange', onResize);
	C.onResize = onResize;

	await loadChapter(startIdx, 'keep', { pageIdx: Number(app.state.reader?.pageIdx) || 0 });

	// ---------- 内部函数 ----------

	function applyModeChrome() {
		const modeBtn = el.querySelector('#comic-mode');
		if (modeBtn) modeBtn.innerHTML = icon(C.mode === 'paged' ? 'list' : 'columns', 20);
		el.classList.toggle('is-paged', C.mode === 'paged');
	}

	async function loadChapter(idx, position = 'start', { pageIdx = 0 } = {}) {
		if (!C || C.destroyed || !alive()) return;
		if (idx < 0 || idx >= C.toc.length) return;
		C.idx = idx;
		C.loading = true;
		C.controller.abort();
		C.controller = new AbortController();
		const signal = C.controller.signal;
		showLoading('正在加载…');
		chapterLabel.textContent = `${idx + 1} / ${C.toc.length} · ${C.toc[idx]?.title || ''}`;
		prevBtn.disabled = idx === 0;
		nextBtn.disabled = idx >= C.toc.length - 1;

		try {
			// 本地漫画：章节记录里只有每页的 mime/w/h，字节按页从 comicPages 读
			const chapter = await getChapter(book.id, idx);
			if (signal.aborted || !C || C.destroyed) return;
			const legacy = (chapter?.images || []).map((im) => {
				// 旧版本把整话图片塞在章节记录里，且没有 w/h：补读一次图片头
				if ((im.w && im.h) || !im.bytes) return im;
				const dim = imageSize(im.bytes);
				return dim.w && dim.h ? { ...im, w: dim.w, h: dim.h } : im;
			});
			const meta = (chapter?.pages || []).map((p) => ({ ...p, stored: true }));
			const images = legacy.length ? legacy : meta;
			if (!images.length) throw new Error('这一话没有图片，文件可能导入不完整');
			C.pages = images;

			// 旧版本导入的书：整话图片塞在一条记录里，切话/退出都要搬几十 MB。
			// 空闲时把「当前话」迁移成按页存，并预先迁移下一话 ——
			// 这样第一次顺序阅读时，每次切话都已经就绪，不会半路卡一下。
			if (legacy.length && !chapter.pages) {
				scheduleMigrate(idx, chapter.title || C.toc[idx]?.title || '', legacy);
				if (idx + 1 < C.toc.length) scheduleMigrateFromDb(idx + 1);
			}
			C.page = position === 'end' ? images.length - 1 : position === 'start' ? 0 : Math.min(pageIdx, images.length - 1);
			buildStrip();
			hideLoading();
			requestAnimationFrame(() => restorePosition(position, pageIdx));
		} catch (e) {
			if (signal.aborted) return;
			hideLoading();
			renderError(e.message || String(e));
		} finally {
			if (C && !C.destroyed) C.loading = false;
		}
	}

	function showLoading(text) {
		if (!loading) return;
		loading.classList.add('show');
		if (loadingText) loadingText.textContent = text;
	}

	function hideLoading() {
		loading?.classList.remove('show');
	}

	function renderError(msg) {
		revokeUrls();
		body.innerHTML = '';
		const raw = String(msg || '');
		// 英文的运行时错误（TypeError 等）对用户没有意义：给一句中文，细节留在下面
		const friendly = /^[A-Za-z]/.test(raw) ? '这一话打开失败，请重试' : raw;
		const box = document.createElement('div');
		box.className = 'comic-error';
		box.innerHTML = `
			<p>${escapeHtml(friendly)}</p>
			${friendly !== raw ? `<p class="comic-error-detail">${escapeHtml(raw)}</p>` : ''}
			<button class="btn btn-soft btn-sm">重试</button>`;
		box.querySelector('button').onclick = () => loadChapter(C.idx, 'keep', { pageIdx: C.page });
		body.appendChild(box);
		counter.textContent = '—';
	}

	/**
	 * 空闲时执行（不支持 requestIdleCallback 就退化为延时）。
	 * 必须用函数声明而不是 const —— 首次 await loadChapter 就会调用它，
	 * 用 const 会落在暂时性死区（真机报 "Cannot access 'b' before initialization"）。
	 */
	function idleRun(fn) {
		if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 10000 });
		else setTimeout(fn, 4000);
	}

	/** 用已经读进内存的图片迁移一话（不再重复读库） */
	function scheduleMigrate(idx, title, images) {
		const key = `${book.id}:${idx}`;
		if (migratedChapters.has(key)) return;
		migratedChapters.add(key);
		idleRun(() => {
			saveComicChapters(book.id, [{ idx, title, images }]).catch(() => migratedChapters.delete(key));
		});
	}

	/** 预先迁移还没打开过的一话：只读一次库，空闲时写 */
	function scheduleMigrateFromDb(idx) {
		const key = `${book.id}:${idx}`;
		if (migratedChapters.has(key)) return;
		migratedChapters.add(key);
		idleRun(async () => {
			try {
				const ch = await getChapter(book.id, idx);
				if (!ch?.images?.length) return; // 已经是按页存 / 没有内容
				const imgs = ch.images.map((im) => {
					if ((im.w && im.h) || !im.bytes) return im;
					const dim = imageSize(im.bytes);
					return dim.w && dim.h ? { ...im, w: dim.w, h: dim.h } : im;
				});
				await saveComicChapters(book.id, [{ idx, title: ch.title || '', images: imgs }]);
			} catch {
				migratedChapters.delete(key);
			}
		});
	}

	function pageElAt(i) {
		return C?.strip?.children?.[i] || null;
	}

	function pageImgAt(i) {
		return pageElAt(i)?.querySelector('img') || null;
	}

	/**
	 * 只有进入视野附近的页才创建 Blob URL。
	 * 早期实现给整话每一页都建了 URL —— 40 页的章节会瞬间多出几十 MB，
	 * 低内存机型直接闪退；这里改为按需创建、远处释放。
	 */
	async function ensureUrl(i) {
		if (!C || C.destroyed) return;
		if (i < 0 || i >= C.pages.length) return;
		if (C.urls.has(i) || C.pageLoads.has(i)) return;
		const page = C.pages[i];
		const imgEl = pageImgAt(i);
		if (!page || !imgEl) return;
		const gen = C.gen;
		const chapterIdx = C.idx;
		const loads = C.pageLoads;
		loads.add(i);
		try {
			let blob = page.blob instanceof Blob ? page.blob : null;
			if (!blob) {
				let bytes = page.bytes;
				// 新版按页存：只在这一页进入视野时才从 IndexedDB 取那几十 KB～几 MB
				if (!bytes && page.stored) {
					const rec = await getComicPage(book.id, chapterIdx, i);
					if (!C || C.destroyed || C.gen !== gen) return;
					if (!rec?.bytes) { markBroken(i); return; }
					bytes = rec.bytes;
					page.mime = rec.mime || page.mime;
					if (!page.w && rec.w) page.w = rec.w;
					if (!page.h && rec.h) page.h = rec.h;
				}
				if (!bytes) { markBroken(i); return; }
				blob = new Blob([bytes], { type: page.mime || 'image/jpeg' });
				page.blob = blob;
				// 字节已经交给 Blob：只有「按页存」的页能丢 ArrayBuffer（旧数据靠它保底）
				if (page.stored) page.bytes = null;
			}
			if (!C || C.destroyed || C.gen !== gen || C.urls.has(i)) return;
			const url = URL.createObjectURL(blob);
			C.urls.set(i, url);
			imgEl.style.visibility = '';
			imgEl.alt = `第 ${i + 1} 页`;
			imgEl.src = url;
		} catch {
			markBroken(i);
		} finally {
			loads.delete(i);
		}
	}

	function markBroken(i) {
		const elPage = pageElAt(i);
		if (elPage) elPage.dataset.failed = '1';
	}

	/** 离当前页很远的图片释放掉，内存只保留一屏多一点 */
	function releaseUrl(i) {
		const url = C?.urls.get(i);
		if (!url) return;
		const imgEl = pageImgAt(i);
		if (imgEl) {
			// 先按真实像素固定高度，再删 src —— 否则这一页会塌成 0 高，滚动位置乱跳
			if (imgEl.naturalWidth && imgEl.naturalHeight) {
				pageElAt(i).style.aspectRatio = `${imgEl.naturalWidth} / ${imgEl.naturalHeight}`;
			}
			// 隐藏而不是只删 src：部分 WebView 在无 src 时会画出 alt 文字/破图标
			imgEl.style.visibility = 'hidden';
			imgEl.alt = '';
			imgEl.removeAttribute('src');
		}
		URL.revokeObjectURL(url);
		C.urls.delete(i);
		const page = C.pages?.[i];
		if (page?.stored) page.blob = null;
	}

	/** 当前页附近要加载的窗口 */
	function ensureWindow(page) {
		if (!C) return;
		// 竖向模式一次只多载 3 页：条漫单页可能很长，窗口越大越容易吃满内存
		const before = 1;
		const after = C.mode === 'paged' ? 2 : 3;
		const from = Math.max(0, page - before);
		const to = Math.min(C.pages.length - 1, page + after);
		for (let i = from; i <= to; i++) ensureUrl(i);
	}

	/** 回收窗口外的 URL */
	function pruneUrls(page) {
		if (!C) return;
		const before = C.mode === 'paged' ? 2 : 4;
		const after = C.mode === 'paged' ? 3 : 8;
		const from = page - before;
		const to = page + after;
		for (const i of [...C.urls.keys()]) {
			if (i < from || i > to) releaseUrl(i);
		}
	}

	function buildStrip() {
		C.gen++;
		C.pageLoads = new Set();
		revokeUrls();
		body.innerHTML = '';
		const strip = document.createElement('div');
		strip.className = 'comic-strip';
		C.strip = strip;

		C.pages.forEach((img, i) => {
			const pageEl = document.createElement('div');
			pageEl.className = 'comic-page';
			pageEl.dataset.i = String(i);
			// 解析时已从图片头读到像素尺寸 → 未加载也占正确高度，滚动条不乱跳；
			// 旧版本导入的书没有 w/h，用竖版比例兜底，加载后再按真实尺寸校正
			const ar = img.w && img.h ? img.w / img.h : 0.72;
			pageEl.style.setProperty('--ar', String(ar));
			const imageEl = document.createElement('img');
			imageEl.alt = '';
			imageEl.decoding = 'async';
			imageEl.loading = 'lazy';
			imageEl.style.visibility = 'hidden'; // 等 ensureUrl 真正给到图片再显示
			imageEl.addEventListener('load', () => {
				if (imageEl.naturalWidth && imageEl.naturalHeight) {
					pageEl.style.aspectRatio = `${imageEl.naturalWidth} / ${imageEl.naturalHeight}`;
				}
			}, { once: true });
			pageEl.appendChild(imageEl);
			strip.appendChild(pageEl);
		});

		body.appendChild(strip);

		// 竖向模式末尾放一个「下一话」，滚到底就能继续
		if (C.mode === 'vertical' && C.idx < C.toc.length - 1) {
			const foot = document.createElement('button');
			foot.className = 'comic-foot-next';
			foot.textContent = `下一话 · ${C.toc[C.idx + 1]?.title || ''}`;
			foot.addEventListener('click', () => loadChapter(C.idx + 1, 'start'));
			body.appendChild(foot);
		}

		observeImages();
		updateCounter();
	}

	function observeImages() {
		observer?.disconnect();
		observer = null;
		if (!C?.strip) return;
		if (typeof IntersectionObserver === 'undefined') {
			// 没有 IntersectionObserver（极老 WebView）：只加载当前页附近
			ensureWindow(C.page);
			return;
		}
		observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const holder = entry.target.parentElement;
				ensureUrl(Number(holder?.dataset.i));
			}
		}, { root: body, rootMargin: C.mode === 'paged' ? '0px 1000px' : '700px 0px' });
		C.strip.querySelectorAll('img').forEach((img) => observer.observe(img));
		ensureWindow(C.page);
	}

	/**
	 * 恢复阅读位置。
	 * 不再「把目标页之前的所有图都加载+解码」——那是长章节卡顿/闪退的主因；
	 * 占位高度已按真实尺寸预留，直接滚过去即可，最多加载完当前页再校正一次。
	 */
	async function restorePosition(position, pageIdx) {
		if (!C || C.destroyed) return;
		const max = C.pages.length - 1;
		const target = position === 'end' ? max : position === 'keep' ? Math.min(Math.max(0, pageIdx), max) : 0;
		C.page = target;
		ensureWindow(target);
		updateCounter();

		if (C.mode === 'paged') {
			C.body.scrollLeft = target * C.body.clientWidth;
			saveProgressSoon();
			return;
		}

		await nextFrame();
		if (!C || C.destroyed) return;
		C.body.scrollTop = pageElAt(target)?.offsetTop || 0;

		const imgEl = pageImgAt(target);
		if (imgEl && !imgEl.complete) {
			await Promise.race([
				new Promise((r) => imgEl.addEventListener('load', r, { once: true })),
				new Promise((r) => imgEl.addEventListener('error', r, { once: true })),
				new Promise((r) => setTimeout(r, 1500))
			]);
		}
		if (!C || C.destroyed) return;
		// 旧数据没有 w/h 时占位比例是估的，图加载完再对齐一次
		C.body.scrollTop = pageElAt(target)?.offsetTop || 0;
		pruneUrls(target);
		saveProgressSoon();
	}

	/** 当前视口中线落在第几页（二分，避免长章节每帧遍历几百个节点） */
	function pageAtOffset(mid) {
		const pages = C?.strip?.children || [];
		if (!pages.length) return 0;
		let lo = 0;
		let hi = pages.length - 1;
		let ans = 0;
		while (lo <= hi) {
			const m = (lo + hi) >> 1;
			if (pages[m].offsetTop <= mid) {
				ans = m;
				lo = m + 1;
			} else {
				hi = m - 1;
			}
		}
		return ans;
	}

	function jumpToPage(page, { smooth = false } = {}) {
		if (!C || !C.strip) return;
		const max = C.pages.length - 1;
		const p = Math.max(0, Math.min(max, page));
		C.page = p;
		ensureWindow(p);
		if (C.mode === 'paged') {
			C.body.scrollTo({ left: p * C.body.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
		} else {
			const el = pageElAt(p);
			if (el) C.body.scrollTop = el.offsetTop;
			pruneUrls(p);
		}
		updateCounter();
	}

	function turnPage(delta) {
		const next = C.page + delta;
		if (next < 0) {
			if (C.idx > 0) loadChapter(C.idx - 1, 'end');
			return;
		}
		if (next >= C.pages.length) {
			if (C.idx < C.toc.length - 1) loadChapter(C.idx + 1, 'start');
			return;
		}
		jumpToPage(next, { smooth: true });
		saveProgressSoon();
	}

	function onScroll() {
		if (!C || C.destroyed || C.mode !== 'vertical') {
			if (C?.mode === 'paged') scheduleScrollUpdate();
			return;
		}
		scheduleScrollUpdate();
	}

	function scheduleScrollUpdate() {
		if (C.scrollRaf) return;
		C.scrollRaf = requestAnimationFrame(() => {
			C.scrollRaf = 0;
			if (!C || C.destroyed) return;
			if (C.mode === 'paged') {
				const p = Math.round(C.body.scrollLeft / Math.max(1, C.body.clientWidth));
				if (p !== C.page) {
					C.page = Math.max(0, Math.min(C.pages.length - 1, p));
					updateCounter();
					saveProgressSoon();
				}
				ensureWindow(C.page);
				pruneUrls(C.page);
				return;
			}
			const mid = C.body.scrollTop + C.body.clientHeight * 0.4;
			const page = pageAtOffset(mid);
			if (page !== C.page) {
				C.page = page;
				updateCounter();
				saveProgressSoon();
			}
			// 只保留当前窗口：预载后面几页，释放远处的图片内存
			ensureWindow(page);
			pruneUrls(page);
		});
	}

	function updateCounter() {
		if (!counter) return;
		counter.textContent = C.pages.length
			? `${C.page + 1} / ${C.pages.length} 页`
			: '—';
	}

	function saveProgressSoon() {
		if (!C || C.destroyed) return;
		C.lastActiveAt = Date.now();
		clearTimeout(C.saveT);
		C.saveT = setTimeout(() => persistProgress(), 700);
	}

	function persistProgress() {
		if (!C) return;
		const total = Math.max(1, C.toc.length);
		const payload = {
			bookId: C.book.id,
			chapterIdx: C.idx,
			chapterTitle: C.toc[C.idx]?.title || '',
			pageIdx: C.page,
			scrollTop: C.mode === 'vertical' ? C.body.scrollTop : 0,
			mode: C.mode === 'paged' ? 'comic-paged' : 'comic-vertical',
			percent: Math.min(100, Math.round(((C.idx + (C.page + 1) / Math.max(1, C.pages.length)) / total) * 100))
		};
		saveProgress(payload).catch(() => {});
		updateBook(C.book.id, {
			lastReadAt: Date.now(),
			readChapters: Math.max(C.book.readChapters || 0, C.idx + 1)
		}).catch(() => {});
	}

	function openTocSheet() {
		showSheet({
			title: '目录',
			build: (sheetBody, close) => {
				const list = document.createElement('div');
				list.className = 'comic-toc-list';
				C.toc.forEach((ch, i) => {
					const btn = document.createElement('button');
					btn.className = `comic-toc-item${i === C.idx ? ' is-on' : ''}`;
					btn.innerHTML = `<span>${escapeHtml(ch.title || `第 ${i + 1} 话`)}</span><em>${i + 1}</em>`;
					btn.onclick = () => {
						close();
						if (i !== C.idx) loadChapter(i, 'start');
					};
					list.appendChild(btn);
				});
				sheetBody.appendChild(list);
				requestAnimationFrame(() => {
					list.querySelector('.is-on')?.scrollIntoView({ block: 'center' });
				});
			}
		});
	}

	function revokeUrls() {
		for (const url of C?.urls?.values?.() || []) {
			try { URL.revokeObjectURL(url); } catch { /* ignore */ }
		}
		if (C) C.urls = new Map();
		observer?.disconnect();
		observer = null;
	}
}

/** 关闭（带退出动画），供返回键与左上角按钮共用 */
export function closeComicView() {
	if (_closing) return true; // 退出动画进行中：再按一次返回也不能退出 App
	if (!C) return false;
	_closing = true;
	const { app, book } = C;
	const el = C.el;
	try {
		unmountComicReader({ keepDom: true });
	} catch { /* 清理失败也不能把用户困在阅读器里 */ }
	if (el && el.isConnected) {
		el.classList.add('leaving');
		setTimeout(() => {
			_closing = false;
			el.remove();
			app.exitReader(book.id);
		}, 220);
	} else {
		_closing = false;
		app.exitReader(book.id);
	}
	return true;
}

/** 卸载：保存进度、释放图片 URL、恢复常亮与同步 */
export function unmountComicReader({ keepDom = false } = {}) {
	if (!C) return;
	const session = C;
	C = null;
	session.destroyed = true;
	try { session.controller?.abort(); } catch { /* ignore */ }
	clearInterval(session.timer);
	clearTimeout(session.saveT);
	if (session.scrollRaf) cancelAnimationFrame(session.scrollRaf);
	if (session.onKey) window.removeEventListener('keydown', session.onKey);
	if (session.onResize) {
		window.removeEventListener('resize', session.onResize);
		window.removeEventListener('orientationchange', session.onResize);
	}

	// 进度（用 session 自己的状态，不依赖全局 C）
	// 只写到过正文的会话：刚打开就退出（还在拉目录/首话）时不能把已有进度写成第 0 话
	if (session.body && session.toc?.length) {
		const payload = {
			bookId: session.book.id,
			chapterIdx: session.idx,
			chapterTitle: session.toc[session.idx]?.title || '',
			pageIdx: session.page,
			scrollTop: session.mode === 'vertical' ? session.body.scrollTop : 0,
			mode: session.mode === 'paged' ? 'comic-paged' : 'comic-vertical'
		};
		saveProgress(payload).catch(() => {});
		updateBook(session.book.id, {
			lastReadAt: Date.now(),
			readChapters: Math.max(session.book.readChapters || 0, session.idx + 1)
		}).catch(() => {});
	}

	for (const url of session.urls?.values?.() || []) {
		try { URL.revokeObjectURL(url); } catch { /* ignore */ }
	}
	try { keepAwake(false); } catch { /* ignore */ }
	try { scheduleSyncAfterRead(); } catch { /* ignore */ }
	if (!keepDom) session.el?.remove();
}
