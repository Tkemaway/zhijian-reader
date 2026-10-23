/**
 * 书架页 —— 继续阅读 + 书籍网格 + 今日阅读状态
 */
import { getBooksDeduped, getProgress, deleteBook, getDownload, addBook, updateBook, saveToc, saveChapters } from '../store/db.js';
import { downloadBook, pauseDownload, isDownloading } from '../store/downloads.js';
import { refreshBookToc } from '../store/toc-refresh.js';
// 书籍身份口径：书架分组、换源匹配、查重全部走同一套（与同步层一致）
import { bookTitleAuthorKey } from '../store/book-identity.js';
import { getLimitStateWithExtra, fmtDuration, getTodaySeconds } from '../store/stats.js';
import { icon, toast, showDialog, showSheet, coverGradient } from './kit.js';
import { openSourceSwitcher } from './source-switch.js';
import { rememberImportedFile, uploadLocalBookFile, isFileSyncEnabled } from '../store/book-files.js';
import { parseBookFile } from '../core/importer.js';

export async function renderLibrary(container, app) {
	container.innerHTML = `
		<div style="display:flex;align-items:flex-end;justify-content:space-between">
			<div>
				<div class="page-title">书架</div>
				<div class="page-subtitle">纸上千言，心间一寸</div>
			</div>
			<div style="display:flex;gap:8px;margin-bottom:8px">
				<button class="btn btn-soft btn-sm" id="manage-btn">管理</button>
				<button class="btn btn-soft btn-sm" id="import-btn">导入本地书</button>
			</div>
		</div>
		<div id="read-status"></div>
		<div id="shelf-stage"></div>
		<div id="shelf-info"></div>
		<div id="books-zone"></div>
		<div class="sel-bar" id="sel-bar">
			<span class="sel-count" id="sel-count">已选 0 本</span>
			<button class="btn btn-soft btn-sm" id="sel-all">全选</button>
			<button class="btn btn-soft btn-sm" id="sel-del" style="color:var(--danger)">删除</button>
			<button class="btn btn-primary btn-sm" id="sel-done">完成</button>
		</div>
	`;

	// 导入本地书（TXT / EPUB）
	const fileInput = document.createElement('input');
	fileInput.type = 'file';
	fileInput.accept = '.txt,.epub,.text';
	fileInput.style.display = 'none';
	container.appendChild(fileInput);
	container.querySelector('#import-btn').addEventListener('click', () => fileInput.click());
	fileInput.addEventListener('change', async () => {
		const file = fileInput.files?.[0];
		fileInput.value = '';
		if (file) await importLocalBook(file, app);
	});

	// 今日阅读状态条
	renderStatus(container.querySelector('#read-status'), app);

	// 书籍列表（getBooksDeduped：同身份+同书源的重复记录只呈现一条，
	// 真正的合并由同步时的 reconcile 落库）
	let books = [];
	try {
		books = await getBooksDeduped();
	} catch (e) {
		console.error(e);
	}

	// 按「书名+作者」分组：同一本书的不同书源各是一条独立记录，
	// 但书架只展示当前书源那一条（换源在长按菜单里）
	const groups = new Map();
	for (const b of books) {
		const k = groupKeyOf(b);
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(b);
	}
	const cards = [...groups.values()].map(pickActiveVariant);
	cards.sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));

	const stageEl = container.querySelector('#shelf-stage');
	const infoEl = container.querySelector('#shelf-info');
	const zone = container.querySelector('#books-zone');

	if (!cards.length) {
		stageEl.innerHTML = `
			<div class="empty-state">
				<div class="glyph">纸</div>
				<h3>书架还是空的</h3>
				<p>去「书海」搜一本想看的小说<br/>或把本地的 TXT / EPUB 导入进来</p>
			</div>`;
		return;
	}

	// 一次性取全部进度（轮播信息区与「继续阅读」共用）
	const progressMap = new Map();
	await Promise.all(cards.map(async (b) => {
		try { progressMap.set(b.id, await getProgress(b.id)); } catch { /* ignore */ }
	}));

	const openBook = async (b) => {
		const p = progressMap.get(b.id) || await getProgress(b.id);
		app.go('reader', { book: b, chapterIdx: p?.chapterIdx || 0, scrollTop: p?.scrollTop || 0, pageIdx: p?.pageIdx || 0, anchor: p?.anchor || null });
	};

	let sel = -1; // -1 = 书籍整齐摆放（未挑选）；>=0 = 已抽出某一本
	let manageMode = false;

	const headHtml = () => `
		<div class="shelf-head">
			<span class="shelf-eyebrow">01 / 书架</span>
			<span class="shelf-line"></span>
			<span class="shelf-dot"></span>
			<span class="shelf-total">${cards.length} 本</span>
		</div>`;

	/** 生成一根书脊（active 时附带抽出的封面） */
	const makeSpine = (b, i, active = false) => {
		const p = progressMap.get(b.id);
		const pct = b.totalChapters ? Math.min(100, Math.round(((b.readChapters || 0) / b.totalChapters) * 100)) : 0;
		const bg = b.coverStyle || 'linear-gradient(145deg,#4a4a4c,#242426)';
		const spine = document.createElement('button');
		spine.type = 'button';
		spine.className = `spine${active ? ' is-active' : ''}`;
		spine.style.setProperty('--cover-bg', bg);
		spine.setAttribute('aria-label', b.title);
		spine.innerHTML = `
			<span class="spine-num">N ${String(i + 1).padStart(2, '0')}</span>
			<span class="spine-title">${escapeHtml(b.title)}</span>
			<span class="spine-author">${escapeHtml(b.author || '')}</span>
			${active ? `
				<span class="spine-cover" style="background:${bg}">
					<span class="sc-title">${escapeHtml(b.title)}</span>
					<span class="sc-bottom">
						<span class="sc-author">${escapeHtml(b.author || '')}</span>
						<span class="sc-badge">${p?.chapterTitle ? `读至 ${pct}%` : `${b.totalChapters || 0} 章`}</span>
					</span>
				</span>` : ''}`;
		spine.addEventListener('click', (e) => {
			e.stopPropagation();
			if (Date.now() - lastSwipeAt < 320) return; // 刚滑动完，忽略误触
			if (i === sel) openBook(b); // 再点一次抽出的书 → 开始读
			else { sel = i; renderStage(); renderInfo(); }
		});
		return spine;
	};

	// 初始形态：书籍整整齐齐排成一排（可横向滑动查看）
	const renderNeat = () => {
		stageEl.innerHTML = `
			${headHtml()}
			<div class="spine-stage is-neat"><div class="spine-row"></div></div>`;
		const row = stageEl.querySelector('.spine-row');
		cards.forEach((b, i) => {
			const s = makeSpine(b, i);
			s.style.setProperty('--d', '0');
			s.style.setProperty('--absd', '0');
			row.appendChild(s);
		});
	};

	// 挑选形态：被选中的书从架上抽出、转向正面，两侧书脊后退
	const renderFocus = () => {
		const stageW = stageEl.clientWidth || 360;
		const span = Math.min(5, Math.max(3, Math.floor((stageW - 40) / 66)));
		stageEl.innerHTML = `
			${headHtml()}
			<div class="spine-stage"><div class="spine-row"></div></div>
			<div class="shelf-pager">
				<button class="pager-btn" data-dir="-1" ${sel === 0 ? 'disabled' : ''} aria-label="上一本">‹</button>
				<span class="pager-text">${sel + 1}<i>/</i>${cards.length}</span>
				<button class="pager-btn" data-dir="1" ${sel === cards.length - 1 ? 'disabled' : ''} aria-label="下一本">›</button>
			</div>`;
		const row = stageEl.querySelector('.spine-row');
		for (let i = sel - span; i <= sel + span; i++) {
			if (i < 0 || i >= cards.length) {
				const spacer = document.createElement('span');
				spacer.className = 'spine-slot';
				row.appendChild(spacer);
				continue;
			}
			const s = makeSpine(cards[i], i, i === sel);
			s.style.setProperty('--d', String(i - sel));
			s.style.setProperty('--absd', String(Math.abs(i - sel)));
			row.appendChild(s);
		}
		stageEl.querySelectorAll('.pager-btn').forEach((btn) => {
			btn.addEventListener('click', (e) => { e.stopPropagation(); moveSel(Number(btn.dataset.dir)); });
		});
		// 点书架空白处 → 把书放回去（回到整齐排列）
		stageEl.querySelector('.spine-stage').addEventListener('click', (e) => {
			if (e.target.closest('.spine')) return;
			sel = -1;
			renderStage();
			renderInfo();
		});
	};

	const renderStage = () => (sel < 0 ? renderNeat() : renderFocus());

	const moveSel = (dir) => {
		if (sel < 0) return;
		const next = Math.max(0, Math.min(cards.length - 1, sel + dir));
		if (next === sel) return;
		sel = next;
		renderStage();
		renderInfo();
	};

	// 抽出后左右滑动切书（整齐状态下横滑交给原生滚动）
	let sx = 0;
	let sy = 0;
	let tracking = false;
	let lastSwipeAt = 0;
	stageEl.addEventListener('pointerdown', (e) => {
		if (e.target.closest('.pager-btn')) return;
		tracking = true;
		sx = e.clientX;
		sy = e.clientY;
	});
	stageEl.addEventListener('pointerup', (e) => {
		if (!tracking) return;
		tracking = false;
		if (sel < 0) return;
		const dx = e.clientX - sx;
		const dy = e.clientY - sy;
		if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.2) {
			lastSwipeAt = Date.now();
			moveSel(dx > 0 ? -1 : 1);
		}
	});
	stageEl.addEventListener('pointercancel', () => { tracking = false; });

	const renderInfo = () => {
		// 整齐状态：只给一个继续阅读的入口，不预设选中任何书
		if (sel < 0) {
			const recent = cards[0];
			const rp = recent ? progressMap.get(recent.id) : null;
			infoEl.innerHTML = `
				<div class="shelf-neat-hint">共 ${cards.length} 本 · 点一本书，把它从架上抽出来</div>
				${recent ? `<button class="btn btn-soft btn-block" id="shelf-resume">${rp?.chapterTitle ? `继续阅读《${escapeHtml(recent.title)}》` : `开始阅读《${escapeHtml(recent.title)}》`}</button>` : ''}`;
			infoEl.querySelector('#shelf-resume')?.addEventListener('click', () => openBook(recent));
			return;
		}
		const b = cards[sel];
		const p = progressMap.get(b.id);
		const pct = b.totalChapters ? Math.min(100, Math.round(((b.readChapters || 0) / b.totalChapters) * 100)) : 0;
		infoEl.innerHTML = `
			<div class="shelf-info-head">
				<div style="min-width:0">
					<h2 class="shelf-info-title">${escapeHtml(b.title)}</h2>
					<div class="shelf-info-sub">${escapeHtml(b.author || '未知作者')} · ${b.totalChapters || 0} 章${pct ? ` · 已读 ${pct}%` : ''}</div>
				</div>
				<button class="shelf-more" id="shelf-more" aria-label="更多操作">⋯</button>
			</div>
			<button class="btn btn-primary btn-block" id="shelf-read" style="margin-top:14px">
				${p?.chapterTitle ? `继续阅读 · ${escapeHtml(p.chapterTitle)}` : '开始阅读'}
			</button>`;
		infoEl.querySelector('#shelf-read').addEventListener('click', () => openBook(b));
		infoEl.querySelector('#shelf-more').addEventListener('click', () => showBookActions(b, app, groups.get(groupKeyOf(b))));
	};

	renderStage();
	renderInfo();

	// ---------- 管理视图（网格 + 滑动多选）----------
	const selState = { active: false };
	zone.style.display = 'none';
	const grid = document.createElement('div');
	grid.className = 'manage-grid';
	cards.forEach((book, i) => {
		const card = bookCard(book, app, groups.get(groupKeyOf(book)), selState);
		card.classList.add('stagger-item');
		card.style.animationDelay = `${Math.min(i, 11) * 36}ms`;
		grid.appendChild(card);
	});
	zone.appendChild(grid);
	bindSelection(container, grid, selState, app, (active) => {
		manageMode = active;
		stageEl.style.display = active ? 'none' : '';
		infoEl.style.display = active ? 'none' : '';
		zone.style.display = active ? '' : 'none';
	});
}

/**
 * 书架多选：点「管理」进入；按下并滑动可以连续选中/取消（像整理真实书架）。
 * 未进入多选时保持原交互：点开书、长按菜单。
 */
function bindSelection(container, grid, selState, app, onModeChange) {
	const selBar = container.querySelector('#sel-bar');
	const selCount = container.querySelector('#sel-count');
	const manageBtn = container.querySelector('#manage-btn');
	const selSet = new Set();

	const update = () => { selCount.textContent = `已选 ${selSet.size} 本`; };
	const apply = (card, on) => {
		const id = card?.dataset?.bookId;
		if (!id) return;
		if (on) { selSet.add(id); card.classList.add('selected'); }
		else { selSet.delete(id); card.classList.remove('selected'); }
		update();
	};
	const enter = () => {
		selState.active = true;
		selBar.classList.add('show');
		manageBtn.textContent = '取消';
		onModeChange?.(true);
	};
	const exit = () => {
		selState.active = false;
		selSet.clear();
		selBar.classList.remove('show');
		manageBtn.textContent = '管理';
		grid.querySelectorAll('.book-card.selected').forEach((c) => c.classList.remove('selected'));
		update();
		onModeChange?.(false);
	};

	manageBtn.addEventListener('click', () => (selState.active ? exit() : enter()));
	container.querySelector('#sel-done').addEventListener('click', exit);
	container.querySelector('#sel-all').addEventListener('click', () => {
		grid.querySelectorAll('.book-card').forEach((c) => apply(c, true));
	});
	container.querySelector('#sel-del').addEventListener('click', async () => {
		const ids = [...selSet];
		if (!ids.length) { toast('先选中要删除的书', 1600); return; }
		const ok = await showDialog({
			title: '删除书籍',
			text: `确定删除选中的 ${ids.length} 本书吗？目录、进度与缓存会一并删除。`,
			actions: [
				{ label: '删除', kind: 'danger', value: 1 },
				{ label: '取消', kind: 'soft', value: 0 }
			]
		});
		if (ok !== 1) return;
		for (const id of ids) {
			try { await deleteBook(id); } catch { /* 跳过失败项 */ }
		}
		toast(`已删除 ${ids.length} 本`, 1800);
		exit();
		app.refresh();
	});

	// 滑动连选：按下决定"选"还是"取消"，划过的书随之改变
	let dragging = false;
	let intent = true;
	grid.addEventListener('pointerdown', (e) => {
		if (!selState.active) return;
		const card = e.target.closest('.book-card');
		if (!card) return;
		dragging = true;
		intent = !card.classList.contains('selected');
		apply(card, intent);
		document.addEventListener('pointerup', () => { dragging = false; }, { once: true });
	});
	grid.addEventListener('pointermove', (e) => {
		if (!selState.active || !dragging) return;
		const card = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.book-card');
		if (card && grid.contains(card)) apply(card, intent);
	});
}

/** 今日阅读状态（防沉迷可视化的轻量入口） */
function renderStatus(zone, app) {
	const s = getLimitStateWithExtra();
	const todaySec = getTodaySeconds();

	if (!s.enabled) {
		zone.innerHTML = `
			<div class="read-status-mini">
				<span class="rs-label">今日已读</span>
				<span class="rs-value">${fmtDuration(todaySec)}</span>
			</div>`;
		return;
	}

	const pct = Math.min(100, Math.round(s.ratio * 100));
	const left = Math.max(0, s.limitSec - s.usedSec);
	const over = s.exceeded;
	zone.innerHTML = `
		<div class="read-status-card ${over ? 'over' : ''}">
			<div class="rs-top">
				<span class="rs-label">${over ? '今日额度已用完' : '今日阅读'}</span>
				<span class="rs-value">${fmtDuration(s.usedSec)} <em>/ ${fmtDuration(s.limitSec)}</em></span>
			</div>
			<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
			<div class="rs-hint">${over ? '明天的额度已备好，今天先把书合上吧' : `还可以读 ${fmtDuration(left)}`}</div>
		</div>`;
}

/**
 * 同书分组键（书名+作者）：不同书源的同一本书归为一组，书架只显示一张卡片。
 * 用统一身份口径而非 trim——否则老库里「斗破苍穹」与「斗破苍穹 」会被当成
 * 两本书显示成两张卡片，用户会以为「书架复制了一份」。
 */
function groupKeyOf(book) {
	return bookTitleAuthorKey(book);
}

/** 组内当前书源：用户显式切过的（active）优先，其次本机已缓存（离线可读）的，
 *  再其次最近阅读，最后最近入架 */
function pickActiveVariant(variants) {
	return [...variants].sort((a, b) =>
		(Number(b.activeAt) || 0) - (Number(a.activeAt) || 0) ||
		(b.active ? 1 : 0) - (a.active ? 1 : 0) ||
		(b.cachedChapters || 0) - (a.cachedChapters || 0) ||
		(b.lastReadAt || 0) - (a.lastReadAt || 0) ||
		(b.addedAt || 0) - (a.addedAt || 0))[0];
}

/** 书籍卡片（variants：同书名同作者的全部书源；多个时显示角标并标注当前源） */
function bookCard(book, app, variants = null, selState = null) {
	const el = document.createElement('div');
	el.className = 'book-card';
	el.dataset.bookId = book.id;
	const multi = !!(variants && variants.length > 1);
	const pct = book.totalChapters ? Math.min(100, Math.round(((book.readChapters || 0) / book.totalChapters) * 100)) : 0;
	const subParts = [];
	if ((multi || !book.totalChapters) && book.sourceName) subParts.push(escapeHtml(book.sourceName));
	if (book.totalChapters) subParts.push(`${book.totalChapters} 章 · ${pct}%`);
	else if (!subParts.length) subParts.push(escapeHtml(book.sourceName || ''));
	el.innerHTML = `
		<div class="bc-stack">
			<div class="bc-cover" style="background:${book.coverStyle || 'linear-gradient(145deg,#3a3a3c,#1c1c1e)'}">
				<span class="bc-title">${escapeHtml(book.title)}</span>
				<span class="bc-author">${escapeHtml(book.author || '')}</span>
				${multi ? `<span class="bc-badge">${variants.length} 个源</span>` : ''}
				<span class="bc-check">${icon('check', 14)}</span>
			</div>
			<div class="bc-plank"></div>
		</div>
		<div class="bc-meta">
			<div class="bc-name">${escapeHtml(book.title)}</div>
			<div class="bc-sub">${subParts.join(' · ')}</div>
		</div>`;

	let longPress = null;
	const openActions = () => showBookActions(book, app, variants);
	el.addEventListener('click', async () => {
		if (el.__suppressClick) { el.__suppressClick = false; return; }
		if (selState?.active) return; // 选择模式下由 pointerdown 处理
		const progress = await getProgress(book.id);
		app.go('reader', { book, chapterIdx: progress?.chapterIdx || 0, scrollTop: progress?.scrollTop || 0, pageIdx: progress?.pageIdx || 0, anchor: progress?.anchor || null });
	});
	el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!selState?.active) openActions(); });
	el.addEventListener('touchstart', () => {
		if (selState?.active) return;
		longPress = setTimeout(() => {
			el.__suppressClick = true;
			openActions();
		}, 520);
	}, { passive: true });
	el.addEventListener('touchend', () => clearTimeout(longPress));
	el.addEventListener('touchmove', () => clearTimeout(longPress));
	return el;
}

function showBookActions(book, app, variants = null) {
	showSheet({
		title: book.title,
		build: (body, close) => {
			const isLocal = book.sourceId === 'local';
			const info = document.createElement('div');
			info.innerHTML = `
				<div class="setting-row"><span class="setting-label">作者</span><span class="setting-value">${escapeHtml(book.author || '未知')}</span></div>
				<div class="setting-row"><span class="setting-label">来源</span><span class="setting-value">${escapeHtml(book.sourceName || '')}</span></div>
				<div class="setting-row"><span class="setting-label">章节</span><span class="setting-value">${book.totalChapters || 0} 章 · 已缓存 ${book.cachedChapters || 0} 章</span></div>`;
			body.appendChild(info);

			// 换源：不再要求「书架里已存在多个来源」——面板里可以现场搜索其他书源，
			// 这是用户「读着读着发现当前源缺章/错字/停更」时最需要的入口
			if (!isLocal) {
				const swBtn = document.createElement('button');
				swBtn.className = 'btn btn-soft btn-block';
				swBtn.style.marginTop = '10px';
				swBtn.innerHTML = `${icon('list', 18)} 换源${variants && variants.length > 1 ? `（已有 ${variants.length} 个来源）` : ''}`;
				swBtn.onclick = () => {
					close();
					openSourceSwitcher({ book, app });
				};
				body.appendChild(swBtn);
			}

			if (!isLocal) {
			const cachedBtn = document.createElement('button');
			cachedBtn.className = 'btn btn-primary btn-block';
			cachedBtn.textContent = isDownloading(book.id) ? '暂停缓存' : '继续缓存未下载章节';
			cachedBtn.onclick = async () => {
				if (isDownloading(book.id)) {
					cachedBtn.disabled = true;
					await pauseDownload(book.id);
					cachedBtn.disabled = false;
					cachedBtn.textContent = '继续缓存未下载章节';
				} else {
					cachedBtn.textContent = '暂停缓存';
					continueCaching(book, app, status).finally(() => {
						cachedBtn.textContent = '继续缓存未下载章节';
					});
				}
			};
			body.appendChild(cachedBtn);

			const refreshBtn = document.createElement('button');
			refreshBtn.className = 'btn btn-soft btn-block';
			refreshBtn.style.marginTop = '10px';
			refreshBtn.textContent = '检查新章节';
			refreshBtn.onclick = async () => {
				refreshBtn.disabled = true;
				refreshBtn.textContent = '检查中…';
				try {
					const res = await refreshBookToc(book);
					if (res?.added) {
						toast(`发现 ${res.added} 个新章节（共 ${res.total} 章）`, 2400);
						close();
						app.refresh();
					} else {
						toast(res ? '暂无新章节' : '无法检查这本书的目录', 1800);
						refreshBtn.disabled = false;
						refreshBtn.textContent = '检查新章节';
					}
				} catch (e) {
					toast(`检查失败：${e.message || e}`, 2200);
					refreshBtn.disabled = false;
					refreshBtn.textContent = '检查新章节';
				}
			};
			body.appendChild(refreshBtn);
			const status = document.createElement('p');
			status.className = 'setting-hint';
			status.style.marginTop = '12px';
			body.appendChild(status);
			getDownload(book.id).then((job) => {
				if (job && status.isConnected) status.textContent = `上次缓存：成功 ${job.completed} 章 · 失败 ${job.failed.length} 章${job.status === 'complete' ? ' · 已完成' : ' · 可继续'}`;
			}).catch(() => {});
			}

			const delBtn = document.createElement('button');
			delBtn.className = 'btn btn-soft btn-block';
			delBtn.style.marginTop = '16px';
			delBtn.style.color = 'var(--danger)';
			delBtn.innerHTML = '删除这本书';
			delBtn.onclick = async () => {
				close();
				const ok = await showDialog({
					title: '删除书籍',
					text: `确定删除《${book.title}》吗？已缓存的章节会一并清除。`,
					actions: [
						{ label: '删除', kind: 'danger', value: 1 },
						{ label: '取消', kind: 'soft', value: 0 }
					]
				});
				if (ok === 1) {
					await pauseDownload(book.id);
					await deleteBook(book.id);
					toast('已删除');
					app.refresh();
				}
			};
			body.appendChild(delBtn);
		}
	});
}

/** 从书架继续缓存，跳过已存在章节；任务保持在前台运行并可再次重试。 */
async function continueCaching(book, app, status) {
	try {
		const job = await downloadBook(book, { onProgress: (progress) => {
			if (status?.isConnected) status.textContent = `本次 ${progress.completed + progress.failed.length}/${progress.total} 章 · 成功 ${progress.completed} · 失败 ${progress.failed.length}`;
		} });
		toast(job.status === 'paused' ? '缓存已暂停，可从书架继续' : `已新增缓存 ${job.completed} 章${job.failed.length ? `，${job.failed.length} 章可重试` : ''}`);
		if (app.state.route === 'library') app.refresh();
	} catch (e) {
		toast(`缓存失败：${e.message || e}`);
	}
}

export function escapeHtml(s) {
	return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
//  本地书导入（TXT / EPUB）
// ============================================================

async function importLocalBook(file, app) {
	const name = file.name || '本地书籍';
	toast(`正在导入《${name}》…`, 3000);
	try {
		const buf = await file.arrayBuffer();
		const parsed = parseBookFile(buf, file.name, DOMParser);
		if (!parsed.chapters.length) throw new Error('没有解析到章节');

		const total = parsed.chapters.length;
		const bookId = `imp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		const book = {
			id: bookId,
			title: parsed.title || name.replace(/\.[^.]+$/, ''),
			author: parsed.author || '',
			coverStyle: coverGradient(parsed.title || name),
			sourceId: 'local',
			sourceName: '本地导入',
			bookUrl: '',
			tocUrl: '',
			totalChapters: total,
			cachedChapters: total,
			addedAt: Date.now(),
			lastReadAt: 0
		};
		// addBook 是统一写入闸门：同名同作者的本地书若已存在会返回已有记录，
		// 目录/章节必须挂到它的 id 上，否则数据会写到一条不存在的书记录下
		const saved = await addBook(book);
		const realId = saved?.id || bookId;
		await saveToc(realId, parsed.chapters.map((c) => ({ title: c.title, url: '' })));

		// 全量写入章节（分批，避免单事务过大）
		const list = parsed.chapters.map((c, idx) => ({
			idx,
			title: c.title,
			paragraphs: c.paragraphs,
			url: '',
			totalChars: c.paragraphs.join('').length
		}));
		const BATCH = 80;
		for (let i = 0; i < list.length; i += BATCH) {
			await saveChapters(realId, list.slice(i, i + BATCH));
		}

		if (saved?.__merged) toast(`《${saved.title || book.title}》已在书架，已更新为 ${total} 章`, 2600);
		else toast(`《${book.title}》已导入 · ${total} 章`, 2600);

		// 记住原始文件（跨设备云同步用）；已开启文件同步时后台自动上传
		rememberImportedFile({ ...(saved || book), id: realId }, { bytes: buf, fileName: file.name })
			.then((r) => {
				if (r && isFileSyncEnabled()) {
					uploadLocalBookFile({ ...book, ...(saved || {}), id: realId, fileHash: r.hash, fileRemoteName: r.remoteName, fileName: file.name })
						.catch(() => { /* 上传失败下次同步再试 */ });
				}
			})
			.catch(() => {});
		app.refresh();
	} catch (e) {
		console.error(e);
		toast(`导入失败：${e.message || e}`, 3400);
	}
}
