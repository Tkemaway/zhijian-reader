/**
 * 纸间 · 应用入口与路由
 * 页面切换采用交叉淡化过渡；tab 栏常驻不重建
 */
import './app.css';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { icon, toast, applyInkMode, closeTopOverlay } from './ui/kit.js';
import { loadSettings } from './store/stats.js';
import { applyDisplayMode } from './store/display.js';
import { getProgress } from './store/db.js';
import { startAutoSync } from './store/auto-sync.js';
import { reconcileDuplicateBooks } from './store/reconcile.js';
import { renderLibrary } from './ui/library.js';
import { renderSearch } from './ui/search.js';
import { renderProfile } from './ui/profile.js';
import { renderLocal } from './ui/local.js';
import { renderReader, closeReaderView } from './ui/reader.js';

export const app = {
	state: {
		route: 'library',
		settings: loadSettings(),
		reader: null, // { book, chapterIdx, scrollTop, pageIdx }
		scrollY: {}, // 每个 tab 上次的滚动位置（返回时恢复）
		readingBookId: null, // 正在读的书
		returnRoute: 'library', // 从哪个页面进的阅读器
		_shellReady: false,
		_switching: false
	},

	go(route, params = {}) {
		// 阅读器是浮层：底下那页保持原样，不销毁、不重排
		if (route === 'reader') {
			if (this.state.route !== 'reader') {
				const pageEl = document.getElementById('page-container');
				if (pageEl) this.state.scrollY[this.state.route] = pageEl.scrollTop;
				this.state.returnRoute = this.state.route;
			}
			this.state.readingBookId = params.book?.id || null;
			this.state.route = 'reader';
			this.state.reader = params;
			renderReader(document.getElementById('app'), this);
			return;
		}
		if (this.state.route === 'reader') {
			// 收起浮层，再继续按目标路由走（不是简单回到原页面）
			this.exitReader(this.state.readingBookId);
			if (this.state.route === route) return;
		}
		const pageEl = document.getElementById('page-container');
		if (pageEl) this.state.scrollY[this.state.route] = pageEl.scrollTop;
		if (this.state.route === route && this.state._shellReady) return;

		this.state.route = route;
		this.render({ animate: true });
	},

	/** 阅读器关闭：只切状态与高亮，不重建书架 */
	exitReader(bookId) {
		const route = this.state.returnRoute || 'library';
		this.state.route = route;
		this.state.reader = null;
		this.updateTabs(document.getElementById('app'));
		// 退出阅读器后把系统栏颜色交还给 App 主题
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) {
			meta.content = document.body.classList.contains('eink') ? '#ffffff'
				: document.body.classList.contains('ink-mode') ? '#e8e7e1' : '#faf8f5';
		}
		if (bookId) this.refreshReadCard(bookId);
	},

	/** 原位点亮刚读完的那本，并把进度线补到最新（不重排书架） */
	async refreshReadCard(bookId) {
		const card = document.querySelector(`.book-card[data-book-id="${CSS.escape(bookId)}"]`);
		if (!card) return;
		card.classList.add('just-read');
		setTimeout(() => card.classList.remove('just-read'), 1100);
		try {
			const total = Number(card.dataset.total) || 0;
			const p = await getProgress(bookId);
			if (!total || !p) return;
			const pct = Math.min(100, Math.round((((p.chapterIdx || 0) + 1) / total) * 100));
			const bar = card.querySelector('.bc-line i');
			if (bar) bar.style.width = `${pct}%`;
		} catch { /* 进度线更新失败不影响返回 */ }
	},

	/** 重渲当前页（无过渡，用于数据刷新） */
	refresh() {
		this.render({ animate: false });
	},

	/** 骨架（只建一次） */
	buildShell(root) {
		root.innerHTML = `
			<div class="app-shell">
				<div class="page page-enter" id="page-container"></div>
				<nav class="tabbar" id="tabbar">
					<div class="tabbar-inner">
						<button class="tab-item" data-route="library">${icon('library', 24)}<span>书架</span></button>
						<button class="tab-item" data-route="search">${icon('search', 24)}<span>书海</span></button>
						<button class="tab-item" data-route="local">${icon('folder', 24)}<span>本地</span></button>
						<button class="tab-item" data-route="profile">${icon('user', 24)}<span>我的</span></button>
					</div>
				</nav>
			</div>`;
		root.querySelectorAll('.tab-item').forEach((btn) => {
			btn.addEventListener('click', () => {
				// 刚在底栏上滑过 → 忽略这次点击（否则会跳回起点那页）
				if (Date.now() - (this._dockSlideAt || 0) < 350) return;
				if (this.state.route !== btn.dataset.route) this.go(btn.dataset.route);
			});
		});

		// 手指沿底栏横向滑动切换页面（对齐源项目 GlassDock 的交互）
		const dock = root.querySelector('#tabbar');
		const tabs = [...dock.querySelectorAll('.tab-item')];
		const indexAt = (x) => {
			for (let i = 0; i < tabs.length; i++) {
				const r = tabs[i].getBoundingClientRect();
				if (x >= r.left && x <= r.right) return i;
			}
			return -1;
		};
		let pressing = false;
		let startX = 0;
		let hover = -1;
		const clearNear = () => tabs.forEach((el) => el.classList.remove('is-near'));
		dock.addEventListener('pointerdown', (e) => {
			if (!e.target.closest('.tab-item')) return;
			pressing = true;
			startX = e.clientX;
			hover = indexAt(e.clientX);
			dock.classList.add('is-pressing');
		});
		dock.addEventListener('pointermove', (e) => {
			if (!pressing) return;
			const i = indexAt(e.clientX);
			if (i === -1 || i === hover) return;
			hover = i;
			clearNear();
			tabs[i]?.classList.add('is-near');
		});
		const finishPress = (e, cancelled = false) => {
			if (!pressing) return;
			pressing = false;
			dock.classList.remove('is-pressing');
			clearNear();
			if (cancelled) return;
			if (Math.abs(e.clientX - startX) <= 10) return; // 普通点击交给 click
			const i = indexAt(e.clientX);
			const route = i >= 0 ? tabs[i]?.dataset.route : null;
			if (route && route !== this.state.route) {
				this._dockSlideAt = Date.now();
				this.go(route);
			}
		};
		dock.addEventListener('pointerup', (e) => finishPress(e));
		dock.addEventListener('pointercancel', (e) => finishPress(e, true));
		this.state._shellReady = true;
	},

	updateTabs(root) {
		root.querySelectorAll('.tab-item').forEach((btn) => {
			btn.classList.toggle('active', btn.dataset.route === this.state.route);
		});
	},

	async renderPage(root) {
		const container = root.querySelector('#page-container');
		if (!container) return;
		const route = this.state.route;
		// 阅读器是浮层，底下这页保持原样（包括滚动位置与已渲染的卡片）
		if (route === 'reader') return;
		container.innerHTML = '';
		container.dataset.route = route;
		container.classList.remove('page-enter');
		container.classList.add('page-enter');
		if (route === 'library') await renderLibrary(container, this);
		else if (route === 'search') await renderSearch(container, this);
		else if (route === 'local') await renderLocal(container, this);
		else if (route === 'profile') await renderProfile(container, this);

		// 恢复该页上次的滚动位置
		const y = this.state.scrollY?.[route];
		if (y) container.scrollTop = y;
	},

	render({ animate = false } = {}) {
		const root = document.getElementById('app');
		if (!this.state._shellReady || !root.querySelector('.app-shell')) {
			this.buildShell(root);
			this.updateTabs(root);
			this.renderPage(root);
			return;
		}

		this.updateTabs(root);

		if (!animate) {
			this.renderPage(root);
			return;
		}

		// 交叉淡化：旧页淡出 → 换内容 → 新页淡入
		if (this.state._switching) return;
		this.state._switching = true;
		const container = root.querySelector('#page-container');
		container.classList.add('page-leave');
		setTimeout(() => {
			container.classList.remove('page-leave');
			this.renderPage(root);
			this.state._switching = false;
		}, 160);
	}
};

// 系统返回键：先关面板 → 再退阅读器 → 再回书架 → 最后才退出 App
// （Android 上不接管的话，任何页面按返回都会直接回桌面）
function handleBack() {
	if (closeTopOverlay()) return true;
	if (app.state.route === 'reader') return closeReaderView();
	if (app.state.route !== 'library') {
		app.go('library');
		return true;
	}
	return false;
}

if (Capacitor.isNativePlatform()) {
	CapApp.addListener('backButton', () => {
		if (handleBack()) return;
		CapApp.exitApp();
	});
}

// 启动
const bootSettings = loadSettings();
applyInkMode(bootSettings.inkMode);
applyDisplayMode(bootSettings);
app.render();

// 启动即整理书架：把历史上被旧同步逻辑复制出来的重复记录合并回一条。
// 不依赖同步开关——未开启同步的老用户同样会有存量重复，只靠界面分组掩盖，
// 库里的重复记录会一直在（换源面板、统计书数、存储占用都会被它影响）。
reconcileDuplicateBooks()
	.then((res) => {
		if (res?.merged) {
			app.refresh(); // 当前若停在书架页，立刻反映整理结果
		}
	})
	.catch(() => { /* 整理失败不影响启动 */ });

// 跨设备同步：已开启时启动即静默拉取一次（尽早，保证打开书前进度已是最新）
// 自动同步：启动、回到前台、网络恢复、每 5 分钟各跑一轮
// （配置了坚果云但没开同步时会自动开启；本地书自动上传/下载）
startAutoSync({ notify: (msg) => toast(msg, 2200) });
