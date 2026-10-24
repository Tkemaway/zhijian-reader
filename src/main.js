/**
 * 纸间 · 应用入口与路由
 * 页面切换采用交叉淡化过渡；tab 栏常驻不重建
 */
import './app.css';
import { icon, toast, applyInkMode } from './ui/kit.js';
import { loadSettings } from './store/stats.js';
import { startAutoSync } from './store/auto-sync.js';
import { reconcileDuplicateBooks } from './store/reconcile.js';
import { renderLibrary } from './ui/library.js';
import { renderSearch } from './ui/search.js';
import { renderProfile } from './ui/profile.js';
import { renderLocal } from './ui/local.js';
import { renderReader, unmountReader } from './ui/reader.js';

export const app = {
	state: {
		route: 'library',
		settings: loadSettings(),
		reader: null, // { book, chapterIdx, scrollTop, pageIdx }
		_shellReady: false,
		_switching: false
	},

	go(route, params = {}) {
		if (route === 'reader') {
			this.state.route = 'reader';
			this.state.reader = params;
			renderReader(document.getElementById('app'), this);
			return;
		}
		const fromReader = this.state.route === 'reader';
		if (fromReader) {
			unmountReader();
		}
		if (this.state.route === route && this.state._shellReady && !fromReader) return;

		this.state.route = route;
		this.render({ animate: true, fromReader });
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
		container.innerHTML = '';
		container.classList.remove('page-enter');
		container.classList.add('page-enter');
		if (route === 'library') await renderLibrary(container, this);
		else if (route === 'search') await renderSearch(container, this);
		else if (route === 'local') await renderLocal(container, this);
		else if (route === 'profile') await renderProfile(container, this);
	},

	render({ animate = false, fromReader = false } = {}) {
		const root = document.getElementById('app');
		if (!this.state._shellReady || !root.querySelector('.app-shell')) {
			this.buildShell(root);
			this.updateTabs(root);
			this.renderPage(root);
			return;
		}

		this.updateTabs(root);

		// 从阅读器返回：页面已在背后，只需淡入
		if (fromReader) {
			const container = root.querySelector('#page-container');
			container.classList.remove('page-enter');
			container.classList.add('page-enter');
			this.renderPage(root);
			return;
		}

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

// 启动
const bootSettings = loadSettings();
applyInkMode(bootSettings.inkMode);
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
