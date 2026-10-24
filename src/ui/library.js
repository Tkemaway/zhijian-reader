import { getBooksDeduped, getProgress, deleteBook, getDownload, addBook, updateBook, saveToc, saveChapters } from '../store/db.js';
import { downloadBook, pauseDownload, isDownloading } from '../store/downloads.js';
import { refreshBookToc } from '../store/toc-refresh.js';
import { bookTitleAuthorKey } from '../store/book-identity.js';
import { cleanMetaText } from '../core/text-clean.js';
import { getLimitStateWithExtra, fmtDuration, getTodaySeconds } from '../store/stats.js';
import { icon, toast, showDialog, showSheet, coverGradient } from './kit.js';
import { openSourceSwitcher } from './source-switch.js';
import { rememberImportedFile, uploadLocalBookFile, isFileSyncEnabled } from '../store/book-files.js';
import { kickAutoSync, runAutoSync } from '../store/auto-sync.js';
import { isSyncEnabled } from '../store/sync.js';
import { parseBookFile } from '../core/importer.js';

/**
 * 书架页 —— 按 Kindle 书架规范实现：固定 2:3 封面、固定书名槽位、安静网格
 *
 * 三条不变量（来自设计报告）：
 *   1. 封面 2:3 固定容器，多乱的封面都进同一个模子；
 *   2. 书名两行固定槽位（34px），作者行固定（15px），不塌陷、不撑高；
 *   3. 书架区域内不用投影、不用卡片框、不用木纹/倾斜——留白分隔。
 */
// 书籍身份口径：书架分组、换源匹配、查重全部走同一套（与同步层一致）

/** 书架页 resize 监听清理（重新渲染时调用，避免监听堆积） */
let _shelfResizeCleanup = null;

export async function renderLibrary(container, app) {
	container.innerHTML = `
		<header class="shelf-top">
			<h1 class="shelf-title">书架</h1>
			<div class="shelf-tools">
				<button class="shelf-tool shelf-sync" id="sync-btn" aria-label="立即同步" title="立即同步">${icon('refresh', 18)}</button>
				<button class="shelf-tool" id="manage-btn">管理</button>
				<button class="shelf-tool" id="import-btn">导入</button>
			</div>
		</header>
		<div id="read-status"></div>
		<div class="shelf-chips" id="shelf-chips">
			<button class="chip is-on" data-filter="all">全部</button>
			<button class="chip" data-filter="reading">在读</button>
			<button class="chip" data-filter="unread">未读</button>
			<button class="shelf-sort" id="sort-btn">最近阅读 ↓</button>
		</div>
		<div id="continue-zone"></div>
		<div id="books-zone"><div class="skeleton" style="height:180px;margin-top:16px"></div></div>
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

	// 立即同步（不用进设置页）
	const syncBtn = container.querySelector('#sync-btn');
	syncBtn.addEventListener('click', async () => {
		if (syncBtn.classList.contains('is-busy')) return;
		if (!isFileSyncEnabled() && !isSyncEnabled()) {
			toast('先在「我的 → 数据同步」里配置坚果云', 2600);
			return;
		}
		syncBtn.classList.add('is-busy');
		try {
			const r = await runAutoSync({ force: true, reason: 'manual' });
			if (!r) { toast('同步进行中…', 1600); return; }
			const bits = [];
			if (r?.uploaded) bits.push(`上传 ${r.uploaded} 本`);
			if (r?.downloaded) bits.push(`下载 ${r.downloaded} 本`);
			toast(bits.length ? `同步完成 · ${bits.join(' · ')}` : '同步完成 · 已是最新', 2200);
			if (r?.downloaded) app.refresh();
		} catch (e) {
			toast(`同步失败：${e.message || e}`, 2600);
		} finally {
			syncBtn.classList.remove('is-busy');
		}
	});

	// 今日阅读状态
	renderStatus(container.querySelector('#read-status'), app);

	// 书籍列表（去重后按「书名+作者」分组：同一本书的多个书源只展示当前那一条）
	let books = [];
	try {
		books = await getBooksDeduped();
	} catch (e) {
		console.error(e);
	}
	const groups = new Map();
	for (const b of books) {
		const k = groupKeyOf(b);
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(b);
	}
	const cards = [...groups.values()].map(pickActiveVariant);

	const zone = container.querySelector('#books-zone');
	const resumeZone = container.querySelector('#continue-zone');

	if (!cards.length) {
		zone.innerHTML = `
			<div class="empty-state">
				<div class="glyph">纸</div>
				<h3>书架还是空的</h3>
				<p>去「书海」搜一本想看的小说<br/>或把本地的 TXT / EPUB 导入进来</p>
			</div>`;
		return;
	}

	const openBook = async (b) => {
		const p = await getProgress(b.id);
		app.go('reader', { book: b, chapterIdx: p?.chapterIdx || 0, scrollTop: p?.scrollTop || 0, pageIdx: p?.pageIdx || 0, anchor: p?.anchor || null });
	};

	// ---------- 筛选 / 排序 ----------
	let filter = 'all';
	let sort = 'recent';
	const selState = { active: false };
	const selIds = () => [...zone.querySelectorAll('.book-card.selected')].map((c) => c.dataset.bookId);

	const applyFilter = (b) => {
		if (filter === 'reading') return (b.readChapters || 0) > 0 && (b.readChapters || 0) < (b.totalChapters || 0);
		if (filter === 'unread') return !(b.readChapters || 0);
		return true;
	};
	const applySort = (list) => [...list].sort((a, b) =>
		sort === 'added'
			? (b.addedAt || 0) - (a.addedAt || 0)
			: (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));

	let gridEl = null;
	const renderGrid = () => {
		const list = applySort(cards.filter(applyFilter));
		zone.innerHTML = '';
		if (!list.length) {
			zone.innerHTML = `<div class="shelf-empty">这个分类下还没有书</div>`;
			return;
		}
		const grid = document.createElement('div');
		grid.className = 'book-grid fade-in';
		list.forEach((book) => grid.appendChild(bookCard(book, app, groups.get(groupKeyOf(book)), selState)));
		zone.appendChild(grid);
		gridEl = grid;
	};

	// 筛选条
	const chips = container.querySelector('#shelf-chips');
	chips.addEventListener('click', (e) => {
		const btn = e.target.closest('.chip');
		if (!btn) return;
		if (selState.active) return;
		filter = btn.dataset.filter;
		chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-on', c === btn));
		renderGrid();
	});
	const sortBtn = container.querySelector('#sort-btn');
	sortBtn.addEventListener('click', () => {
		if (selState.active) return;
		sort = sort === 'recent' ? 'added' : 'recent';
		sortBtn.textContent = sort === 'recent' ? '最近阅读 ↓' : '最近添加 ↓';
		renderGrid();
	});

	// ---------- 续读卡（书少时不占位置，避免"书架空空却有个大卡"）----------
	const renderResume = async () => {
		if (cards.length < 6) {
			resumeZone.innerHTML = '';
			return;
		}
		const recent = cards.find((b) => b.lastReadAt);
		if (!recent) {
			resumeZone.innerHTML = '';
			return;
		}
		const p = await getProgress(recent.id);
		const total = recent.totalChapters || 0;
		const idx = (p?.chapterIdx ?? 0) + 1;
		resumeZone.innerHTML = '';
		const card = document.createElement('div');
		card.className = 'resume-card';
		card.innerHTML = `
			<div class="resume-cover" style="background:${recent.coverStyle || 'linear-gradient(145deg,#4a4a4c,#242426)'}">
				<span>${escapeHtml(cleanMetaText(recent.title))}</span>
			</div>
			<div class="resume-info">
				<div class="resume-title">${escapeHtml(cleanMetaText(recent.title))}</div>
				<div class="resume-sub">${p?.chapterTitle ? `读到第 ${idx} 章 · 共 ${total} 章` : '还没开始读'}</div>
			</div>
			<button class="resume-go">继续</button>`;
		card.querySelector('.resume-go').addEventListener('click', (e) => {
			e.stopPropagation();
			openBook(recent);
		});
		card.addEventListener('click', () => openBook(recent));
		resumeZone.appendChild(card);
	};

	renderGrid();
	renderResume();
	bindSelection(container, zone, selState, app);
}

/**
 * 书架多选：点「管理」进入；按下并滑动可以连续选中/取消。
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

/**
 * 书籍卡片（Kindle 规范）
 * 结构：封面 2:3（唯一主角）→ 2px 进度线 → 书名（2 行固定槽）→ 作者（1 行固定）
 * 角标最多一个（多书源时显示「N源」），默认沉默。
 */
export function bookCard(book, app, variants = null, selState = null) {
	const el = document.createElement('div');
	el.className = 'book-card';
	el.dataset.bookId = book.id;
	el.setAttribute('role', 'button');
	el.tabIndex = 0;

	const multi = !!(variants && variants.length > 1);
	const total = book.totalChapters || 0;
	const pct = total ? Math.min(100, Math.round(((book.readChapters || 0) / total) * 100)) : 0;
	const title = cleanMetaText(book.title);
	const author = cleanMetaText(book.author || '');
	const bg = book.coverStyle || 'linear-gradient(145deg,#4a4a4c,#242426)';

	el.innerHTML = `
		<div class="bc-cover" style="background:${bg}">
			<span class="bc-title">${escapeHtml(title)}</span>
			<span class="bc-author">${escapeHtml(author)}</span>
			${multi ? `<span class="bc-badge">${variants.length}源</span>` : ''}
			<span class="bc-check">${icon('check', 14)}</span>
		</div>
		<div class="bc-line"><i style="width:${pct}%"></i></div>
		<div class="bc-name">${escapeHtml(title)}</div>
		<div class="bc-byline">${escapeHtml(author || ' ')}</div>`;
	if (pct > 0 && pct < 100) el.classList.add('is-reading');

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

export function showBookActions(book, app, variants = null) {
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

export async function importLocalBook(file, app) {
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
		kickAutoSync(); // 导入完自动同步一次（3 秒内多次导入会合并）
		app.refresh();
	} catch (e) {
		console.error(e);
		toast(`导入失败：${e.message || e}`, 3400);
	}
}
