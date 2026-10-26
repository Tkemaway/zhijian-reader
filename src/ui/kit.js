/**
 * UI 基础组件 —— Toast / Dialog / Sheet / 图标
 */

// ---------- Toast ----------
let toastTimer = null;
export function toast(msg, duration = 2200) {
	let el = document.querySelector('.toast');
	if (!el) {
		el = document.createElement('div');
		el.className = 'toast';
		document.body.appendChild(el);
	}
	el.textContent = msg;
	requestAnimationFrame(() => el.classList.add('show'));
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ---------- 浮层栈（Esc / 返回键先关最上层） ----------
const overlays = [];
function pushOverlay(close) {
	overlays.push(close);
	return () => {
		const i = overlays.indexOf(close);
		if (i >= 0) overlays.splice(i, 1);
	};
}

/** 关闭最上层浮层；没有浮层时返回 false（调用方继续处理，比如退出阅读器） */
export function closeTopOverlay() {
	const close = overlays[overlays.length - 1];
	if (!close) return false;
	close();
	return true;
}

// ---------- Dialog ----------
export function showDialog({ title, text, actions = [] }) {
	return new Promise((resolve) => {
		const mask = document.createElement('div');
		mask.className = 'dialog-mask';
		mask.innerHTML = `
			<div class="dialog">
				<div class="dialog-title"></div>
				${text ? '<div class="dialog-text"></div>' : ''}
				<div class="dialog-actions"></div>
			</div>`;
		mask.querySelector('.dialog-title').textContent = title || '';
		if (text) mask.querySelector('.dialog-text').textContent = text;

		const actionsEl = mask.querySelector('.dialog-actions');
		actions.forEach((a, i) => {
			const btn = document.createElement('button');
			const kind = a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-soft';
			btn.className = `btn ${kind}`;
			btn.textContent = a.label;
			btn.onclick = () => close(a.value !== undefined ? a.value : i);
			actionsEl.appendChild(btn);
		});

		document.body.appendChild(mask);
		requestAnimationFrame(() => mask.classList.add('show'));
		let pop = () => {};

		function close(value) {
			pop();
			mask.classList.remove('show');
			setTimeout(() => {
				mask.remove();
				resolve(value);
			}, 300);
		}
		pop = pushOverlay(() => close(-1));
		mask.addEventListener('click', (e) => {
			if (e.target === mask) close(-1);
		});
	});
}

// ---------- Sheet ----------
export function showSheet({ title, build }) {
	const mask = document.createElement('div');
	mask.className = 'sheet-mask';
	const sheet = document.createElement('div');
	sheet.className = 'sheet';
	sheet.innerHTML = `<div class="sheet-handle"></div>${title ? '<div class="sheet-title"></div>' : ''}`;
	if (title) sheet.querySelector('.sheet-title').textContent = title;

	const body = document.createElement('div');
	sheet.appendChild(body);
	let pop = () => {};
	let closed = false;
	if (build) build(body, close);

	document.body.appendChild(mask);
	document.body.appendChild(sheet);
	requestAnimationFrame(() => {
		mask.classList.add('show');
		sheet.classList.add('show');
	});

	function close() {
		if (closed) return;
		closed = true;
		pop();
		sheet.style.transform = '';
		mask.classList.remove('show');
		sheet.classList.remove('show');
		setTimeout(() => {
			mask.remove();
			sheet.remove();
		}, 420);
	}
	pop = pushOverlay(close);
	mask.addEventListener('click', close);
	bindSheetDrag(sheet, close);
	return { close };
}

/** 按住顶部把手/标题下滑关闭（仅触摸设备，避免和桌面端预览的居中变换打架） */
function bindSheetDrag(sheet, close) {
	if (typeof window === 'undefined' || !window.matchMedia?.('(hover: none)').matches) return;
	let startY = 0;
	let startT = 0;
	let dy = 0;
	let dragging = false;

	sheet.addEventListener('pointerdown', (e) => {
		// 只从把手或标题起手，避免和内容里的滑杆/按钮抢手势
		if (!e.target.closest('.sheet-handle, .sheet-title')) return;
		dragging = true;
		startY = e.clientY;
		startT = Date.now();
		dy = 0;
		sheet.style.transition = 'none';
		sheet.setPointerCapture?.(e.pointerId);
	});
	sheet.addEventListener('pointermove', (e) => {
		if (!dragging) return;
		dy = Math.max(0, e.clientY - startY);
		sheet.style.transform = `translateY(${dy}px)`;
	});
	const end = () => {
		if (!dragging) return;
		dragging = false;
		sheet.style.transition = '';
		const speed = dy / Math.max(1, Date.now() - startT);
		if (dy > 88 || (dy > 24 && speed > 0.55)) {
			close();
		} else {
			sheet.style.transform = '';
		}
	};
	sheet.addEventListener('pointerup', end);
	sheet.addEventListener('pointercancel', end);
}

// ---------- 图标 ----------
const ICONS = {
	search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
	user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
	back: '<path d="m15 5-7 7 7 7"/>',
	chevronRight: '<path d="m9 5 7 7-7 7"/>',
	list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
	font: '<path d="M4 20 10 4h1l6 16M6.5 14h9"/>',
	theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/>',
	download: '<path d="M12 3v12m0 0 5-5m-5 5-5-5"/><path d="M5 21h14"/>',
	trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
	clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
	bookmark: '<path d="M6 3h12v18l-6-4.5L6 21z"/>',
	check: '<path d="m5 12 5 5 9-9"/>',
	more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
	library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
	folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	columns: '<rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/>',
	refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v6h-6"/>'
};

export function icon(name, size = 24) {
	const path = ICONS[name] || '';
	return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

/** 生成书籍封面的渐变（根据书名哈希） */
export function coverGradient(str) {
	let h = 0;
	for (let i = 0; i < (str || '').length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
	const h1 = h;
	const h2 = (h + 40) % 360;
	return `linear-gradient(145deg, hsl(${h1} 32% 46%), hsl(${h2} 36% 31%))`;
}

/** 应用纸墨护眼模式（普通 Android 上的 Kindle 式纸墨观感） */
export function applyInkMode(on) {
	const ink = !!on;
	document.body.classList.toggle('ink-mode', ink);
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.content = ink ? '#e8e7e1' : '#faf8f5';
}
