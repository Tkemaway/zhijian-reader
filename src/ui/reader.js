/**
 * 阅读器 —— Kindle 风格沉浸阅读
 * 双模式：上下滚动 / 真实分页翻页（多列排版 + 跟手滑动）
 * 章节缓存优先 + 网络补拉 + 进度记忆 + 防沉迷计时
 */
import './reader.css';
import sources from '../core/sources.js';
import { fetchChapter, fetchToc } from '../core/engine.js';
import { getChapter, saveChapters, getToc, saveToc, saveProgress, updateBook, countCachedChapters, getBookmarks, saveBookmark, deleteBookmark, getCachedChapterIndices } from '../store/db.js';
import { loadSettings, saveSettings, addReadingSeconds, getLimitStateWithExtra, grantExtraMinutes, fmtDuration, updateReadingSpeed, estimateMinutes } from '../store/stats.js';
import { keepAwake } from '../store/wakelock.js';
import { setPageKeysEnabled } from '../store/page-keys.js';
import { refreshBookToc } from '../store/toc-refresh.js';
import { openSourceSwitcher } from './source-switch.js';
import { scheduleSyncAfterRead } from '../store/sync.js';
import { icon, toast, showSheet, showDialog, closeTopOverlay } from './kit.js';
import { escapeHtml } from './library.js';
import { capturePosition, locatePosition } from './reading-position.js';
import { renderComicReader, unmountComicReader, closeComicView } from './comic-reader.js';

let S = null; // 阅读器会话状态
let renderGeneration = 0;

export async function renderReader(root, app) {
	unmountReader();
	const generation = ++renderGeneration;
	const { book, chapterIdx = 0, scrollTop = 0, pageIdx = 0, anchor = null, skipEnter = false } = app.state.reader || {};
	if (!book) { app.go('library'); return; }
	// 漫画走独立的阅读器（图片流），与文字排版无关
	if (book.kind === 'comic') return renderComicReader(root, app);

	const source = sources.find((s) => s.id === book.sourceId);
	let toc = (await getToc(book.id)) || [];
	// 从其他设备同步过来的书（本机还没有目录）：首次打开时自动拉取并缓存
	if (!toc.length && source && (book.tocUrl || book.bookUrl) && typeof DOMParser !== 'undefined') {
		toast('这本书来自同步书架，正在获取目录…', 2000);
		try {
			const fetched = await fetchToc(source, book, DOMParser);
			if (fetched?.chapters?.length) {
				toc = fetched.chapters;
				await saveToc(book.id, toc);
				updateBook(book.id, { totalChapters: toc.length, tocUrl: fetched.tocUrl || book.tocUrl }).catch(() => {});
			}
		} catch { /* 拉取失败：走下方的空目录提示 */ }
	}
	if (generation !== renderGeneration || app.state.route !== 'reader') return;
	const settings = loadSettings();

	const isPaged = settings.pageMode === 'page';

	S = {
		controller: new AbortController(),
		timeouts: new Set(),
		navigation: 0,
		pending: new Map(),
		appending: new Set(),
		token: Symbol('reader-session'),
		app,
		book,
		source,
		toc,
		settings,
		isPaged,
		loaded: new Map(), // 滚动模式：idx -> { el }
		range: { start: -1, end: -1 },
		visibleIdx: chapterIdx,
		initialIdx: chapterIdx, // 本次打开时的位置（目录里标「上次读到这里」）
		paged: { chapterIdx: -1, page: 0, pageCount: 1, step: 0, maxLeft: 0, _t: null, _lock: 0 },
		timer: null,
		limitWarned: false,
		nearlyWarned: false,
		destroyed: false,
		_touch: null,
		_suppressClickUntil: 0
	};
	const session = S;

	const bodyHtml = isPaged
		? `<div class="reader-body paged" id="rd-body">
			<div class="pv-viewport" id="pv-viewport">
				<article class="pv-content" id="pv-content">
					<div class="chapter-loading"><span class="dot-pulse"><i></i><i></i><i></i></span></div>
				</article>
			</div>
			<div class="reader-veil" id="rd-veil"></div>
		</div>`
		: `<div class="reader-body" id="rd-body">
			<article class="reader-article" id="rd-article">
				<div class="chapter-loading"><span class="dot-pulse"><i></i><i></i><i></i></span></div>
			</article>
		</div>`;

	// 阅读器作为浮层叠加在书架上（不销毁底下页面）：
	// 退出时书架原样露出来，滚动位置、卡片、动画都还在。
	const holder = document.createElement('div');
	holder.innerHTML = `
	<div class="reader ${skipEnter ? '' : 'entering'} ${settings.frontLight && settings.frontLight !== 'off' ? `front-light-${settings.frontLight}` : ''} ${settings.paperGrain ? 'paper-grain-on' : ''}" data-theme="${settings.theme}" style="--rd-fontsize:${settings.fontSize}px;--rd-lineheight:${settings.lineHeight};--rd-pgap:${settings.paragraphGap}em;--rd-font:${settings.fontFamily === 'sans' ? 'var(--font-ui)' : settings.fontFamily === 'wenkai' ? 'var(--font-wenkai)' : 'var(--font-song)'};--rd-font-title:var(--font-reading);">
		<header class="reader-top" id="rd-top">
			<button class="reader-btn" id="rd-back">${icon('back', 22)}</button>
			<div class="reader-top-title" id="rd-title">${escapeHtml(book.title)}</div>
			<button class="reader-btn" id="rd-bookmark" title="添加书签" aria-label="添加书签">${icon('bookmark', 22)}</button>
			<button class="reader-btn" id="rd-more" title="更多" aria-label="更多">${icon('more', 22)}</button>
		</header>

		${bodyHtml}
		<div class="reader-frontlight" aria-hidden="true"></div>

		<footer class="reader-bottom" id="rd-bottom">
			<div class="reader-toolbar">
				<button class="reader-tool" id="rd-toc">${icon('list', 21)}<span>目录</span></button>
				<button class="reader-tool" id="rd-font">${icon('font', 21)}<span>排版</span></button>
				<button class="reader-tool" id="rd-theme">${icon('theme', 21)}<span>主题</span></button>
				<button class="reader-tool" id="rd-time">${icon('clock', 21)}<span id="rd-time-label">${fmtBrief(getLimitStateWithExtra().usedSec)}</span></button>
			</div>
			<div class="reader-progress-row">
				<span id="rd-progress-text">0%</span>
				<div class="progress-track"><div class="progress-fill" id="rd-progress-fill" style="width:0%"></div></div>
				<span id="rd-chapter-label"></span>
			</div>
		</footer>
	</div>`;
	const readerEl = holder.firstElementChild;
	root.appendChild(readerEl);

	// 同步系统主题色（墨水屏一律纯白）
	try {
		const metaMap = { paper: '#fbf7ef', sepia: '#f3ead6', ink: '#e8e7e1', green: '#dfe9dd', night: '#121315' };
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.content = document.body.classList.contains('eink') ? '#ffffff' : (metaMap[settings.theme] || '#fbf7ef');
	} catch { /* ignore */ }

	// 进场动画收尾
	if (!skipEnter) {
		sessionTimeout(() => document.querySelector('.reader')?.classList.remove('entering'), 520);
	}

	// ---------- 事件绑定 ----------
	readerEl.querySelector('#rd-back').addEventListener('click', () => closeReader());
	readerEl.querySelector('#rd-more').addEventListener('click', () => showMore());
	readerEl.querySelector('#rd-bookmark').addEventListener('click', addBookmark);
	readerEl.querySelector('#rd-toc').addEventListener('click', () => showToc());
	readerEl.querySelector('#rd-font').addEventListener('click', () => showFontPanel());
	readerEl.querySelector('#rd-theme').addEventListener('click', () => showThemePanel());
	readerEl.querySelector('#rd-time').addEventListener('click', () => showTimePanel());

	if (isPaged) bindPagedEvents();
	else bindScrollEvents();
	bindProgressScrub();

	// 打开书后：后台检查书源是否有新章节（2 小时节流，静默进行）
	maybeRefreshToc(S);

	window.addEventListener('keydown', onKey);
	window.addEventListener('resize', onResize);
	window.addEventListener('orientationchange', onResize);
	document.addEventListener('visibilitychange', onVisibility);

	// ---------- 阅读计时 ----------
	S.timer = setInterval(tickReading, 15000);

	// ---------- 初始加载 ----------
	const startIdx = Math.max(0, Math.min(chapterIdx, Math.max(0, toc.length - 1)));
	if (isPaged) {
		await loadPagedChapter(startIdx, { position: Number.isInteger(pageIdx) && pageIdx > 0 ? pageIdx : 'start', anchor });
	} else {
		await loadFrom(startIdx, { scrollTo: scrollTop || 0, anchor });
	}
	if (!isCurrentSession(session)) return;
	sessionTimeout(() => toggleMenus(false), 320);

	// 超限状态提示
	const ls = getLimitStateWithExtra();
	if (ls.enabled && ls.exceeded) {
		S.limitWarned = true;
		sessionTimeout(() => showLimitDialog(), 600);
	}

	// 文楷字体就绪后重新分页（系统宋体无需加载等待）
	if (settings.fontFamily === 'wenkai') repageWhenWenkaiReady();

	if (settings.keepAwake) keepAwake(true);
	// 音量键此时开始当作翻页键（退出时交还系统音量）
	setPageKeysEnabled(true);
}

/**
 * 原生层音量键 → 翻页。
 * 返回 true 表示这次按键已被阅读器消费。
 */
if (typeof window !== 'undefined') {
	window.__zjPageKey = (dir) => {
		if (!S || S.destroyed) return false;
		// 面板/对话框打开时不动页面（但仍然吞掉按键，避免音量被误调）
		if (document.querySelector('.sheet.show, .dialog-mask.show')) return true;
		if (S.loading || S.turning) return true; // 加载中连按：吞掉，避免叠加翻页
		if (S.isPaged) {
			if (dir === 'prev') {
				if (S.paged.page > 0) gotoPaged(S.paged.page - 1);
				else prevPagedChapter('end');
			} else if (S.paged.page < S.paged.pageCount - 1) {
				gotoPaged(S.paged.page + 1);
			} else {
				nextPagedChapter('start');
			}
			return true;
		}
		const body = document.getElementById('rd-body');
		if (!body) return false;
		body.scrollBy({
			top: (dir === 'prev' ? -1 : 1) * body.clientHeight * 0.9,
			behavior: reducedMotion() ? 'auto' : 'smooth'
		});
		return true;
	};
}

function isCurrentSession(session) {
	return !!session && S === session && !session.destroyed;
}

function sessionTimeout(callback, delay, session = S) {
	if (!isCurrentSession(session)) return;
	const timer = setTimeout(() => {
		session.timeouts.delete(timer);
		if (isCurrentSession(session)) callback();
	}, delay);
	session.timeouts.add(timer);
	return timer;
}

function reducedMotion() {
	return document.body.classList.contains('motion-off')
		|| document.body.classList.contains('reduce-motion')
		|| window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function hasTextSelection() {
	return !!window.getSelection()?.toString();
}

// ============================================================
//  滚动模式
// ============================================================

function bindScrollEvents() {
	const body = document.getElementById('rd-body');
	body.addEventListener('click', (e) => {
		if (hasTextSelection()) return;
		if (e.target.closest('button') || e.target.closest('a')) return;
		const rect = body.getBoundingClientRect();
		const y = e.clientY - rect.top;
		if (y < rect.height * 0.15 || y > rect.height * 0.85) return;
		toggleMenus();
	});
	body.addEventListener('scroll', onScroll, { passive: true });
}

// ============================================================
//  分页模式（Kindle 式翻页）
// ============================================================

function bindPagedEvents() {
	const viewport = document.getElementById('pv-viewport');

	// 点击：左翻 / 右翻 / 中间菜单
	viewport.addEventListener('click', (e) => {
		if (!S || S.loading || S.turning || hasTextSelection()) return;
		if (e.target.closest('button') || e.target.closest('a')) return;
		// 手势结束后 Android WebView 可能补发 click，避免一次滑动被翻两页。
		if (Date.now() < (S._suppressClickUntil || 0)) return;
		const rect = viewport.getBoundingClientRect();
		const relX = (e.clientX - rect.left) / rect.width;
		if (relX < 0.28) {
			if (S.paged.page > 0) gotoPaged(S.paged.page - 1);
			else prevPagedChapter('end');
		} else if (relX > 0.72) {
			if (S.paged.page < S.paged.pageCount - 1) gotoPaged(S.paged.page + 1);
			else nextPagedChapter('start');
		} else toggleMenus();
	});

	// 滚动 → 吸附对齐 + 进度（拖动翻页的记录）
	viewport.addEventListener('scroll', () => {
		clearTimeout(S.paged._t);
		S.paged._t = sessionTimeout(() => {
			if (!S || S.destroyed || !S.isPaged) return;
			const W = S.paged.step;
			if (!W || Date.now() < (S.paged._lock || 0)) return;
			const page = Math.max(0, Math.min(Math.round(viewport.scrollLeft / W), S.paged.pageCount - 1));
			const targetLeft = page === S.paged.pageCount - 1 ? S.paged.maxLeft : page * W;
			if (Math.abs(viewport.scrollLeft - targetLeft) > 4) {
				viewport.scrollTo({ left: targetLeft, behavior: reducedMotion() ? 'auto' : 'smooth' });
			}
			const prevPage = S.paged.page;
			S.paged.page = page;
			if (S.paged.page !== prevPage) recordPageTurn(S.paged.page);
			updateProgressUI();
			scheduleSaveProgress();
		}, 140);
	}, { passive: true });

	// 触摸：跨章衔接检测（在最末/最前页继续滑动）
	viewport.addEventListener('touchstart', (e) => {
		const t = e.touches[0];
		S._touch = { x: t.clientX, y: t.clientY, sl: viewport.scrollLeft };
	}, { passive: true });

	viewport.addEventListener('touchend', (e) => {
		if (!S || S.loading || hasTextSelection()) return;
		const st = S._touch;
		S._touch = null;
		if (!st || !S || S.destroyed) return;
		const t = e.changedTouches[0];
		const dx = t.clientX - st.x;
		const dy = t.clientY - st.y;
		// 墨水屏触控抖动大，阈值放宽；且不做跟手滑动（见下方分支）
		const eink = document.body.classList.contains('eink');
		const minDx = eink ? 64 : 56;
		if (Math.abs(dx) < minDx || Math.abs(dx) < Math.abs(dy) * 1.3) return;
		S._suppressClickUntil = Date.now() + 420;
		if (eink) {
			// 松手才翻一页：整屏横向跟手滑动是墨水屏残影最重的操作
			if (dx < 0) {
				if (S.paged.page < S.paged.pageCount - 1) gotoPaged(S.paged.page + 1);
				else nextPagedChapter('start');
			} else if (S.paged.page > 0) {
				gotoPaged(S.paged.page - 1);
			} else {
				prevPagedChapter('end');
			}
			return;
		}
		const W = S.paged.step || 1;
		const lastLeft = S.paged.maxLeft || Math.max(0, (S.paged.pageCount - 1) * W);
		const atLast = st.sl >= lastLeft - 12;
		const atFirst = st.sl <= 12;
		if (dx < 0 && atLast) nextPagedChapter('start');
		else if (dx > 0 && atFirst) prevPagedChapter('end');
	}, { passive: true });
}

/** 渲染分页模式的章节内容 */
async function loadPagedChapter(idx, { position = 'start', viaTurn = false, anchor = null } = {}) {
	const session = S;
	const viewport = document.getElementById('pv-viewport');
	const content = document.getElementById('pv-content');
	if (!viewport || !content || !isCurrentSession(session)) return;
	const navigation = ++session.navigation;
	session.loading = true;
	const valid = () => isCurrentSession(session) && navigation === session.navigation;
	// 取下一章时给个轻提示：否则弱网下点翻页像没反应。
	// 延迟 160ms 再出现——命中缓存时不会闪一下。
	const hintT = sessionTimeout(() => {
		if (session.loading) setLoadingHint(true, idx > session.paged.chapterIdx ? '正在取下一章…' : '正在加载章节…');
	}, 160);

	// 纸墨护眼模式保留短淡化翻页，减少连续滑动和大幅动态造成的刺激。
	// 墨水屏强制用淡化：整屏横向滑动是残影最重的动画。
	const eink = document.body.classList.contains('eink');
	const useFade = !reducedMotion() && (eink || (session.settings.turnStyle || 'fade') === 'fade');

	if (!S._chapterData) content.innerHTML = `<div class="chapter-loading" style="margin-top:30vh">正在加载章节</div>`;

	let data;
	try {
		data = await getChapterData(idx, session);
	} catch (e) {
		if (!valid()) return;
		clearTimeout(hintT);
		session.loading = false;
		setLoadingHint(false);
		const reason = e?.message && e.message.length <= 80 && !/已关闭/.test(e.message) ? e.message : '';
		if (session._chapterData) toast(reason ? `加载失败：${reason}` : '章节加载失败，当前页已保留，请再次翻页重试', 3200);
		else {
			content.innerHTML = `<div style="text-align:center;padding:30vh 24px 0;line-height:1.8;color:var(--rd-ink-2)">${reason ? escapeHtml(reason) : '加载失败'}<br><button class="chapter-retry btn btn-soft" style="margin-top:16px">点击重试</button></div>`;
			content.querySelector('.chapter-retry').onclick = () => loadPagedChapter(idx, { position, anchor });
		}
		return;
	}
	if (!valid()) return;
	if (viaTurn && useFade) {
		veilGlobalRefreshIn(100);
		await new Promise((resolve) => setTimeout(resolve, 120));
		if (!valid()) return;
	}

	content.innerHTML = '';
	const h = document.createElement('h1');
	h.className = 'chapter-title';
	h.textContent = data.title || S.toc[idx]?.title || '';
	content.appendChild(h);
	const frag = document.createDocumentFragment();
	for (const p of data.paragraphs) {
		const node = document.createElement('p');
		node.textContent = p;
		frag.appendChild(node);
	}
	content.appendChild(frag);
	viewport.scrollLeft = 0;

	S.paged.chapterIdx = idx;
	S.visibleIdx = idx;
	S._chapterData = data;
	S._lastTurn = null; // 章节间不采样速度
	setTitle(data.title);
	// 读到接近目录末尾：检查书源是否有新章节（2 小时节流）
	if (idx >= S.toc.length - 2) maybeRefreshToc(session);
	// 等待两帧让 WebView 完成字体、列高和 scrollWidth 计算；否则首屏/末页可能使用旧尺寸。
	await nextLayoutFrame();
	if (!valid()) return;
	measurePaged();

	let page = 0;
	if (position === 'end') page = S.paged.pageCount - 1;
	else if (typeof position === 'number') page = Math.max(0, Math.min(position, S.paged.pageCount - 1));
	if (anchor?.chapterIdx === idx) page = locatePosition(anchor, { body: viewport, block: content, isPaged: true, step: S.paged.step });
	session.loading = false;
	clearTimeout(hintT);
	setLoadingHint(false);
	gotoPaged(page, false);
	updateProgressUI();
	scheduleSaveProgress();

	// 新章徐徐显现：给遮罩留出完整的显现时间，避免章节切换像硬切。
	if (viaTurn && useFade) {
		sessionTimeout(() => { if (valid()) veilFadeOut(300); }, 30);
	}
	preloadNext(idx);
}

/** 等待 WebView 完成一次布局提交，避免读取到旧 scrollWidth */
function nextLayoutFrame() {
	return new Promise((resolve) => {
		if (typeof requestAnimationFrame !== 'function') {
			setTimeout(resolve, 0);
			return;
		}
		requestAnimationFrame(() => requestAnimationFrame(resolve));
	});
}

/** 测量分页（列宽 / 页数）——单栏，一屏一页，列距 = 页宽 */
function measurePaged() {
	const viewport = document.getElementById('pv-viewport');
	const content = document.getElementById('pv-content');
	if (!viewport || !content) return;
	const W = Math.max(1, viewport.clientWidth);
	// 安全网：视口高度不应超过屏幕；异常时截断，防止列高错误导致页数骤减（如"每章只有两页"）
	const rawH = viewport.clientHeight || 0;
	const H = Math.max(1, Math.min(rawH, window.innerHeight || rawH));
	const colW = Math.max(1, Math.min(W - 52, 768));
	const padH = Math.max(0, (W - colW) / 2);
	const gap = W - colW; // 相邻列起点相距正好一个页宽 → 翻页步长 = W
	const padTop = 84;
	const padBottom = 96;

	content.style.height = `${H}px`;
	content.style.padding = `${padTop}px ${padH}px ${padBottom}px`;
	content.style.columnWidth = `${colW}px`;
	content.style.columnGap = `${gap}px`;
	content.style.marginRight = `${padH}px`;

	// 先清掉占位元素再测量，避免旧的撑宽值影响列数探测
	let tail = document.getElementById('pv-tail');
	if (tail) tail.style.width = '0px';

	void content.offsetHeight;

	// scrollWidth 是多列布局实际生成的总宽度；按页宽换算列数。
	// 但 Chromium 等多列实现会在溢出时忽略末列右侧 padding，令 scrollWidth 偏小
	// （N×W - padH），直接用它定位末页会整页偏右 2×padH。这里用一个普通流占位
	// 元素把可滚动宽度补足到 N×W（块级元素宽度可靠计入 scrollWidth）。
	const sw0 = Math.max(viewport.scrollWidth, W);
	const N = Math.max(1, Math.round(sw0 / W));
	if (!tail) {
		tail = document.createElement('div');
		tail.id = 'pv-tail';
		tail.setAttribute('aria-hidden', 'true');
		viewport.appendChild(tail);
	}
	tail.style.width = `${N * W}px`;
	void viewport.offsetWidth;

	S.paged.step = W;
	S.paged.pageCount = N;
	// maxLeft 取“实测值”与“理论值”的较小者：兜住 padding 被忽略的偏小，
	// 也防止个别内核把 marginRight 一并计入导致的偏大。
	S.paged.maxLeft = Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth, (N - 1) * W));
}

/** 翻到指定页：淡化翻页（Kindle 式）或平滑滑动 */
function gotoPaged(page, smooth = true, opts = {}) {
	const session = S;
	if (!isCurrentSession(session) || session.turning) return;
	const viewport = document.getElementById('pv-viewport');
	if (!viewport) return;
	const p = Math.max(0, Math.min(page, S.paged.pageCount - 1));
	const style = S.settings.turnStyle || 'fade';
	// 淡化翻页（Kindle 式）——普通 Android 用短淡化模拟克制的纸页切换
	smooth = smooth && !reducedMotion();
	const eink = document.body.classList.contains('eink');
	const useFade = (eink || style === 'fade' || opts.force === 'fade') && smooth && p !== S.paged.page;
	// 末页必须使用真实的最大滚动位置；平板多列布局的末列可能比理论 W*n 短。
	const wantLeft = p * S.paged.step;
	const maxLeft = S.paged.maxLeft || Math.max(0, viewport.scrollWidth - viewport.clientWidth);
	const targetLeft = p === S.paged.pageCount - 1 ? maxLeft : Math.min(wantLeft, maxLeft);

	if (useFade) {
		session.turning = true;
		const navigation = session.navigation;
		// 先让旧页柔和退场，再瞬时换列，最后让新页完整显现。
		// 这组时序保留上一版接近 Kindle 的渐显观感，避免短遮罩造成硬切。
		veilFadeIn(170);
		sessionTimeout(() => {
			if (navigation !== session.navigation) { session.turning = false; return; }
			S.paged.page = p;
			S.paged._lock = Date.now() + 260;
			viewport.scrollLeft = targetLeft; // 瞬时切换（被纸色遮住）
			updateProgressUI();
			scheduleSaveProgress();
			recordPageTurn(p);
			session.turning = false;
			veilFadeOut(260);
		}, 180);
		return;
	}

	// 平滑滑动（或瞬时定位）
	S.paged.page = p;
	S.paged._lock = Date.now() + (smooth ? 520 : 120);
	viewport.scrollTo({ left: targetLeft, behavior: smooth ? 'smooth' : 'auto' });
	updateProgressUI();
	if (smooth) {
		scheduleSaveProgress();
		recordPageTurn(p);
	}
}

/** 文楷字体就绪后重新分页（内嵌字体较慢加载时，避免字宽变化导致页数/位置跳动） */
function repageWhenWenkaiReady() {
	const session = S;
	try {
		if (!document.fonts?.load) return;
		document.fonts.load('16px "Zhijian Serif"').then(() => {
			if (!isCurrentSession(session) || !S._chapterData) return;
			relayout(S.loading ? S.anchor : getReadingAnchor());
		}).catch(() => {});
	} catch { /* ignore */ }
}

/** 纸色遮罩淡入（字迹渐渐淡去） */
function veilFadeIn(ms = 170) {
	const veil = document.getElementById('rd-veil');
	if (!veil) return;
	if (reducedMotion()) return;
	veil.style.transition = `opacity ${ms}ms ease-in`;
	veil.style.opacity = '0.99';
}

/** 章节切换时的低对比全屏清理，模拟全局刷新而不使用高反差闪屏。 */
function veilGlobalRefreshIn(ms = 100) {
	const veil = document.getElementById('rd-veil');
	if (!veil || reducedMotion()) return;
	veil.classList.add('global-refresh');
	veil.style.transition = `opacity ${ms}ms ease-in-out`;
	veil.style.opacity = '1';
}

/** 纸色遮罩淡出（新页徐徐显现） */
function veilFadeOut(ms = 260, done) {
	const veil = document.getElementById('rd-veil');
	if (!veil) { done?.(); return; }
	if (done) setTimeout(done, ms);
	if (veil.classList.contains('global-refresh')) setTimeout(() => veil.classList.remove('global-refresh'), ms);
	requestAnimationFrame(() => {
		if (!veil.isConnected) return;
		veil.style.transition = `opacity ${ms}ms cubic-bezier(0.16, 1, 0.3, 1)`;
		veil.style.opacity = '0';
	});
}

// ---------- 阅读速度采样（用于"剩余 X 分钟"估算） ----------
function recordPageTurn(newPage) {
	const now = Date.now();
	const last = S._lastTurn;
	S._lastTurn = { t: now, page: newPage, chapterIdx: S.paged.chapterIdx };
	if (!last) return;
	// 仅采"顺序前进一页"的样本（跳页/回看不参与速度校准）
	if (last.chapterIdx !== S.paged.chapterIdx || newPage !== last.page + 1) return;
	const dt = (now - last.t) / 1000;
	const data = S._chapterData;
	if (data?.totalChars && S.paged.pageCount > 1) {
		const charsPerPage = Math.round(data.totalChars / S.paged.pageCount);
		updateReadingSpeed(charsPerPage, dt);
	}
}

function nextPagedChapter(position = 'start') {
	if (!S || S.loading || S.turning) return;
	const next = S.paged.chapterIdx + 1;
	if (next >= S.toc.length) {
		toast('已经是最后一章了');
		return;
	}
	loadPagedChapter(next, { position, viaTurn: true });
}

function prevPagedChapter(position = 'end') {
	if (!S || S.loading || S.turning) return;
	const prev = S.paged.chapterIdx - 1;
	if (prev < 0) {
		toast('已经是第一章了');
		return;
	}
	loadPagedChapter(prev, { position, viaTurn: true });
}

// ============================================================
//  章节数据
// ============================================================

function chapterUrlOf(idx) {
	return S.toc[idx]?.url || '';
}

async function getChapterData(idx, session = S) {
	if (session?.pending.has(idx)) return session.pending.get(idx);
	const promise = fetchChapterData(idx, session);
	session?.pending.set(idx, promise);
	try { return await promise; }
	finally { session?.pending.delete(idx); }
}

async function fetchChapterData(idx, session) {
	if (!session || session.destroyed) throw new Error('阅读器已关闭');
	// 捕获 session，避免用户退出/切换书籍后，旧请求把内容写入新阅读会话。
	const bookId = session.book.id;
	const tocItem = session.toc[idx];
	// 1. 缓存
	try {
		const cached = await getChapter(bookId, idx);
		if (cached && cached.paragraphs?.length) {
			if (!cached.totalChars) cached.totalChars = cached.paragraphs.join('').length;
			return cached;
		}
	} catch { /* ignore */ }
	if (!isCurrentSession(session)) throw new Error('阅读器已关闭');
	// 2. 网络
	const url = tocItem?.url || '';
	if (!url) throw new Error('章节地址缺失');
	const ch = await fetchChapter(session.source, url, undefined, tocItem?.title || '', { signal: session.controller.signal });
	if (!isCurrentSession(session)) throw new Error('阅读器已关闭');
	if (ch.error || !ch.paragraphs.length) throw new Error(ch.error || '内容为空');
	const data = { idx, url, title: ch.title || tocItem?.title || `第 ${idx + 1} 章`, paragraphs: ch.paragraphs };
	data.totalChars = data.paragraphs.join('').length;
	try {
		await saveChapters(bookId, [data]);
		countCachedChapters(bookId).then((n) => updateBook(bookId, { cachedChapters: n })).catch(() => {});
	} catch { /* ignore */ }
	return data;
}

function buildChapterBlock(idx, data) {
	const block = document.createElement('section');
	block.className = 'chapter-block';
	block.dataset.idx = String(idx);
	block.id = `ch-${idx}`;
	block.__chapterData = data; // 供剩余时间估算

	if (idx > 0) {
		const sep = document.createElement('div');
		sep.className = 'chapter-sep';
		sep.innerHTML = '<span>·</span>';
		block.appendChild(sep);
	}

	const h = document.createElement('h1');
	h.className = 'chapter-title';
	h.textContent = data.title || S.toc[idx]?.title || '';
	block.appendChild(h);

	for (const p of data.paragraphs) {
		const node = document.createElement('p');
		node.textContent = p;
		block.appendChild(node);
	}
	return block;
}


/** Both modes save paragraph and character offsets, rather than layout coordinates. */
function getReadingAnchor() {
	if (!S) return null;
	if (S.loading) return S.anchor || null;
	const current = S.isPaged ? { idx: S.visibleIdx, el: document.getElementById('pv-content') } : currentReadingBlock();
	return capturePosition({ body: document.getElementById(S.isPaged ? 'pv-viewport' : 'rd-body'),
		block: current?.el, chapterIdx: current?.idx, isPaged: S.isPaged, page: S.paged.page });
}

function restoreReadingAnchor(anchor, fallbackScrollTop = 0) {
	const body = document.getElementById('rd-body');
	const block = anchor ? S?.loaded.get(anchor.chapterIdx)?.el : null;
	if (!body || !block) {
		if (body && fallbackScrollTop > 0) body.scrollTop = fallbackScrollTop;
		return;
	}
	body.scrollTop = locatePosition(anchor, { body, block, isPaged: false });
}

function relayout(anchor = getReadingAnchor()) {
	if (!S || S.loading) return;
	if (S.isPaged) {
		measurePaged();
		const page = locatePosition(anchor, { body: document.getElementById('pv-viewport'),
			block: document.getElementById('pv-content'), isPaged: true, step: S.paged.step });
		gotoPaged(page, false);
	} else restoreReadingAnchor(anchor);
	updateProgressUI();
	scheduleSaveProgress();
}

/** 滚动模式：从 idx 清空重建 */
async function loadFrom(idx, { scrollTo = 0, anchor = null } = {}) {
	const session = S;
	const article = document.getElementById('rd-article');
	if (!article || !isCurrentSession(session)) return;
	const navigation = ++session.navigation;
	session.loading = true;
	article.innerHTML = `<div class="chapter-loading"><span class="dot-pulse"><i></i><i></i><i></i></span></div>`;
	session.loaded.clear();
	session.range = { start: idx, end: idx };

	let data;
	try { data = await getChapterData(idx, session); }
	catch {
		if (!isCurrentSession(session) || navigation !== session.navigation) return;
		session.loading = false;
		article.innerHTML = '<button class="chapter-retry">加载失败，点击重试</button>';
		article.querySelector('button').onclick = () => loadFrom(idx, { scrollTo, anchor });
		return;
	}
	if (!isCurrentSession(session) || navigation !== session.navigation) return;
	article.innerHTML = '';
	const block = buildChapterBlock(idx, data);
	article.appendChild(block);
	session.loaded.set(idx, { el: block, ok: true });
	session.visibleIdx = idx;

	const loader = document.createElement('div');
	loader.className = 'chapter-loading';
	loader.id = 'rd-loader';
	loader.innerHTML = '<span class="dot-pulse"><i></i><i></i><i></i></span>';
	article.appendChild(loader);

	await nextLayoutFrame();
	if (!isCurrentSession(session) || navigation !== session.navigation) return;
	session.loading = false;
	restoreReadingAnchor(anchor?.chapterIdx === idx ? anchor : null, scrollTo);
	updateProgressUI();
	setTitle(data.title);
	// 滚动模式读到接近目录末尾：检查书源是否有新章节
	if (idx >= session.toc.length - 2) maybeRefreshToc(session);
	scheduleSaveProgress();

	preloadNext(idx);
}

async function appendChapter(idx) {
	const session = S;
	if (!isCurrentSession(session) || session.loading || session.loaded.has(idx) || session.appending.has(idx) || idx >= session.toc.length) return;
	const article = document.getElementById('rd-article');
	const loader = document.getElementById('rd-loader');
	if (!article) return;
	const navigation = session.navigation;
	session.appending.add(idx);

	try {
		const data = await getChapterData(idx, session);
		if (!isCurrentSession(session) || navigation !== session.navigation) return;
		const block = buildChapterBlock(idx, data);
		block.classList.add('chapter-enter');
		article.insertBefore(block, loader);
		session.loaded.set(idx, { el: block, ok: true });
		session.range.end = idx;
		setTimeout(() => block.classList.remove('chapter-enter'), 500);
	} catch (e) {
		if (!isCurrentSession(session) || navigation !== session.navigation) return;
		const retry = document.createElement('div');
		retry.style.textAlign = 'center';
		retry.innerHTML = `<button class="chapter-retry">加载失败，点击重试</button>`;
		retry.querySelector('button').onclick = () => {
			retry.remove();
			appendChapter(idx);
		};
		article.insertBefore(retry, loader);
		session.loaded.set(idx, { el: retry, ok: false });
		retry.querySelector('button').onclick = () => {
			retry.remove();
			session.loaded.delete(idx);
			appendChapter(idx);
		};
	} finally {
		session.appending.delete(idx);
	}
}

async function preloadNext(idx) {
	const session = S;
	if (!session || session.destroyed || session._preloading) return;
	session._preloading = true;
	try {
		for (let n = idx + 1; n <= Math.min(idx + 2, session.toc.length - 1); n++) {
			if (S !== session || session.destroyed) break;
			try { await getChapterData(n, session); } catch { /* ignore */ }
		}
	} finally {
		session._preloading = false;
	}
}

// ============================================================
//  滚动模式的滚动处理
// ============================================================

let _scrollRaf = 0;
function onScroll() {
	if (!S || S.isPaged || S.loading) return;
	// 滚动事件本身很密集，合并到一帧里算一次，避免每帧都读布局
	if (_scrollRaf) return;
	_scrollRaf = requestAnimationFrame(() => {
		_scrollRaf = 0;
		if (!S || S.destroyed || S.isPaged || S.loading) return;
		updateProgressUI();
		scheduleSaveProgress();

		const body = document.getElementById('rd-body');
		const article = document.getElementById('rd-article');
		if (!body || !article) return;
		const remain = article.scrollHeight - body.scrollTop - body.clientHeight;
		if (remain < 1200) {
			const next = S.range.end + 1;
			if (next < S.toc.length && !S.loaded.has(next)) {
				appendChapter(next);
			}
		}
		if (remain < 40 && S.range.end >= S.toc.length - 1) {
			const loader = document.getElementById('rd-loader');
			if (loader) loader.innerHTML = '<span style="opacity:.6">—— 已是最后一章 ——</span>';
		}
	});
}

function currentReadingBlock() {
	const body = document.getElementById('rd-body');
	if (!body) return null;
	const scrollMid = body.scrollTop + body.clientHeight * 0.35;
	let best = null;
	for (const [idx, item] of S.loaded) {
		if (!item.el || !item.ok) continue;
		const top = item.el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
		if (top <= scrollMid) {
			if (!best || top > best.top) best = { idx, el: item.el, top };
		}
	}
	if (!best) {
		const first = [...S.loaded.entries()][0];
		if (first) {
			const top = first[1].el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
			best = { idx: first[0], el: first[1].el, top };
		}
	}
	return best;
}

// ============================================================
//  进度
// ============================================================

function updateProgressUI() {
	if (!S || S.loading) return;
	const total = S.toc.length;
	if (!total) return;
	let ratio = 0;
	let remainText = '';
	let atBookEnd = false;

	if (S.isPaged) {
		const pages = Math.max(1, S.paged.pageCount);
		// 章节内进度按「已读页数 / 总页数」：单页章节第一页就是 100%，
		// 而不是 page/(pages-1) 那种「第一页就满格」的假进度。
		atBookEnd = S.paged.chapterIdx >= total - 1 && S.paged.page >= pages - 1;
		ratio = (S.paged.chapterIdx + (S.paged.page + 1) / pages) / total;
		// 剩余时间（Kindle 式）
		const data = S._chapterData;
		if (data?.totalChars && pages > 1) {
			const remainPages = pages - 1 - S.paged.page;
			const remainChars = (data.totalChars * remainPages) / pages;
			const min = estimateMinutes(remainChars);
			remainText = remainPages <= 0 ? '本章读完' : `余 ${min} 分`;
		}
	} else {
		const body = document.getElementById('rd-body');
		const cur = currentReadingBlock();
		if (cur) S.visibleIdx = cur.idx;
		let inChapter = 0;
		if (body && cur && cur.el) {
			const chapterHeight = Math.max(1, cur.el.offsetHeight);
			inChapter = Math.min(1, Math.max(0, (body.scrollTop - cur.top + body.clientHeight * 0.35) / chapterHeight));
			ratio = (cur.idx + inChapter) / total;
			atBookEnd = cur.idx >= total - 1 && inChapter >= 0.995;
			// 剩余时间
			const data = cur.el.__chapterData;
			if (data?.totalChars) {
				const remainChars = data.totalChars * (1 - inChapter);
				remainText = inChapter >= 0.985 ? '本章读完' : `章余 ${estimateMinutes(remainChars)} 分`;
			}
		} else {
			ratio = S.visibleIdx / total;
		}
	}
	ratio = Math.min(1, Math.max(0, ratio));
	// 只有真的翻到全书最后一页才显示 100%，否则封顶 99.9%
	if (!atBookEnd) ratio = Math.min(ratio, 0.999);

	const fill = document.getElementById('rd-progress-fill');
	const text = document.getElementById('rd-progress-text');
	const label = document.getElementById('rd-chapter-label');
	if (fill) fill.style.width = `${(ratio * 100).toFixed(1)}%`;
	if (text) text.textContent = `${(ratio * 100).toFixed(1)}%`;
	if (label) {
		const base = S.isPaged
			? `${S.paged.page + 1}/${S.paged.pageCount} 页`
			: `${S.visibleIdx + 1}/${total} 章`;
		label.textContent = remainText ? `${base} · ${remainText}` : base;
	}
}

function setTitle(title) {
	const el = document.getElementById('rd-title');
	if (el) el.textContent = title || S.book.title;
}

/** 章节加载中的轻提示（只动页脚一行字，不做整屏 loading） */
function setLoadingHint(on, text = '') {
	const row = document.querySelector('.reader-progress-row');
	const label = document.getElementById('rd-chapter-label');
	if (row) row.classList.toggle('is-loading', !!on);
	if (on && label && text) label.textContent = text;
}

/**
 * 检查书源是否有新章节（后台静默进行）
 * - 节流：同一本书 2 小时内只检查一次（tocCheckedAt 记在书籍记录中，每台设备独立）
 * - 仅在确认"尾部追加"时更新目录并提示（见 toc-refresh.js）
 */
async function maybeRefreshToc(session, { force = false } = {}) {
	try {
		if (!session || session.destroyed || !session.toc?.length) return null;
		const book = session.book;
		const last = Number(book.tocCheckedAt) || 0;
		if (!force && Date.now() - last < 2 * 3600 * 1000) return null;
		if (session._tocChecking) return session._tocChecking;
		session._tocChecking = (async () => {
			book.tocCheckedAt = Date.now();
			updateBook(book.id, { tocCheckedAt: book.tocCheckedAt }).catch(() => {});
			const res = await refreshBookToc(book);
			if (!res?.added || !isCurrentSession(session)) return res;
			// 会话内目录引用替换：新章节立即可翻到
			const fresh = await getToc(book.id);
			if (fresh?.length) session.toc = fresh;
			toast(`《${book.title}》更新了 ${res.added} 章`, 2400);
			return res;
		})().catch(() => null).finally(() => { session._tocChecking = null; });
		return session._tocChecking;
	} catch {
		return null;
	}
}

function scheduleSaveProgress() {
	const session = S;
	clearTimeout(S._saveT);
	S._saveT = sessionTimeout(() => {
		if (!S || S.destroyed) return;
		// 位置锚点只在这里算一次（滚动时不再每帧做全章排版测量）
		const anchor = getReadingAnchor();
		const payload = {
			anchor,
			bookId: S.book.id,
			chapterIdx: S.visibleIdx,
			chapterTitle: S.toc[S.visibleIdx]?.title || ''
		};
		if (S.isPaged) {
			payload.pageIdx = S.paged.page;
			payload.mode = 'page';
		} else {
			const body = document.getElementById('rd-body');
			payload.scrollTop = body ? body.scrollTop : 0;
			payload.mode = 'scroll';
		}
		saveProgress(payload).catch(() => {});
		updateBook(S.book.id, {
			lastReadAt: Date.now(),
			readChapters: Math.max(S.book.readChapters || 0, S.visibleIdx + 1)
		}).catch(() => {});
	}, 800, session);
}

// ============================================================
//  通用交互
// ============================================================

function toggleMenus(force) {
	const top = document.getElementById('rd-top');
	const bottom = document.getElementById('rd-bottom');
	if (!top || !bottom) return;
	const show = force !== undefined ? force : top.classList.contains('hidden');
	top.classList.toggle('hidden', !show);
	bottom.classList.toggle('hidden', !show);
}

function onKey(e) {
	if (!S || S.destroyed) return;
	// Esc：先关最上层的面板，再退阅读器
	if (e.key === 'Escape') {
		if (closeTopOverlay()) return;
		closeReader();
		return;
	}
	if (document.querySelector('.sheet.show, .dialog-mask.show') || e.target.closest('input, textarea')) return;
	if (!S.isPaged || S.loading || S.turning || hasTextSelection()) return;
	// 支持方向键 + PageUp/PageDown（BOOX 等设备的物理翻页键映射）
	if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
		e.preventDefault();
		if (S.paged.page > 0) gotoPaged(S.paged.page - 1);
		else prevPagedChapter('end'); // 首页回翻 → 上一章末尾（Kindle 行为）
	}
	if (e.key === 'ArrowRight' || e.key === 'PageDown') {
		e.preventDefault();
		if (S.paged.page < S.paged.pageCount - 1) gotoPaged(S.paged.page + 1);
		else nextPagedChapter('start');
	}
}

let _resizeT = 0;
function onResize() {
	if (!S || S.destroyed) return;
	// 旋转屏幕 / 分屏拖拽会连发多次 resize，防抖后只重排一次
	clearTimeout(_resizeT);
	_resizeT = setTimeout(() => {
		if (!S || S.destroyed) return;
		relayout(S.loading ? S.anchor : getReadingAnchor());
	}, 140);
}

// ============================================================
//  面板
// ============================================================

async function showToc() {
	const session = S;
	const cached = new Set(await getCachedChapterIndices(S.book.id));
	if (!isCurrentSession(session)) return;
	const cur = S.visibleIdx;
	const lastRead = Number.isInteger(S.initialIdx) ? S.initialIdx : -1;
	const near = [];
	const from = Math.max(0, cur - 100);
	const to = Math.min(S.toc.length, from + 420);
	for (let i = from; i < to; i++) near.push(i);

	showSheet({
		title: `目录 · 共 ${S.toc.length} 章`,
		build: (body, close) => {
			const jump = document.createElement('div');
			jump.className = 'toc-jump';
			jump.innerHTML = `<input placeholder="输入章节名或序号跳转" />`;
			body.appendChild(jump);

			const list = document.createElement('div');
			list.className = 'toc-list';
			const inputEl = jump.querySelector('input');

			const render = (filter = '') => {
				list.innerHTML = '';
				const f = filter.trim();
				let items = [];
				if (/^\d+$/.test(f) && f.length) {
					const p = parseInt(f, 10) - 1;
					for (let i = Math.max(0, p - 40); i < Math.min(S.toc.length, p + 60); i++) items.push(i);
				} else if (f) {
					S.toc.forEach((c, i) => {
						if (items.length >= 200) return;
						if ((c.title || '').includes(f)) items.push(i);
					});
				} else {
					items = near;
				}
				items.forEach((i, k) => {
					// 本次打开时的位置：给一条分隔线，长书里一眼能找到「我刚才读到哪」
					if (i === lastRead && i !== cur) {
						const mark = document.createElement('div');
						mark.className = 'toc-lastread';
						mark.textContent = '上次读到这里';
						list.appendChild(mark);
					}
					const item = document.createElement('button');
					item.className = `toc-item ${i === cur ? 'current' : ''} ${cached.has(i) ? 'cached' : ''}`;
					item.style.animation = `fadeUp .32s var(--ease-out) both`;
					item.style.animationDelay = `${Math.min(k, 14) * 13}ms`;
					item.innerHTML = `<span class="toc-idx">${i + 1}</span><span class="toc-name">${escapeHtml(S.toc[i].title || `第 ${i + 1} 章`)}</span>`;
					item.onclick = () => {
						close();
						jumpToChapter(i);
					};
					list.appendChild(item);
				});
				if (!items.length) {
					list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--ink-2);font-size:14px">没有找到匹配的章节</div>';
				}
			};
			inputEl.addEventListener('input', () => render(inputEl.value));
			render();
			body.appendChild(list);

			requestAnimationFrame(() => {
				list.querySelector('.toc-item.current')?.scrollIntoView({ block: 'center' });
			});
		}
	});
}

async function jumpToChapter(idx) {
	const session = S;
	if (S.isPaged) {
		await loadPagedChapter(idx, { position: 'start', viaTurn: true });
		return;
	}
	const body = document.getElementById('rd-body');
	if (!body) return;
	const target = S.loaded.get(idx);
	if (target?.el) {
		body.scrollTo({ top: target.el.offsetTop - 12, behavior: 'smooth' });
		S.visibleIdx = idx;
		setTitle(S.toc[idx]?.title);
		updateProgressUI();
		return;
	}
	await loadFrom(idx);
	if (isCurrentSession(session)) body.scrollTop = 0;
}

function showFontPanel() {
	showSheet({
		title: '排版设定',
		build: (body, close) => {
			const wrap = document.createElement('div');
			wrap.className = 'font-panel';

			// 翻页方式（置顶）
			const modeRow = document.createElement('div');
			modeRow.className = 'font-row';
			modeRow.innerHTML = `<span class="fr-label">翻页</span>`;
			const seg2 = document.createElement('div');
			seg2.className = 'segmented';
			seg2.style.flex = '1';
			seg2.innerHTML = `
				<button class="${S.settings.pageMode === 'scroll' ? 'active' : ''}" data-m="scroll">上下滚动</button>
				<button class="${S.settings.pageMode === 'page' ? 'active' : ''}" data-m="page">翻页阅读</button>`;
			seg2.querySelectorAll('button').forEach((b) => {
				b.onclick = () => {
					if (b.dataset.m === S.settings.pageMode) {
						close();
						return;
					}
					// 记住当前位置 → 平滑切换到另一模式
					const app2 = S.app;
					const book = S.book;
					const idx = S.visibleIdx;
					const pageIdx = S.isPaged ? S.paged.page : 0;
					const scrollTop = S.isPaged ? 0 : document.getElementById('rd-body')?.scrollTop || 0;
					const anchor = getReadingAnchor();
					saveSettings({ pageMode: b.dataset.m });
					app2.state.settings = loadSettings();
					close();
					unmountReader();
					app2.go('reader', { book, chapterIdx: anchor?.chapterIdx ?? idx, anchor, pageIdx, scrollTop, skipEnter: true });
				};
			});
			modeRow.appendChild(seg2);

			// 翻页动画（淡化翻页 = Kindle 局部刷新式）
			const animRow = document.createElement('div');
			animRow.className = 'font-row';
			animRow.innerHTML = `<span class="fr-label">动画</span>`;
			const seg3 = document.createElement('div');
			seg3.className = 'segmented';
			seg3.style.flex = '1';
			seg3.innerHTML = `
				<button class="${(S.settings.turnStyle || 'fade') === 'fade' ? 'active' : ''}" data-a="fade">淡化翻页</button>
				<button class="${S.settings.turnStyle === 'slide' ? 'active' : ''}" data-a="slide">平滑滑动</button>`;
			seg3.querySelectorAll('button').forEach((b) => {
				b.onclick = () => {
					seg3.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
					b.classList.add('active');
					S.settings = saveSettings({ turnStyle: b.dataset.a });
					// 选中"淡化翻页"时给用户演示一下短过渡
					if (b.dataset.a === 'fade' && S.isPaged) {
						veilFadeIn(170);
						sessionTimeout(() => veilFadeOut(260), 180);
					}
				};
			});
			animRow.appendChild(seg3);

			// 字号
			const sizeRow = document.createElement('div');
			sizeRow.className = 'font-row';
			sizeRow.innerHTML = `<span class="fr-label">字号</span>`;
			const sizeBtns = document.createElement('div');
			sizeBtns.className = 'font-size-btns';
			const minus = document.createElement('button');
			minus.textContent = 'A';
			minus.style.fontSize = '15px';
			const plus = document.createElement('button');
			plus.textContent = 'A';
			plus.style.fontSize = '23px';
			sizeBtns.append(minus, plus);
			const sizeVal = document.createElement('span');
			sizeVal.style.cssText = 'margin-left:auto;color:var(--ink-2);font-size:14px';
			sizeVal.textContent = `${S.settings.fontSize}px`;
			sizeRow.append(sizeBtns, sizeVal);

			const applyFont = (patch) => {
				const anchor = getReadingAnchor();
				S.settings = saveSettings(patch);
				const rd = document.querySelector('.reader');
				rd.style.setProperty('--rd-fontsize', `${S.settings.fontSize}px`);
				rd.style.setProperty('--rd-lineheight', S.settings.lineHeight);
				rd.style.setProperty('--rd-pgap', `${S.settings.paragraphGap}em`);
				sizeVal.textContent = `${S.settings.fontSize}px`;
				relayout(anchor);
			};
			minus.onclick = () => applyFont({ fontSize: Math.max(14, S.settings.fontSize - 1) });
			plus.onclick = () => applyFont({ fontSize: Math.min(26, S.settings.fontSize + 1) });

			// 行距
			const lineRow = document.createElement('div');
			lineRow.className = 'font-row';
			lineRow.innerHTML = `<span class="fr-label">行距</span>`;
			const lineRange = document.createElement('input');
			lineRange.type = 'range';
			lineRange.min = '1.4';
			lineRange.max = '2.6';
			lineRange.step = '0.1';
			lineRange.value = String(S.settings.lineHeight);
			lineRange.oninput = () => applyFont({ lineHeight: parseFloat(lineRange.value) });
			lineRow.appendChild(lineRange);

			// 段间距
			const gapRow = document.createElement('div');
			gapRow.className = 'font-row';
			gapRow.innerHTML = `<span class="fr-label">段距</span>`;
			const gapRange = document.createElement('input');
			gapRange.type = 'range';
			gapRange.min = '0.2';
			gapRange.max = '1.6';
			gapRange.step = '0.05';
			gapRange.value = String(S.settings.paragraphGap);
			gapRange.oninput = () => applyFont({ paragraphGap: parseFloat(gapRange.value) });
			gapRow.appendChild(gapRange);

			// 字体
			const fontRow = document.createElement('div');
			fontRow.className = 'font-row';
			fontRow.innerHTML = `<span class="fr-label">字体</span>`;
			const seg = document.createElement('div');
			seg.className = 'segmented';
			seg.style.flex = '1';
			seg.innerHTML = `
				<button class="${S.settings.fontFamily === 'serif' ? 'active' : ''}" data-f="serif">宋体</button>
				<button class="${S.settings.fontFamily === 'wenkai' ? 'active' : ''}" data-f="wenkai">文楷</button>
				<button class="${S.settings.fontFamily === 'sans' ? 'active' : ''}" data-f="sans">黑体</button>`;
			seg.querySelectorAll('button').forEach((b) => {
				b.onclick = () => {
					const anchor = getReadingAnchor();
					seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
					b.classList.add('active');
					S.settings = saveSettings({ fontFamily: b.dataset.f });
					const fontVar = b.dataset.f === 'sans' ? 'var(--font-ui)' : b.dataset.f === 'wenkai' ? 'var(--font-wenkai)' : 'var(--font-song)';
					document.querySelector('.reader').style.setProperty('--rd-font', fontVar);
					if (b.dataset.f === 'wenkai') repageWhenWenkaiReady();
					relayout(anchor);
				};
			});
			fontRow.appendChild(seg);

			wrap.append(modeRow, animRow, sizeRow, lineRow, gapRow, fontRow);
			body.appendChild(wrap);
		}
	});
}

function showThemePanel() {
	showSheet({
		title: '阅读主题',
		build: (body) => {
			const row = document.createElement('div');
			row.className = 'theme-row';
			const themes = [
				{ t: 'paper', name: '纸白', sample: '纸' },
				{ t: 'sepia', name: '米黄', sample: '阅' },
				{ t: 'ink', name: '墨水', sample: '墨' },
				{ t: 'green', name: '青禾', sample: '读' },
				{ t: 'night', name: '夜读', sample: '夜' }
			];
			themes.forEach((th) => {
				const d = document.createElement('button');
				d.className = `theme-dot ${S.settings.theme === th.t ? 'active' : ''}`;
				d.innerHTML = `<div class="dot" data-t="${th.t}">${th.sample}</div><span>${th.name}</span>`;
				d.onclick = () => {
					S.settings = saveSettings({ theme: th.t });
					document.querySelector('.reader').dataset.theme = th.t;
					row.querySelectorAll('.theme-dot').forEach((x) => x.classList.remove('active'));
					d.classList.add('active');
					const meta = document.querySelector('meta[name="theme-color"]');
					if (meta) {
						meta.content = document.body.classList.contains('eink') ? '#ffffff' :
							th.t === 'night' ? '#121315' :
							th.t === 'sepia' ? '#f3ead6' :
							th.t === 'ink' ? '#f1f0ea' :
							th.t === 'green' ? '#dfe9dd' : '#fbf7ef';
					}
				};
				row.appendChild(d);
			});
			body.appendChild(row);

			// 前光色温（Kindle 式：阅读中直接调，实时预览）
			const flRow = document.createElement('div');
			flRow.className = 'font-row';
			flRow.style.marginTop = '20px';
			flRow.innerHTML = `<span class="fr-label">前光</span>`;
			const segFl = document.createElement('div');
			segFl.className = 'segmented';
			segFl.style.flex = '1';
			const flNames = { off: '关', low: '柔和', mid: '温暖', high: '琥珀' };
			const curFl = S.settings.frontLight || 'mid';
			Object.entries(flNames).forEach(([k, n]) => {
				const b = document.createElement('button');
				b.textContent = n;
				if (k === curFl) b.classList.add('active');
				b.onclick = () => {
					S.settings = saveSettings({ frontLight: k });
					segFl.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
					b.classList.add('active');
					const rd = document.querySelector('.reader');
					rd.classList.remove('front-light-low', 'front-light-mid', 'front-light-high');
					if (k !== 'off') rd.classList.add(`front-light-${k}`);
					if (S.settings.theme !== 'ink') toast('前光将在「墨水」主题下呈现', 1600);
				};
				segFl.appendChild(b);
			});
			flRow.appendChild(segFl);
			body.appendChild(flRow);
			const flHint = document.createElement('div');
			flHint.style.cssText = 'margin-top:8px;font-size:12px;color:var(--ink-2)';
			flHint.textContent = '暖光呈现于「墨水」主题（≈2700K 琥珀 ↔ 6500K 冷白）';
			body.appendChild(flHint);
		}
	});
}

/**
 * 进度条拖拽跳转：按住页脚进度条左右拖，松手跳到对应页/章。
 * 长书里比翻目录快得多。
 */
function bindProgressScrub() {
	const track = document.querySelector('.reader-progress-row .progress-track');
	if (!track || !S) return;
	let scrubbing = false;

	const ratioAt = (clientX) => {
		const r = track.getBoundingClientRect();
		return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
	};

	const targetAt = (ratio) => {
		if (S.isPaged) {
			const page = Math.round(ratio * Math.max(0, S.paged.pageCount - 1));
			return { kind: 'page', page };
		}
		const idx = Math.min(S.toc.length - 1, Math.max(0, Math.round(ratio * S.toc.length) - 1));
		return { kind: 'chapter', idx };
	};

	const preview = (ratio) => {
		const label = document.getElementById('rd-chapter-label');
		const fill = document.getElementById('rd-progress-fill');
		const text = document.getElementById('rd-progress-text');
		if (fill) fill.style.width = `${(ratio * 100).toFixed(1)}%`;
		if (text) text.textContent = `${(ratio * 100).toFixed(1)}%`;
		if (!label) return;
		const t = targetAt(ratio);
		if (t.kind === 'page') {
			label.textContent = `第 ${t.page + 1}/${S.paged.pageCount} 页`;
		} else {
			const title = S.toc[t.idx]?.title || '';
			label.textContent = `第 ${t.idx + 1} 章${title ? ` · ${title}` : ''}`;
		}
	};

	const start = (e) => {
		if (!S || S.loading) return;
		scrubbing = true;
		track.setPointerCapture?.(e.pointerId);
		track.classList.add('scrubbing');
		preview(ratioAt(e.clientX));
	};
	const move = (e) => {
		if (!scrubbing) return;
		preview(ratioAt(e.clientX));
	};
	const end = (e) => {
		if (!scrubbing) return;
		scrubbing = false;
		track.classList.remove('scrubbing');
		const ratio = ratioAt(e.clientX);
		const t = targetAt(ratio);
		if (t.kind === 'page') gotoPaged(t.page, false);
		else jumpToChapter(t.idx);
		sessionTimeout(updateProgressUI, 40);
	};

	track.addEventListener('pointerdown', start);
	track.addEventListener('pointermove', move);
	track.addEventListener('pointerup', end);
	track.addEventListener('pointercancel', end);
}

function showTimePanel() {	showSheet({
		title: '今日阅读',
		build: (body) => {
			const s = getLimitStateWithExtra();
			const wrap = document.createElement('div');
			const pct = s.enabled ? Math.min(100, Math.round(s.ratio * 100)) : 0;
			wrap.innerHTML = `
				<div style="text-align:center;padding:6px 0 18px">
					<div style="font-size:38px;font-weight:800;letter-spacing:-0.02em">${fmtDuration(s.usedSec)}</div>
					<div style="font-size:13.5px;color:var(--ink-2);margin-top:6px">
						${s.enabled ? (s.exceeded ? '今日额度已用完，明天再来吧' : `限额 ${fmtDuration(s.limitSec)} · 还剩 ${fmtDuration(Math.max(0, s.limitSec - s.usedSec))}`) : '未开启阅读限额'}
					</div>
				</div>
				${s.enabled ? `<div class="progress-track" style="height:6px"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
			`;
			body.appendChild(wrap);

			const note = document.createElement('p');
			note.style.cssText = 'font-size:12.5px;color:var(--ink-3);margin-top:18px;line-height:1.7;text-align:center';
			note.textContent = '只统计前台认真阅读的时间，锁屏与后台不计入';
			body.appendChild(note);
		}
	});
}

function showMore() {
	showSheet({
		title: S.book.title,
		build: (body, close) => {
			const bookmarks = document.createElement('button');
			bookmarks.className = 'btn btn-soft btn-block';
			bookmarks.innerHTML = `${icon('bookmark', 18)} 书签`;
			bookmarks.onclick = () => { close(); showBookmarks(); };
			body.appendChild(bookmarks);
			const rows = [
				{ label: '书籍信息', hint: `${S.book.author || '未知作者'} · ${S.toc.length} 章` },
				{ label: '书源', hint: S.book.sourceName || '' }
			];
			rows.forEach((r) => {
				const el = document.createElement('div');
				el.className = 'setting-row';
				el.innerHTML = `<span class="setting-label">${escapeHtml(r.label)}</span><span class="setting-value">${escapeHtml(r.hint)}</span>`;
				body.appendChild(el);
			});
			// 换源入口：用户读到一半发现当前源缺章/乱码/停更时，
			// 不必退回书架长按（而且书架里只有一个来源时根本没有换源入口）
			if (S.book.sourceId !== 'local') {
				const switchBtn = document.createElement('button');
				switchBtn.className = 'btn btn-soft btn-block';
				switchBtn.style.marginTop = '16px';
				switchBtn.innerHTML = `${icon('list', 18)} 换源`;
				switchBtn.onclick = () => {
					close();
					openSourceSwitcher({
						book: S.book,
						app: S.app,
						getPosition: () => ({
							chapterIdx: S.visibleIdx,
							anchor: getReadingAnchor(),
							chapterTitle: S.toc?.[S.visibleIdx]?.title || ''
						})
					});
				};
				body.appendChild(switchBtn);
			}

			const copyBtn = document.createElement('button');
			copyBtn.className = 'btn btn-soft btn-block';
			copyBtn.style.marginTop = '16px';
			copyBtn.textContent = '复制当前章节链接';
			copyBtn.onclick = () => {
				const url = chapterUrlOf(S.visibleIdx);
				navigator.clipboard?.writeText(url).then(() => toast('已复制')).catch(() => toast('复制失败'));
			};
			body.appendChild(copyBtn);
		}
	});
}

async function addBookmark() {
	const session = S;
	const anchor = getReadingAnchor();
	if (!anchor || S.loading) { toast('请等待章节加载完成'); return; }
	const chapterTitle = S.toc[anchor.chapterIdx]?.title || '';
	const data = S.isPaged ? S._chapterData : S.loaded.get(anchor.chapterIdx)?.el.__chapterData;
	const id = `${S.book.id}:${anchor.chapterIdx}:${anchor.paragraphIdx}:${anchor.charOffset || 0}`;
	try {
		await saveBookmark({ id, bookId: S.book.id, anchor, chapterTitle,
			text: (data?.paragraphs[anchor.paragraphIdx] || '').slice(0, 90), createdAt: Date.now() });
		if (isCurrentSession(session)) toast('书签已保存');
	} catch { toast('书签保存失败'); }
}

async function showBookmarks() {
	const session = S;
	const marks = await getBookmarks(S.book.id);
	if (!isCurrentSession(session)) return;
	marks.sort((a, b) => a.anchor.chapterIdx - b.anchor.chapterIdx || a.anchor.paragraphIdx - b.anchor.paragraphIdx);
	showSheet({ title: `书签 · ${marks.length}`, build: (body, close) => {
		if (!marks.length) { body.textContent = '暂无书签'; return; }
		for (const mark of marks) {
			const row = document.createElement('div');
			row.className = 'bookmark-row';
			const jump = document.createElement('button');
			jump.className = 'bookmark-jump';
			jump.innerHTML = `<strong>${escapeHtml(mark.chapterTitle)}</strong><span>${escapeHtml(mark.text)}</span>`;
			jump.onclick = () => {
				if (!isCurrentSession(session)) return;
				close();
				if (S.isPaged) loadPagedChapter(mark.anchor.chapterIdx, { anchor: mark.anchor });
				else loadFrom(mark.anchor.chapterIdx, { anchor: mark.anchor });
			};
			const remove = document.createElement('button');
			remove.className = 'reader-btn';
			remove.title = '删除书签';
			remove.setAttribute('aria-label', '删除书签');
			remove.innerHTML = icon('trash', 18);
			remove.onclick = async () => { await deleteBookmark(mark.id); row.remove(); };
			row.append(jump, remove);
			body.appendChild(row);
		}
	} });
}

// ============================================================
//  防沉迷计时
// ============================================================

function tickReading() {
	if (!S || S.destroyed) return;
	if (document.visibilityState !== 'visible') return;
	addReadingSeconds(15);
	updateTimeLabel();
	checkLimit();
}

function onVisibility() {
	if (document.visibilityState !== 'visible' && S) {
		persistProgress();
		// 阅读中切后台（未退出阅读器）：进度落库后标记待同步，稍后自动推送
		scheduleSyncAfterRead(600);
	}
	updateTimeLabel();
	// Android 锁屏/切后台后系统会释放 Wake Lock，回到阅读器时重新申请。
	if (document.visibilityState === 'visible' && S?.settings.keepAwake) keepAwake(true);
}

function updateTimeLabel() {
	const el = document.getElementById('rd-time-label');
	if (el) el.textContent = fmtBrief(getLimitStateWithExtra().usedSec);
}

function fmtBrief(sec) {
	return `${Math.floor(sec / 60)}分`;
}

function checkLimit() {
	const s = getLimitStateWithExtra();
	if (!s.enabled) return;
	if (s.exceeded && !S.limitWarned) {
		S.limitWarned = true;
		showLimitDialog();
	} else if (s.nearly && !S.nearlyWarned) {
		S.nearlyWarned = true;
		toast(`今日阅读额度快用完了（还剩 ${fmtDuration(Math.max(0, s.limitSec - s.usedSec))}）`, 3200);
	}
}

function showLimitDialog() {
	if (!S || S.destroyed) return;
	const s = getLimitStateWithExtra();
	showDialog({
		title: '今天的小说时光结束啦',
		text: `你已阅读 ${fmtDuration(s.usedSec)}，完成了今日额度。\n剩下的时间，留给更要紧的事吧。`,
		actions: [
			{ label: '好，合上书', kind: 'primary', value: 'quit' },
			{ label: '再读 10 分钟', kind: 'soft', value: 'extend' }
		]
	}).then(async (v) => {
		if (!S || S.destroyed) return;
		if (v === 'quit') {
			closeReader();
		} else if (v === 'extend') {
			grantExtraMinutes(10);
			S.limitWarned = false;
			toast('好，就 10 分钟 ✌️');
			updateTimeLabel();
		}
	});
}

// ============================================================
//  退出（带退场动画）
// ============================================================

/** 供系统返回键调用：正在阅读时关闭阅读器，返回 true 表示已处理 */
export function closeReaderView() {
	if (S) {
		closeReader();
		return true;
	}
	// 漫画会话走自己的关闭动画
	return closeComicView();
}

function closeReader() {
	const app2 = S?.app;
	if (!app2) return;
	const bookId = S.book.id;
	const readerEl = document.querySelector('.reader');
	unmountReader({ keepDom: true });
	if (readerEl) {
		readerEl.classList.add('leaving');
		setTimeout(() => {
			readerEl.remove();
			app2.exitReader(bookId);
		}, 220);
	} else {
		app2.exitReader(bookId);
	}
}

export function unmountReader({ keepDom = false } = {}) {
	renderGeneration++;
	// 漫画会话没有 S，但同样需要保存进度、释放图片
	unmountComicReader({ keepDom: true });
	const readerEl = document.querySelector('.reader');
	if (S) {
		persistProgress();
		S.destroyed = true;
		S.controller.abort();
		for (const timer of S.timeouts) clearTimeout(timer);
		clearInterval(S.timer);
		S.timer = null;
		clearTimeout(S._saveT);
		clearTimeout(S.paged?._t);
		clearTimeout(_resizeT);
		if (_scrollRaf) { cancelAnimationFrame(_scrollRaf); _scrollRaf = 0; }
		document.removeEventListener('visibilitychange', onVisibility);
		window.removeEventListener('keydown', onKey);
		window.removeEventListener('resize', onResize);
		window.removeEventListener('orientationchange', onResize);
		keepAwake(false);
		S = null;
		// 跨设备同步：退出阅读器后延迟推送进度（已开启同步时）
		scheduleSyncAfterRead();
	}
	setPageKeysEnabled(false);
	// 退出动画由 closeReader 负责，其余情况（切换书籍/排版）直接移除旧层
	if (!keepDom) readerEl?.remove();
}

function persistProgress() {
	if (!S) return;
	const anchor = getReadingAnchor();
	if (!anchor) return;
	const payload = {
		anchor,
		bookId: S.book.id,
		chapterIdx: anchor.chapterIdx,
		chapterTitle: S.toc[anchor.chapterIdx]?.title || ''
	};
	if (S.isPaged) {
		payload.pageIdx = S.paged.page;
		payload.mode = 'page';
	} else {
		const body = document.getElementById('rd-body');
		payload.scrollTop = body ? body.scrollTop : 0;
		payload.mode = 'scroll';
	}
	saveProgress(payload).catch(() => {});
	updateBook(S.book.id, { lastReadAt: Date.now(), readChapters: Math.max(S.book.readChapters || 0, S.visibleIdx + 1) }).catch(() => {});

}
