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
			btn.className = `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-primary' : 'btn-soft'}`;
			if (a.kind === 'danger') btn.style.background = 'var(--danger)';
			btn.textContent = a.label;
			btn.onclick = () => close(a.value !== undefined ? a.value : i);
			actionsEl.appendChild(btn);
		});

		document.body.appendChild(mask);
		requestAnimationFrame(() => mask.classList.add('show'));

		function close(value) {
			mask.classList.remove('show');
			setTimeout(() => {
				mask.remove();
				resolve(value);
			}, 300);
		}
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
	if (build) build(body, close);

	document.body.appendChild(mask);
	document.body.appendChild(sheet);
	requestAnimationFrame(() => {
		mask.classList.add('show');
		sheet.classList.add('show');
	});

	function close() {
		mask.classList.remove('show');
		sheet.classList.remove('show');
		setTimeout(() => {
			mask.remove();
			sheet.remove();
		}, 420);
	}
	mask.addEventListener('click', close);
	return { close };
}

// ---------- 图标 ----------
const ICONS = {
	bookshelf: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
	user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
	back: '<path d="m15 5-7 7 7 7"/>',
	chevronRight: '<path d="m9 5 7 7-7 7"/>',
	list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
	sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
	font: '<path d="M4 20 10 4h1l6 16M6.5 14h9"/>',
	theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/>',
	download: '<path d="M12 3v12m0 0 5-5m-5 5-5-5"/><path d="M5 21h14"/>',
	trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
	clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
	bookmark: '<path d="M6 3h12v18l-6-4.5L6 21z"/>',
	moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
	check: '<path d="m5 12 5 5 9-9"/>',
	more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
	library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
	sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>'
};

export function icon(name, size = 24) {
	const path = ICONS[name] || '';
	return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

// ---------- 小组件 ----------
export function el(tag, className, html) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (html !== undefined) node.innerHTML = html;
	return node;
}

export function fmtMinutes(sec) {
	const m = Math.round(sec / 60);
	if (m < 1) return '不足 1 分钟';
	if (m < 60) return `${m} 分钟`;
	const h = m / 60;
	return h < 10 ? `${h.toFixed(1).replace(/\.0$/, '')} 小时` : `${Math.round(h)} 小时`;
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
