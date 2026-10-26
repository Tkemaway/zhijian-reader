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
import { getToc, getChapter, saveProgress, updateBook } from '../store/db.js';
import { addReadingSeconds } from '../store/stats.js';
import { keepAwake } from '../store/wakelock.js';
import { scheduleSyncAfterRead } from '../store/sync.js';
import { icon, showSheet } from './kit.js';

const MODE_KEY = 'zj-comic-mode-v1';
let C = null; // 当前漫画会话

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
	unmountComicReader();

	const { book, chapterIdx = 0 } = app.state.reader || {};
	if (!book) { app.go('library'); return; }

	const el = document.createElement('div');
	el.className = 'reader comic-reader';
	root.appendChild(el);
	el.innerHTML = '<div class="comic-loading show"><span class="comic-spinner"></span><em>正在打开…</em></div>';
	// 先挂一个最小会话：读目录期间用户按返回键也能正常退出，
	// 否则 closeReaderView 找不到会话会直接退出 App
	C = { app, book, toc: [], idx: 0, el, destroyed: false, controller: new AbortController(), urls: [] };
	// 退出动画期间元素还连着 DOM，但会话已经销毁 —— 用这个判断避免「关掉后又弹回来」
	const alive = () => el.isConnected && !el.classList.contains('leaving');

	const toc = (await getToc(book.id)) || [];
	if (!alive()) return;

	if (!toc.length) {
		el.innerHTML = `
			<div class="comic-empty">
				<p>这本漫画没有可读内容<br><span>请重新导入 EPUB / CBZ 文件</span></p>
				<button class="btn btn-soft btn-sm" id="comic-empty-back">返回</button>
			</div>`;
		el.querySelector('#comic-empty-back').onclick = () => closeComicView();
		C = { app, book, toc, idx: 0, el, destroyed: false, controller: new AbortController(), urls: [] };
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
		urls: [],
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

	// 背景/系统栏变暗（退出时由 app.exitReader 还原）
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.content = '#0c0c0e';
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
			// 本地漫画：一话 = 一条章节记录里的图片字节，直接读库即可
			const chapter = await getChapter(book.id, idx);
			if (signal.aborted || !C || C.destroyed) return;
			const images = chapter?.images || [];
			if (!images.length) throw new Error('这一话没有图片，文件可能导入不完整');
			C.pages = images;
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
		const box = document.createElement('div');
		box.className = 'comic-error';
		box.innerHTML = `<p>${escapeHtml(msg)}</p><button class="btn btn-soft btn-sm">重试</button>`;
		box.querySelector('button').onclick = () => loadChapter(C.idx, 'keep', { pageIdx: C.page });
		body.appendChild(box);
		counter.textContent = '—';
	}

	function buildStrip() {
		revokeUrls();
		body.innerHTML = '';
		C.urls = [];
		const strip = document.createElement('div');
		strip.className = 'comic-strip';
		C.strip = strip;

		C.pages.forEach((img, i) => {
			const pageEl = document.createElement('div');
			pageEl.className = 'comic-page';
			pageEl.dataset.i = String(i);
			const imageEl = document.createElement('img');
			imageEl.alt = `第 ${i + 1} 页`;
			imageEl.decoding = 'async';
			imageEl.loading = 'lazy';
			const url = URL.createObjectURL(new Blob([img.bytes], { type: img.mime || 'image/jpeg' }));
			C.urls.push(url);
			imageEl.dataset.src = url;
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

		// 懒加载：进入视口前 1.2 屏再取图，长章节也不会一次性解码
		observeImages();
		updateCounter();
	}

	function observeImages() {
		observer?.disconnect();
		if (typeof IntersectionObserver === 'undefined') {
			C.strip.querySelectorAll('img[data-src]').forEach((img) => { img.src = img.dataset.src; });
			return;
		}
		observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const img = entry.target;
				if (img.dataset.src && !img.src) img.src = img.dataset.src;
				observer.unobserve(img);
			}
		}, { root: body, rootMargin: C.mode === 'paged' ? '0px 1500px' : '1200px 0px' });
		C.strip.querySelectorAll('img[data-src]').forEach((img) => observer.observe(img));

		// 当前页先加载，保证恢复位置时高度是确定的
		loadUpTo(C.page);
	}

	function loadUpTo(page) {
		if (!C.strip) return;
		const pages = C.strip.children;
		for (let i = 0; i <= page && i < pages.length; i++) {
			const img = pages[i].querySelector('img');
			if (img?.dataset.src && !img.src) img.src = img.dataset.src;
		}
	}

	async function restorePosition(position, pageIdx) {
		if (!C || C.destroyed) return;
		// 竖向模式：后面的图没加载时高度是 0，直接 scrollTop 会差好几页。
		// 先把目标页之前的图都放出来并等解码，再定位。
		const target = position === 'end' ? C.pages.length - 1 : position === 'keep' ? pageIdx : -1;
		if (C.mode === 'vertical' && target > 0) {
			loadUpTo(target);
			const imgs = [...C.strip.children].slice(0, target + 1).map((p) => p.querySelector('img')).filter(Boolean);
			await Promise.allSettled(imgs.map((img) => (img.decode ? img.decode() : Promise.resolve())));
		}
		if (!C || C.destroyed) return;
		jumpToPage(C.page, { smooth: false });
		saveProgressSoon();
	}

	function jumpToPage(page, { smooth = false } = {}) {
		if (!C || !C.strip) return;
		const max = C.pages.length - 1;
		const p = Math.max(0, Math.min(max, page));
		C.page = p;
		if (C.mode === 'paged') {
			// 预取相邻页：横向滑动时不会先看到空白再等图
			for (const i of [p - 1, p, p + 1]) {
				const img = C.strip.children[i]?.querySelector('img');
				if (img?.dataset.src && !img.src) img.src = img.dataset.src;
			}
			C.body.scrollTo({ left: p * C.body.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
		} else {
			const el = C.strip.children[p];
			if (el) C.body.scrollTop = el.offsetTop;
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
				return;
			}
			const mid = C.body.scrollTop + C.body.clientHeight * 0.4;
			let page = 0;
			const pages = C.strip?.children || [];
			for (let i = 0; i < pages.length; i++) {
				if (pages[i].offsetTop <= mid) page = i;
				else break;
			}
			if (page !== C.page) {
				C.page = page;
				updateCounter();
				saveProgressSoon();
			}
			// 快到底了提前解码下一屏
			loadUpTo(Math.min(C.pages.length - 1, page + 2));
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
		for (const url of C?.urls || []) {
			try { URL.revokeObjectURL(url); } catch { /* ignore */ }
		}
		if (C) C.urls = [];
		observer?.disconnect();
		observer = null;
	}
}

/** 关闭（带退出动画），供返回键与左上角按钮共用 */
export function closeComicView() {
	if (!C) return false;
	const { app, book } = C;
	const el = C.el;
	unmountComicReader({ keepDom: true });
	if (el && el.isConnected) {
		el.classList.add('leaving');
		setTimeout(() => {
			el.remove();
			app.exitReader(book.id);
		}, 220);
	} else {
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

	for (const url of session.urls || []) {
		try { URL.revokeObjectURL(url); } catch { /* ignore */ }
	}
	keepAwake(false);
	scheduleSyncAfterRead();
	if (!keepDom) session.el?.remove();
}
