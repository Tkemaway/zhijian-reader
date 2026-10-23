/**
 * 换源 —— 在阅读器里给同一本书换一个书源
 *
 * 为什么必须在阅读器里也有入口：用户是在「读这本书」的过程中发现当前源
 * 缺章/乱码/停更的，此时返回书架长按换源会把阅读位置和上下文丢掉；
 * 而且书架的换源面板只在「书架已存在多个来源」时才出现——
 * 大多数情况下用户只入架了一个源，根本看不到任何换源入口。
 *
 * 本面板同时提供两条路径：
 *   1. 已入架的其它来源（同一本书的 variants）—— 直接切换；
 *   2. 就地搜索其他书源 —— 找到后自动入架并切换。
 *
 * 章节对齐：不同书源的章节标题一般一致，按归一化后的标题匹配目标章节，
 * 命中则复用阅读锚点；未命中只能按章节序号近似并**丢弃锚点**——
 * 把 A 源的段落/字符偏移套到 B 源上是错的（会跳到无关段落）。
 */
import sources from '../core/sources.js';
import { searchAll, fetchToc } from '../core/engine.js';
import { getBooks, addBook, updateBook, getToc, saveToc } from '../store/db.js';
import { findSourceVariants, findSameBookRecord, normalizeTitle, normalizeBookFields } from '../store/book-identity.js';
import { icon, toast, showSheet } from './kit.js';
import { escapeHtml } from './library.js';

const AUTHOR_PREFIX_RE = /^作者[:：]\s*/;

/**
 * 打开换源面板
 * @param {object} opts
 * @param {object} opts.book 当前书籍记录
 * @param {object} opts.app 应用对象（app.go / app.refresh）
 * @param {() => {chapterIdx:number, anchor:object|null, chapterTitle:string}} opts.getPosition
 *        切换前捕获当前位置（由阅读器提供，保证用的是最新进度而非库里的旧值）
 */
export function openSourceSwitcher({ book, app, getPosition }) {
	if (!book) return;
	showSheet({
		title: '换源',
		build: (body, close) => {
			const hint = document.createElement('p');
			hint.className = 'setting-hint';
			hint.style.marginBottom = '10px';
			hint.textContent = '换到别的书源后，会尽量按章节标题对齐阅读位置；不同源的章节划分可能不同，各自的缓存互不影响。';
			body.appendChild(hint);

			const listZone = document.createElement('div');
			body.appendChild(listZone);

			// ---- 已入架的来源 ----
			getBooks().then((all) => {
				if (!listZone.isConnected) return;
				const variants = findSourceVariants(book, all)
					.filter((b) => b && b.id !== book.id)
					.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
				if (!variants.length) listZone.innerHTML = '';
				else {
					const t = document.createElement('div');
					t.className = 'section-title';
					t.textContent = '书架里已有的其他来源';
					listZone.appendChild(t);
					variants.forEach((v) => listZone.appendChild(variantRow(v, close, app, getPosition)));
				}
			}).catch(() => {});

			// ---- 搜索其他书源 ----
			const searchBtn = document.createElement('button');
			searchBtn.className = 'btn btn-primary btn-block';
			searchBtn.style.marginTop = '14px';
			searchBtn.innerHTML = `${icon('search', 16)} 搜索其他书源`;
			body.appendChild(searchBtn);

			const status = document.createElement('p');
			status.className = 'setting-hint';
			status.style.marginTop = '10px';
			body.appendChild(status);

			const resultZone = document.createElement('div');
			body.appendChild(resultZone);

			searchBtn.onclick = () => {
				searchBtn.disabled = true;
				searchBtn.textContent = '搜索中…';
				status.textContent = '';
				resultZone.innerHTML = '';
				runSearch({ book, status, resultZone, close, getPosition, app })
					.catch((e) => { status.textContent = `搜索失败：${e.message || e}`; })
					.finally(() => {
						if (searchBtn.isConnected) {
							searchBtn.disabled = false;
							searchBtn.innerHTML = `${icon('search', 16)} 搜索其他书源`;
						}
					});
			};
		}
	});
}

/** 已入架来源的一行 */
function variantRow(v, close, app, getPosition) {
	const bits = [`${v.totalChapters || 0} 章`];
	if (v.cachedChapters) bits.push(`已缓存 ${v.cachedChapters} 章`);
	if (v.lastReadAt) bits.push('有阅读进度');
	const row = document.createElement('button');
	row.className = 'btn btn-soft btn-block';
	row.style.textAlign = 'left';
	row.style.marginTop = '8px';
	row.innerHTML = `
		<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
			<div style="min-width:0">
				<div style="font-weight:600">${escapeHtml(v.sourceName || '未知来源')}</div>
				<div class="setting-hint" style="margin:3px 0 0">${escapeHtml(bits.join(' · '))}</div>
			</div>
			${icon('chevronRight', 18)}
		</div>`;
	row.onclick = () => {
		row.disabled = true;
		switchTo({ target: v, source: sources.find((s) => s.id === v.sourceId), close, app, getPosition }).catch((e) => {
			row.disabled = false;
			toast(`切换失败：${e.message || e}`, 2600);
		});
	};
	return row;
}

/** 搜索同名书并列出其它书源的结果 */
async function runSearch({ book, status, resultZone, close, getPosition, app }) {
	const enabled = sources.filter((s) => s.enabled !== false && s.id !== book.sourceId);
	if (!enabled.length) { status.textContent = '没有其它可用书源'; return; }
	const keyword = book.author ? `${book.title} ${book.author}` : book.title;
	const target = { title: normalizeTitle(book.title), author: (book.author || '').replace(AUTHOR_PREFIX_RE, '').trim() };

	const seen = new Set();
	const rowMap = new Map();
	let total = 0;

	const addResults = (list, source) => {
		for (const r of list) {
			const name = normalizeTitle(r.bookName);
			if (name !== target.title) continue; // 只保留同名书
			const key = `${r.bookUrl || r.bookName}`;
			if (seen.has(key)) continue;
			seen.add(key);
			total++;
			const row = document.createElement('button');
			row.className = 'btn btn-soft btn-block';
			row.style.textAlign = 'left';
			row.style.marginTop = '8px';
			const author = String(r.author || '').replace(AUTHOR_PREFIX_RE, '').trim();
			const authorHit = !target.author || author === target.author;
			row.innerHTML = `
				<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
					<div style="min-width:0">
						<div style="font-weight:600">${escapeHtml(r.bookName)} ${authorHit ? '' : '<span class="setting-hint">（作者不同）</span>'}</div>
						<div class="setting-hint" style="margin:3px 0 0">${escapeHtml(source.name)} · ${escapeHtml(author || '未知作者')}${r.latestChapter ? ` · ${escapeHtml(String(r.latestChapter).slice(0, 18))}` : ''}</div>
					</div>
					${icon('chevronRight', 18)}
				</div>`;
			row.onclick = () => {
				row.disabled = true;
				joinAndSwitch({ result: r, source, book, close, app, getPosition }).catch((e) => {
					row.disabled = false;
					toast(`换源失败：${e.message || e}`, 2800);
				});
			};
			rowMap.set(key, row);
			resultZone.appendChild(row);
		}
	};

	let done = 0;
	await searchAll(enabled, keyword, {
		concurrency: 4,
		onSourceResult: (source, list, error) => {
			done++;
			if (!error) addResults(list || [], source);
			status.textContent = `正在搜索 ${enabled.length} 个书源…（${done}/${enabled.length}）· 找到 ${total} 个同名来源`;
		}
	});
	status.textContent = total
		? `找到 ${total} 个同名来源，点击即可换源`
		: '没有找到这本书的其它书源';
}

/** 就地入架（或复用已有记录）并切换到该来源 */
async function joinAndSwitch({ result, source, book, close, app, getPosition }) {
	const toc = await fetchToc(source, { bookUrl: result.bookUrl, tocUrl: result.tocUrl }, undefined);
	if (toc?.error || !toc?.chapters?.length) throw new Error(toc?.error || '目录获取失败');

	const author = String(result.author || '').replace(AUTHOR_PREFIX_RE, '').trim();
	const candidate = normalizeBookFields({
		id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
		title: result.bookName,
		author,
		coverStyle: '',
		sourceId: source.id,
		sourceName: source.name,
		bookUrl: result.bookUrl || '',
		tocUrl: toc.tocUrl || '',
		totalChapters: toc.chapters.length,
		cachedChapters: 0,
		addedAt: Date.now(),
		lastReadAt: 0
	});

	// 复用书架里「同一本 + 同一书源」的记录，避免换一次源就多一条重复书
	const existing = findSameBookRecord(candidate, await getBooks());
	const target = existing || await addBook(candidate);
	// 已有记录且目录还是空的（例如属于同步来的「幽灵书」）→ 补目录
	if (!(await getToc(target.id))?.length) await saveToc(target.id, toc.chapters);
	if ((target.totalChapters || 0) < toc.chapters.length) {
		await updateBook(target.id, { totalChapters: toc.chapters.length, tocUrl: toc.tocUrl || target.tocUrl });
		target.totalChapters = toc.chapters.length;
	}

	await switchTo({ target, source, close, app, getPosition });
}

/**
 * 切换到目标来源并重新进入阅读器
 * @returns {Promise<void>}
 */
async function switchTo({ target, source, close, app, getPosition }) {
	if (!target) throw new Error('目标来源不存在');
	// 先校验导航能力：否则会先关掉面板再抛错，用户看到面板消失但没切换成功
	if (!app || typeof app.go !== 'function') throw new Error('无法打开阅读器');

	// 位置必须在切换前取：getPosition 由阅读器提供，反映的是当前屏幕位置
	const pos = typeof getPosition === 'function' ? getPosition() : null;

	// 目录：目标可能还没拉过（同步来的书）
	let toc = (await getToc(target.id)) || [];
	if (!toc.length) {
		const src = source || sources.find((s) => s.id === target.sourceId);
		if (!src) throw new Error('目标书源不可用');
		const fetched = await fetchToc(src, target, undefined);
		if (fetched?.error || !fetched?.chapters?.length) throw new Error(fetched?.error || '目录获取失败');
		toc = fetched.chapters;
		await saveToc(target.id, toc);
		await updateBook(target.id, { totalChapters: toc.length, tocUrl: fetched.tocUrl || target.tocUrl });
	}

	// 章节对齐（见文件头注释）
	let chapterIdx = 0;
	let anchor = null;
	const wantTitle = normalizeTitle(pos?.chapterTitle || '');
	let matched = wantTitle ? toc.findIndex((c) => normalizeTitle(c.title) === wantTitle) : -1;
	if (matched >= 0) {
		chapterIdx = matched;
		anchor = pos?.anchor || null; // 同标题章节：锚点可安全复用
	} else {
		const fallback = Number.isInteger(pos?.chapterIdx) ? pos.chapterIdx : 0;
		chapterIdx = Math.max(0, Math.min(fallback, toc.length - 1));
		anchor = null; // 章节划分不同：绝不能把旧源锚点带过去
	}

	// 换源标记（跨设备同步用：最近一次切换生效）
	const now = Date.now();
	await updateBook(target.id, { active: 1, activeAt: now });
	for (const v of findSourceVariants(target, await getBooks())) {
		if (v.id !== target.id && v.active) updateBook(v.id, { active: 0 }).catch(() => {});
	}

	close?.();
	toast(`已切换到「${target.sourceName || '未知来源'}」${matched >= 0 ? '' : '（未找到同名章节，已按相近位置打开）'}`, 2400);
	app.go('reader', { book: target, chapterIdx, scrollTop: 0, pageIdx: 0, anchor });
}
