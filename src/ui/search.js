/**
 * 书海页 —— 聚合搜索 + 加入书架（下载）
 */
import sources from '../core/sources.js';
import { searchAll, fetchToc } from '../core/engine.js';
import { addBook, saveToc } from '../store/db.js';
import { findSameBookRecord } from '../store/book-identity.js';
import { downloadBook } from '../store/downloads.js';
import { icon, toast, showDialog, coverGradient } from './kit.js';
import { escapeHtml } from './library.js';

const HISTORY_KEY = 'zj-search-history-v1';

export function renderSearch(container, app) {
	container.innerHTML = `
		<div class="page-title">书海</div>
		<div class="page-subtitle" id="src-count"></div>
		<div class="shelf-chips" id="kind-chips" style="margin:0 0 10px">
			<button class="chip" data-kind="text">小说</button>
			<button class="chip" data-kind="comic">漫画</button>
		</div>
		<div class="setting-hint" id="kind-hint" style="margin:0 2px 12px;line-height:1.7"></div>
		<div class="search-bar">
			${icon('search', 18)}
			<input id="q" type="search" placeholder="搜书名或作者" enterkeyhint="search" autocomplete="off" />
			<button class="search-clear" id="q-clear" style="display:none">×</button>
		</div>
		<div id="search-hint"></div>
		<div id="results"></div>
	`;

	const input = container.querySelector('#q');
	const clearBtn = container.querySelector('#q-clear');
	const hint = container.querySelector('#search-hint');
	const results = container.querySelector('#results');

	// 小说 / 漫画分开搜：漫画源的内容规则和小说源完全不同，混着搜只会浪费时间
	const enabledCount = (kind) => sources.filter((s) => s.enabled !== false && (kind === 'comic' ? s.kind === 'comic' : s.kind !== 'comic')).length;
	const comicCount = enabledCount('comic');
	const textCount = enabledCount('text');
	let activeKind = comicCount && !textCount ? 'comic' : 'text';
	const srcCount = container.querySelector('#src-count');
	const kindHint = container.querySelector('#kind-hint');
	const refreshSubtitle = () => {
		const n = enabledCount(activeKind);
		srcCount.textContent = `${n} 个${activeKind === 'comic' ? '漫画' : '小说'}源为你待命`;
		// 没有漫画源时别让「漫画」变成死路：直接告诉用户去哪里加
		kindHint.textContent = activeKind === 'comic' && !n
			? '还没有漫画源。内置源都是小说站，请到「我的 → 书源 → 添加」粘贴 Legado 漫画书源（bookSourceType: 2）'
			: '';
	};
	const kindChips = container.querySelector('#kind-chips');
	if (kindChips) {
		const paint = () => kindChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-on', c.dataset.kind === activeKind));
		paint();
		kindChips.querySelectorAll('.chip').forEach((chip) => {
			chip.addEventListener('click', () => {
				if (searching) return;
				activeKind = chip.dataset.kind;
				paint();
				refreshSubtitle();
				results.innerHTML = '';
				hint.innerHTML = '';
				renderHistory(results, input, app);
			});
		});
	}
	refreshSubtitle();

	// 搜索历史
	renderHistory(results, input, app);

	input.addEventListener('input', () => {
		clearBtn.style.display = input.value ? '' : 'none';
	});
	clearBtn.addEventListener('click', () => {
		input.value = '';
		clearBtn.style.display = 'none';
		renderHistory(results, input, app);
	});
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && input.value.trim()) {
			doSearch(input.value.trim());
		}
	});

	let searching = false;

	async function doSearch(keyword) {
		if (searching) return;
		searching = true;
		saveHistory(keyword);
		results.innerHTML = '';
		hint.innerHTML = '';

		const enabled = sources.filter((s) => s.enabled !== false && (activeKind === 'comic' ? s.kind === 'comic' : s.kind !== 'comic'));
		if (!enabled.length) {
			hint.textContent = activeKind === 'comic' ? '还没有漫画源，先到「我的 → 书源」添加' : '没有启用的书源';
			searching = false;
			return;
		}
		const allResults = [];
		const statusMap = new Map();
		const rowMap = new Map(); // 结果对象 → DOM 行

		// 状态行
		const statusEl = document.createElement('div');
		statusEl.className = 'search-status';
		statusEl.textContent = `正在搜索 ${enabled.length} 个书源…`;
		hint.appendChild(statusEl);

		const listEl = document.createElement('div');
		listEl.className = 'result-list';
		results.appendChild(listEl);

		const updateStatus = () => {
			const doneCount = [...statusMap.values()].filter((v) => v.done).length;
			statusEl.textContent = `正在搜索 ${enabled.length} 个书源…（${doneCount}/${enabled.length}）`;
			if (allResults.length) statusEl.classList.add('has-result');
		};

		/** 增量追加新结果（每行带进场动画，不重建列表） */
		const addResults = (list) => {
			const frag = document.createDocumentFragment();
			let added = 0;
			for (const r of list) {
				if (rowMap.has(r)) continue;
				const row = resultRow(r, app, keyword);
				row.classList.add('result-row-enter');
				rowMap.set(r, row);
				frag.appendChild(row);
				added++;
			}
			if (added) {
				listEl.appendChild(frag);
				// 控制进场动画的总时长不至于排长队
				[...rowMap.values()].slice(-added).forEach((el, i) => {
					el.style.animationDelay = `${Math.min(i, 6) * 28}ms`;
					setTimeout(() => { el.style.animationDelay = ''; el.classList.remove('result-row-enter'); }, 600 + i * 30);
				});
			}
			return added;
		};

		await searchAll(enabled, keyword, {
			concurrency: 4,
			onSourceStart: (source) => {
				statusMap.set(source.id, { done: false });
				updateStatus();
			},
			onSourceResult: (source, list, error) => {
				statusMap.set(source.id, { done: true, count: list.length, error });
				allResults.push(...list);
				addResults(list);
				updateStatus();
			}
		});

		searching = false;
		const ok = [...statusMap.values()].filter((v) => v.done && !v.error).length;
		if (!allResults.length) {
			hint.innerHTML = '';
			results.innerHTML = `
				<div class="empty-state">
					<div class="glyph">空</div>
					<h3>没有找到「${escapeHtml(keyword)}」</h3>
					<p>换个关键词试试，或稍后再搜（部分书源可能临时受限）</p>
				</div>`;
		} else {
			statusEl.textContent = `共 ${allResults.length} 条结果 · ${ok}/${enabled.length} 个书源响应`;
			// 全部完成后：FLIP 平滑重排（按匹配度）
			flipReorder(listEl, rowMap, allResults, keyword);
		}
	}
}

/** FLIP 动画：平滑重排搜索结果（先记录位置 → 排序 → 反向位移还原 → 播放） */
function flipReorder(listEl, rowMap, allResults, keyword) {
	const rows = [...rowMap.values()];
	if (rows.length < 2) return;

	const firstTops = new Map();
	rows.forEach((el) => firstTops.set(el, el.getBoundingClientRect().top));

	allResults.sort((a, b) => scoreMatch(b.bookName, keyword) - scoreMatch(a.bookName, keyword));
	const frag = document.createDocumentFragment();
	allResults.forEach((r) => {
		const el = rowMap.get(r);
		if (el) frag.appendChild(el);
	});
	listEl.appendChild(frag);

	let moved = 0;
	rows.forEach((el) => {
		const last = el.getBoundingClientRect().top;
		const delta = firstTops.get(el) - last;
		if (Math.abs(delta) < 2) return;
		moved++;
		el.style.transition = 'none';
		el.style.transform = `translateY(${delta}px)`;
		requestAnimationFrame(() => {
			el.style.transition = 'transform 0.55s var(--ease-out)';
			el.style.transform = '';
		});
		setTimeout(() => {
			el.style.transition = '';
			el.style.transform = '';
		}, 600);
	});
	if (moved) {
		// 重排完成后给个轻提示
		setTimeout(() => toast('已按匹配度整理结果', 1500), 120);
	}
}

function scoreMatch(name, kw) {
	if (!name) return 0;
	let s = 0;
	if (name === kw) s += 100;
	else if (name.startsWith(kw)) s += 60;
	else if (name.includes(kw)) s += 30;
	s -= Math.min(20, name.length - kw.length);
	return s;
}

/** 搜索结果行 */
function resultRow(r, app, keyword) {
	const el = document.createElement('div');
	el.className = 'result-row';
	el.innerHTML = `
		<div class="rr-main">
			<div class="rr-title">${escapeHtml(r.bookName)}${r.directHit ? '<span class="rr-tag">直达</span>' : ''}${sources.find((s) => s.id === r.sourceId)?.kind === 'comic' ? '<span class="rr-tag rr-tag-comic">漫画</span>' : ''}</div>
			<div class="rr-meta">
				${r.author ? `<span>${escapeHtml(r.author.replace(/^作者[:：]\s*/, ''))}</span>` : ''}
				${r.latestChapter ? `<span class="rr-latest">${escapeHtml(r.latestChapter.slice(0, 24))}</span>` : ''}
			</div>
			<div class="rr-source">${escapeHtml(r.sourceName)}</div>
		</div>
		<button class="btn btn-primary btn-sm rr-add">${icon('download', 15)} 入架</button>`;

	el.querySelector('.rr-add').addEventListener('click', (e) => {
		e.stopPropagation();
		startJoin(r, app, el);
	});
	return el;
}

/** 加入书架（选章节范围 → 下载） */
async function startJoin(r, app, rowEl) {
	const btn = rowEl.querySelector('.rr-add');
	if (btn.disabled) return;
	btn.disabled = true;
	btn.textContent = '准备中…';

	const source = sources.find((s) => s.id === r.sourceId);
	if (!source) {
		toast('书源不存在');
		btn.disabled = false;
		return;
	}

	// 同书同源已在架 → 不重复入架（换一个书源搜同一本书则会作为新来源加入，形成多源）
	// 用 book-identity 的统一口径判定：手写 trim 拼接会漏掉
	//「《书名》」「作者：xx」「首尾空格」等写法差异，导致同一本书被反复入架
	const author = r.author ? r.author.replace(/^作者[:：]\s*/, '') : '';
	const candidate = { title: r.bookName, author, sourceId: source.id };
	const already = !!findSameBookRecord(candidate, await getBooks());
	if (already) {
		toast('这本书已在此书源入架');
		btn.innerHTML = `${icon('check', 15)} 已入架`;
		return;
	}

	try {
		// 1. 抓目录（番茄入口已预拉取，直接复用）
		const toc = r.__preToc || await fetchToc(source, { bookUrl: r.bookUrl }, undefined);
		if (toc.error || !toc.chapters.length) {
			toast(`目录获取失败：${toc.error || '无章节'}`);
			btn.disabled = false;
			btn.innerHTML = `${icon('download', 15)} 入架`;
			return;
		}

		// 2. 询问缓存范围（番茄源为官方试读：仅免费章节可缓存）
		const total = toc.chapters.length;
		const isFanqie = source.type === 'fanqie';
		const freeCount = isFanqie ? toc.chapters.filter((c) => !c.locked).length : 0;
		const isComic = source.kind === 'comic';
		const choice = await showDialog({
			title: `加入书架`,
			text: isFanqie
				? `《${r.bookName}》共 ${total} 章（番茄官方免费 ${freeCount} 章）\n其余章节为试读片段，需在番茄 App 内阅读`
				: isComic
					? `《${r.bookName}》共 ${total} 话\n漫画按话缓存图片，建议先缓存 3 话试读`
					: `《${r.bookName}》共 ${total} 章\n选择缓存范围（可随时继续缓存）`,
			actions: isFanqie
				? [
					{ label: `缓存免费章节（${freeCount} 章）`, kind: 'primary', value: 1 },
					{ label: `只入架，不缓存`, kind: 'soft', value: 0 }
				]
				: isComic
					? [
						{ label: `先缓存前 3 话`, kind: 'primary', value: 3 },
						{ label: `缓存全部 ${total} 话（较慢）`, kind: 'soft', value: total },
						{ label: `只入架，不缓存`, kind: 'soft', value: 0 }
					]
					: [
						{ label: `先缓存前 50 章（快速开读）`, kind: 'primary', value: 50 },
						{ label: `缓存全书 ${total} 章（较慢）`, kind: 'soft', value: total },
						{ label: `只入架，不缓存`, kind: 'soft', value: 0 }
					]
		});
		if (choice === -1) {
			btn.disabled = false;
			btn.innerHTML = `${icon('download', 15)} 入架`;
			return;
		}

		// 3. 建书
		const bookId = `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
		const book = {
			id: bookId,
			title: r.bookName,
			author: r.author ? r.author.replace(/^作者[:：]\s*/, '') : '',
			coverStyle: coverGradient(r.bookName),
			sourceId: source.id,
			sourceName: source.name,
			kind: source.kind === 'comic' ? 'comic' : '',
			bookUrl: r.bookUrl,
			tocUrl: toc.tocUrl,
			totalChapters: total,
			cachedChapters: 0,
			addedAt: Date.now(),
			lastReadAt: 0
		};
		// addBook 是统一写入闸门：返回的可能是「同名同源」的已有记录
		// （例如书名写法不同导致上面的 dupKey 没命中），目录必须挂到它的 id 上
		const saved = await addBook(book);
		const realId = saved?.id || bookId;
		await saveToc(realId, toc.chapters);

		if (choice === 0) {
			toast(`《${r.bookName}》已入架`);
			btn.innerHTML = `${icon('check', 15)} 已入架`;
			return;
		}

		// 4. Persist the job so a failed/paused batch can resume from the shelf.
		const count = isFanqie
			? Math.max(1, toc.chapters.reduce((mx, c, i) => (c.locked ? mx : i + 1), 0))
			: Math.min(choice, total);
		const unit = source.kind === 'comic' ? '话' : '章';
		btn.textContent = `缓存 0/${count}${unit}`;
		const job = await downloadBook({ ...book, ...saved, id: realId }, {
			target: count,
			onProgress: (p) => { btn.textContent = `缓存 ${p.completed + p.failed.length}/${p.total}${unit}`; }
		});
		toast(job.failed.length ? `已缓存 ${job.completed} ${unit}（${job.failed.length} ${unit}失败）` : `《${r.bookName}》已入架，缓存 ${job.completed} ${unit}`);
		btn.innerHTML = `${icon('check', 15)} 已入架`;

		// 下载完成后刷新书架角标（如果用户在书架页会看到）
		if (app.state.route === 'library') app.refresh();
	} catch (e) {
		console.error(e);
		toast(`操作失败：${e.message || e}`);
		btn.disabled = false;
		btn.innerHTML = `${icon('download', 15)} 入架`;
	}
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------- 搜索历史 ----------

function saveHistory(keyword) {
	try {
		const list = loadHistory().filter((k) => k !== keyword);
		list.unshift(keyword);
		localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 12)));
	} catch { /* ignore */ }
}

function loadHistory() {
	try {
		return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
	} catch {
		return [];
	}
}

function renderHistory(zone, input, app) {
	const history = loadHistory();
	if (!history.length) {
		zone.innerHTML = `
			<div class="empty-state" style="padding-top:52px">
				<div class="glyph">寻</div>
				<h3>搜你想看的书</h3>
				<p>会自动从多个书源里一起找<br/>找到后一键加入书架就能开始读</p>
			</div>`;
		return;
	}
	zone.innerHTML = `<div class="section-title">最近搜索</div>`;
	const wrap = document.createElement('div');
	wrap.className = 'history-tags';
	history.forEach((k) => {
		const tag = document.createElement('button');
		tag.className = 'history-tag stagger-item';
		tag.textContent = k;
		tag.onclick = () => {
			input.value = k;
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		};
		wrap.appendChild(tag);
	});
	zone.appendChild(wrap);
}
