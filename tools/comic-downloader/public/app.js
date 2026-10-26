/**
 * 本地漫画下载器 —— 前端
 * 所有网络请求都打到本机 server.mjs，不依赖任何外部 CDN。
 */

const $ = (sel) => document.querySelector(sel);

const state = {
	config: { outputRoot: '' },
	sources: [],
	source: null,
	results: [],
	selectedResult: null,
	book: null, // { title, author, chapters, bookUrl, source }
	scan: null, // { title, images, chapters, nextUrl, finalUrl }
	jobs: [],
	// 记录每个任务上一轮的状态，用于「完成/失败」只提示一次。
	// 之前漏了这个字段，pollJobs 里 state.statuses.get(...) 会直接抛
	// TypeError（Cannot read properties of undefined (reading 'get')），
	// 结果整个任务列表渲染被 catch 吞掉 → 界面既不显示进度也不提示完成。
	statuses: new Map(),
	expanded: new Set(),
	pollTimer: null,
	// 搜索任务：id 用于轮询，timer 用于串行续查（声明出来便于排查）
	searchTaskId: null,
	searchTimer: null,
	busy: false
};

// ------------------------------------------------------------
//  小工具
// ------------------------------------------------------------

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = text;
	return node;
}

function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
}

function toast(message, type = '') {
	const box = $('#toasts');
	const t = el('div', `toast ${type}`.trim(), message);
	box.appendChild(t);
	setTimeout(() => {
		t.style.opacity = '0';
		t.style.transition = 'opacity .2s';
		setTimeout(() => t.remove(), 220);
	}, 3200);
}

async function api(path, body) {
	const res = await fetch(path, {
		method: body === undefined ? 'GET' : 'POST',
		headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	let data = {};
	try { data = await res.json(); } catch { /* ignore */ }
	if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
	return data;
}

function fmtBytes(n) {
	const v = Number(n) || 0;
	if (v < 1024) return `${v} B`;
	if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
	if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
	return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ts) {
	if (!ts) return '';
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function chipClass(status) {
	return { running: 'running', done: 'done', error: 'error', queued: 'queued', cancelled: 'cancelled' }[status] || 'queued';
}

function statusText(status) {
	return { running: '下载中', done: '已完成', error: '失败', queued: '排队中', cancelled: '已取消' }[status] || status;
}

function gradientFor(name) {
	let h = 0;
	for (let i = 0; i < String(name || '').length; i++) h = (h * 31 + String(name).charCodeAt(i)) % 360;
	return `linear-gradient(145deg, hsl(${h} 32% 52%), hsl(${(h + 40) % 360} 36% 36%))`;
}

// ------------------------------------------------------------
//  初始化
// ------------------------------------------------------------

async function init() {
	bindTabs();
	bindActions();

	try {
		const cfg = await api('/api/config');
		state.config = cfg;
		$('#output-root').textContent = cfg.outputRoot;
		const saved = localStorage.getItem('zj-dl-output');
		$('#output-dir').value = saved || cfg.outputRoot;
	} catch (e) {
		toast(`无法连接本地服务：${e.message}`, 'error');
	}

	$('#output-dir').addEventListener('change', () => {
		localStorage.setItem('zj-dl-output', $('#output-dir').value.trim());
	});
	$('#cleanup').addEventListener('change', () => {
		localStorage.setItem('zj-dl-cleanup', $('#cleanup').checked ? '1' : '0');
	});
	$('#cleanup').checked = localStorage.getItem('zj-dl-cleanup') === '1';

	pollJobs(true);

	// 启动即载入内置漫画源：下载器自带一份，打开就能搜索，
	// 不必再去别处找书源 JSON 粘贴（这是之前「看不到搜索下载」的根因）
	loadBuiltinSources({ silent: true });
}

/** 加载下载器自带的内置漫画源 */
async function loadBuiltinSources({ silent = false } = {}) {
	const btn = $('#load-builtin');
	if (btn) setBusy(btn, true, '加载中…');
	try {
		const data = await api('/api/sources/builtin');
		const list = data.sources || [];
		if (!list.length) throw new Error('内置源为空');
		state.sources = list;
		state.source = list.find((s) => s.kind === 'comic') || list[0];
		clearResults();
		renderSourceInfo();
		if (!silent) toast(`已加载 ${list.length} 个内置漫画源`, 'ok');
		// 静默加载时也给个可见反馈，避免用户以为没反应
		else $('#search-status').textContent = `已载入 ${list.length} 个内置漫画源，输入书名即可搜索`;
		$('#keyword').focus();
	} catch (e) {
		if (!silent) toast(e.message, 'error');
		else $('#search-status').textContent = '内置源加载失败：' + e.message;
	} finally {
		if (btn) setBusy(btn, false, '加载内置源');
	}
}

function bindTabs() {
	document.querySelectorAll('.tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
			$('#tab-source').classList.toggle('hidden', tab.dataset.tab !== 'source');
			$('#tab-url').classList.toggle('hidden', tab.dataset.tab !== 'url');
		});
	});
}

function bindActions() {
	$('#load-source').addEventListener('click', loadSource);
	const builtinBtn = $('#load-builtin');
	if (builtinBtn) builtinBtn.addEventListener('click', () => loadBuiltinSources());
	$('#search').addEventListener('click', search);
	$('#scan').addEventListener('click', scanUrl);
	$('#start').addEventListener('click', startDownload);
	$('#open-root').addEventListener('click', () => openPath(state.config.outputRoot));
	$('#refresh-jobs').addEventListener('click', () => pollJobs(true));

	$('#keyword').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') search();
	});
	$('#url-input').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') scanUrl();
	});
	$('#source-input').addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) loadSource();
	});
}

// ------------------------------------------------------------
//  书源
// ------------------------------------------------------------

async function loadSource() {
	const input = $('#source-input').value.trim();
	if (!input) { toast('请粘贴书源 JSON 或链接', 'error'); return; }
	const btn = $('#load-source');
	setBusy(btn, true, '加载中…');
	try {
		const data = await api('/api/source', { input });
		state.sources = data.sources || [];
		if (!state.sources.length) throw new Error('没有解析到书源');
		// 优先选漫画源
		state.source = state.sources.find((s) => s.kind === 'comic') || state.sources[0];
		clearResults();
		renderSourceInfo();
		toast(`已加载 ${state.sources.length} 个书源`);
		$('#keyword').focus();
	} catch (e) {
		toast(e.message, 'error');
	} finally {
		setBusy(btn, false, '加载书源');
	}
}

function renderSourceInfo() {
	const box = $('#source-info');
	clear(box);
	box.classList.remove('hidden');
	if (!state.sources.length) return;

	const comicCount = state.sources.filter((s) => s.kind === 'comic').length;
	const textCount = state.sources.length - comicCount;
	if (state.sources.length === 1) {
		box.appendChild(el('div', 'name', state.source.name));
	} else {
		box.appendChild(el('div', 'name', `${state.sources.length} 个书源已加载`));
	}
	const meta = el('div', 'meta',
		state.sources.length === 1
			? `${state.source.kind === 'comic' ? '漫画源' : '小说源'} · ${state.source.url}`
			: `漫画 ${comicCount} 个${textCount ? ` · 小说 ${textCount} 个` : ''} · 搜索时会同时查询${comicCount ? '全部漫画源' : '全部源'}`);
	box.appendChild(meta);

	if (state.sources.length > 1) {
		const names = state.sources.map((s) => s.name).filter(Boolean);
		const shown = names.slice(0, 6).join('、');
		box.appendChild(el('div', 'meta', shown + (names.length > 6 ? ` 等 ${names.length} 个` : '')));
	}

	const scripted = state.sources.filter((s) => s.scripted).length;
	if (scripted) {
		box.appendChild(el('div', 'warn', `${scripted} 个源含脚本/登录验证：搜索或目录可能不完整`));
	}
}

function clearResults() {
	state.results = [];
	state.selectedResult = null;
	state.searchTaskId = null;
	if (state.searchTimer) { clearTimeout(state.searchTimer); state.searchTimer = null; }
	$('#results').innerHTML = '';
	$('#search-status').textContent = '';
	state.book = null;
	renderSelection();
}

async function search() {
	if (!state.sources.length) { toast('先加载书源', 'error'); return; }
	const keyword = $('#keyword').value.trim();
	if (!keyword) { toast('请输入书名', 'error'); return; }

	const comics = state.sources.filter((s) => s.kind === 'comic');
	const pool = comics.length ? comics : state.sources;
	const btn = $('#search');
	setBusy(btn, true, '搜索中…');
	state.searchTaskId = null;
	if (state.searchTimer) { clearTimeout(state.searchTimer); state.searchTimer = null; }
	state.results = [];
	state.book = null;
	state.scan = null;
	$('#results').innerHTML = '';
	$('#search-status').classList.remove('error');
	$('#search-status').textContent = `正在搜索 ${pool.length} 个源…`;
	renderSelection();

	try {
		const data = await api('/api/search-all', { sources: pool.map((s) => s.source), keyword });
		state.searchTaskId = data.searchId;
		pollSearch();
	} catch (e) {
		$('#search-status').textContent = `搜索失败：${e.message}`;
		$('#search-status').classList.add('error');
	} finally {
		setBusy(btn, false, '搜索');
	}
}

async function pollSearch() {
	const id = state.searchTaskId;
	if (!id) return;
	try {
		const data = await api(`/api/search-all/${id}`);
		if (state.searchTaskId !== id) return; // 已经开了新一轮搜索
		state.results = data.results || [];
		renderResults(data);
		const okSources = (data.stats || []).filter((s) => s.count > 0).length;
		if (data.status === 'running') {
			$('#search-status').textContent = `正在搜索 ${data.total} 个源…（已响应 ${data.done}/${data.total}）· 已有 ${state.results.length} 条`;
			state.searchTimer = setTimeout(pollSearch, 350);
		} else {
			$('#search-status').textContent = `共 ${state.results.length} 条结果 · ${okSources}/${data.total} 个源有结果`;
		}
	} catch (e) {
		$('#search-status').textContent = `搜索中断：${e.message}`;
		$('#search-status').classList.add('error');
	}
}

function renderResults(task = null) {
	const box = $('#results');
	const keepScroll = box.scrollTop;
	clear(box);

	if (!state.results.length) {
		if (task?.status === 'done') {
			box.appendChild(el('p', 'search-empty', '没有搜到结果，换个关键词或换一批书源试试'));
		}
	} else {
		const head = el('div', 'result-head');
		['站点', '标题', '作者', '最新章节'].forEach((t) => head.appendChild(el('span', null, t)));
		box.appendChild(head);

		state.results.forEach((r) => {
			const row = el('button', 'result');
			row.type = 'button';
			row.append(
				el('span', 'site', r.sourceName || ''),
				el('span', 'title', r.bookName || '未命名'),
				el('span', 'author', (r.author || '').replace(/^作者[:：]\s*/, '')),
				el('span', 'latest', r.latestChapter || '')
			);
			row.addEventListener('click', () => {
				document.querySelectorAll('.result').forEach((x) => x.classList.toggle('active', x === row));
				loadToc(r);
			});
			box.appendChild(row);
		});
	}

	box.scrollTop = keepScroll;

	// 搜完列出没有结果的源，别让人以为「全都搜过了」
	if (task?.status === 'done') {
		const failed = (task.stats || []).filter((s) => !s.count);
		if (failed.length) {
			const foot = el('div', 'search-failed');
			foot.appendChild(el('b', null, `未找到 / 失败（${failed.length}）：`));
			const text = failed.map((s) => `${s.name}${s.error ? `（${s.error}）` : ''}`).join('、');
			foot.appendChild(document.createTextNode(text));
			box.appendChild(foot);
		}
	}
}

async function loadToc(result) {
	const wrapper = state.sources.find((s) => s.id === result.sourceId)
		|| state.sources.find((s) => s.source?.id === result.sourceId)
		|| state.sources.find((s) => s.name === result.sourceName)
		|| state.source;
	if (!wrapper) { toast('这条结果对应的书源已不在列表里', 'error'); return; }
	const source = wrapper.source || wrapper;

	$('#search-status').textContent = `正在获取《${result.bookName}》的目录…`;
	$('#search-status').classList.remove('error');
	$('#start').disabled = true;
	state.book = null;
	state.scan = null;
	renderSelection();
	try {
		const data = await api('/api/toc', { source, bookUrl: result.bookUrl });
		if (!data.chapters?.length) throw new Error('没有获取到目录（书源规则可能不匹配）');
		state.scan = null;
		state.book = {
			title: result.bookName || data.bookTitle || '未命名',
			author: result.author || data.bookAuthor || '',
			chapters: data.chapters,
			bookUrl: result.bookUrl,
			source,
			sourceName: result.sourceName || wrapper.name || ''
		};
		renderSelection();
		$('#search-status').textContent = `《${state.book.title}》共 ${state.book.chapters.length} 话`;
		$('#start').disabled = false;
	} catch (e) {
		$('#search-status').textContent = `目录获取失败：${e.message}`;
		$('#search-status').classList.add('error');
		toast(e.message, 'error');
	}
}

// ------------------------------------------------------------
//  链接扫描
// ------------------------------------------------------------

async function scanUrl() {
	const url = $('#url-input').value.trim();
	if (!url) { toast('请输入链接', 'error'); return; }
	const btn = $('#scan');
	setBusy(btn, true, '扫描中…');
	const status = $('#scan-status');
	status.textContent = '正在读取页面…';
	status.classList.remove('error');
	$('#scan-result').classList.add('hidden');
	state.scan = null;
	state.book = null;
	renderSelection();
	try {
		const data = await api('/api/scan', { url });
		state.scan = data;
		renderScanResult(data);
		renderSelection();
	} catch (e) {
		status.textContent = `扫描失败：${e.message}`;
		status.classList.add('error');
	} finally {
		setBusy(btn, false, '扫描');
	}
}

function renderScanResult(scan) {
	const box = $('#scan-result');
	clear(box);
	box.classList.remove('hidden');
	const summary = el('div', 'scan-summary');
	const lines = [];
	lines.push(`标题：<b>${escapeHtml(scan.title || '未识别')}</b>`);
	lines.push(`这一页图片：<b>${scan.images?.length || 0}</b> 张`);
	lines.push(`识别到目录：<b>${scan.chapters?.length || 0}</b> 话`);
	if (scan.nextUrl) lines.push('有「下一话」链接，可连续抓取');
	const noResult = !(scan.images?.length >= 2) && !(scan.chapters?.length >= 2);
	summary.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
	box.appendChild(summary);

	// 前几页缩略图：先确认抓到的是不是正文，再决定下不下
	if (scan.images?.length) {
		const strip = el('div', 'thumb-strip');
		scan.images.slice(0, 6).forEach((url) => {
			const img = document.createElement('img');
			img.loading = 'lazy';
			img.src = `/api/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(scan.finalUrl || '')}`;
			img.onerror = () => img.remove();
			strip.appendChild(img);
		});
		box.appendChild(strip);
	}
	const status = $('#scan-status');
	if (noResult) {
		status.textContent = '没有识别到图片或章节：这个页面可能是 JS 动态加载、需要登录，或结构特殊';
		status.classList.add('error');
	} else {
		status.textContent = '扫描完成，右侧确认范围后开始下载';
		status.classList.remove('error');
	}
}

function escapeHtml(s) {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ------------------------------------------------------------
//  选择区
// ------------------------------------------------------------

function defaultEnd(total) {
	return total > 30 ? 20 : total;
}

function renderSelection() {
	const box = $('#selection');
	clear(box);
	box.classList.remove('empty');
	$('#start').disabled = true;

	if (!state.book && !state.scan) {
		box.classList.add('empty');
		box.appendChild(el('p', null, '从左边选一本书，或扫描一个链接。'));
		box.appendChild(el('p', 'note', '下载完成后会在输出目录生成 .cbz，用纸间「本地 → 导入」打开即可。'));
		return;
	}

	if (state.book) {
		renderBookSelection(box, state.book);
		return;
	}

	const scan = state.scan;
	renderScanSelection(box, scan);
}

function renderBookSelection(box, book) {
	box.appendChild(el('div', 'book-title', book.title));
	box.appendChild(el('div', 'book-meta',
		[book.author || '未知作者', book.sourceName, `共 ${book.chapters.length} 话`].filter(Boolean).join(' · ')));

	const total = book.chapters.length;
	const end = defaultEnd(total);
	box.appendChild(rangeRow(total, 1, end));
	box.appendChild(chapterPreview(book.chapters, end));

	$('#start').disabled = false;
}

function renderScanSelection(box, scan) {
	const chapters = scan.chapters || [];
	const images = scan.images || [];

	box.appendChild(el('div', 'book-title', scan.title || '未命名'));

	if (chapters.length >= 2) {
		box.appendChild(el('div', 'book-meta', `识别到 ${chapters.length} 话目录 · 按目录批量下载`));
		const end = defaultEnd(chapters.length);
		box.appendChild(rangeRow(chapters.length, 1, end));
		box.appendChild(chapterPreview(chapters, end));
		$('#start').disabled = false;
		return;
	}

	if (images.length >= 2) {
		box.appendChild(el('div', 'book-meta', `这一页识别到 ${images.length} 张图片 · 作为一话下载`));
		if (scan.nextUrl) {
			const row = el('div', 'range');
			const label = el('label', 'check');
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.id = 'follow-next';
			label.append(cb, el('span', null, '顺着「下一话」继续抓取'));
			row.appendChild(label);
			row.appendChild(el('span', null, '最多'));
			const max = document.createElement('input');
			max.type = 'number';
			max.min = '1';
			max.max = '200';
			max.value = '10';
			max.id = 'max-chapters';
			row.appendChild(max);
			row.appendChild(el('span', null, '话'));
			box.appendChild(row);
		}
		$('#start').disabled = false;
		return;
	}

	$('#start').disabled = true;
	box.appendChild(el('div', 'book-meta', '没有可下载的内容'));
}

function rangeRow(total, startValue, endValue) {
	const row = el('div', 'range');
	row.appendChild(el('span', null, '下载范围'));
	const start = document.createElement('input');
	start.type = 'number';
	start.id = 'range-start';
	start.min = '1';
	start.max = String(total);
	start.value = String(startValue);
	const end = document.createElement('input');
	end.type = 'number';
	end.id = 'range-end';
	end.min = '1';
	end.max = String(total);
	end.value = String(endValue);
	row.append(start, el('span', null, '至'), end, el('span', null, `话（共 ${total} 话）`));

	const all = el('button', 'btn tiny ghost', '全部');
	all.type = 'button';
	all.addEventListener('click', () => {
		start.value = '1';
		end.value = String(total);
	});
	row.appendChild(all);
	return row;
}

function chapterPreview(chapters, end) {
	const box = el('div', 'chapter-preview');
	const show = [];
	for (let i = 0; i < Math.min(end, 6); i++) show.push(chapters[i]);
	if (end > 9) {
		show.push(null);
		for (let i = Math.max(0, end - 3); i < end; i++) show.push(chapters[i]);
	}
	for (const ch of show) {
		if (!ch) { box.appendChild(el('div', null, '…')); continue; }
		box.appendChild(el('div', null, ch.title || '（无标题）'));
	}
	return box;
}

function readRange(total) {
	const start = Math.max(1, Math.min(total, parseInt($('#range-start')?.value, 10) || 1));
	const endRaw = parseInt($('#range-end')?.value, 10) || total;
	const end = Math.max(start, Math.min(total, endRaw));
	return [start, end];
}

// ------------------------------------------------------------
//  下载
// ------------------------------------------------------------

async function startDownload() {
	const outputRoot = $('#output-dir').value.trim();
	if (!outputRoot) { toast('请填写输出目录', 'error'); return; }
	const cleanup = $('#cleanup').checked;

	let payload;
	if (state.book) {
		const [start, end] = readRange(state.book.chapters.length);
		payload = {
			mode: 'source',
			title: state.book.title,
			source: state.book.source,
			book: { title: state.book.title, author: state.book.author, bookUrl: state.book.bookUrl },
			chapters: state.book.chapters.slice(start - 1, end),
			outputRoot,
			cleanup
		};
	} else if (state.scan) {
		const scan = state.scan;
		if (scan.chapters?.length >= 2) {
			const [start, end] = readRange(scan.chapters.length);
			payload = {
				mode: 'url',
				title: scan.title || '未命名',
				chapters: scan.chapters.slice(start - 1, end),
				outputRoot,
				cleanup
			};
		} else {
			payload = {
				mode: 'url',
				title: scan.title || '未命名',
				startUrl: scan.finalUrl,
				followNext: !!$('#follow-next')?.checked,
				maxChapters: parseInt($('#max-chapters')?.value, 10) || 1,
				outputRoot,
				cleanup
			};
		}
	} else {
		toast('先选择要下载的内容', 'error');
		return;
	}

	const btn = $('#start');
	setBusy(btn, true, '已提交…');
	try {
		const data = await api('/api/download', payload);
		toast(`任务已开始：${data.job.title}`);
		pollJobs(true);
		$('#active-job').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	} catch (e) {
		toast(e.message, 'error');
	} finally {
		setBusy(btn, false, '开始下载');
	}
}

function setBusy(btn, busy, text) {
	if (!btn) return;
	btn.disabled = busy;
	btn.textContent = text;
	if (!busy && btn.id === 'start') btn.disabled = !(state.book || state.scan);
}

// ------------------------------------------------------------
//  任务轮询 / 渲染
// ------------------------------------------------------------

async function pollJobs(immediate = false) {
	if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
	try {
		const data = await api('/api/jobs');
		state.jobs = data.jobs || [];
		if (!(state.statuses instanceof Map)) state.statuses = new Map();
		// 状态变化提示：完成 / 失败时不用一直盯着进度条
		for (const job of state.jobs) {
			const prev = state.statuses.get(job.id);
			if (prev && prev !== job.status && (job.status === 'done' || job.status === 'error')) {
				if (job.status === 'done') toast(`《${job.title}》下载完成${job.cbz ? '，已生成 CBZ' : ''}`);
				else toast(`《${job.title}》失败：${job.error || '未知错误'}`, 'error');
			}
			state.statuses.set(job.id, job.status);
		}
		renderJobs();
	} catch (e) {
		// 注意：这里不能用一条吞掉所有异常的 catch —— 之前 state.statuses 未初始化
		// 导致每轮都抛 TypeError，却被静默吞下，表现为「界面没有进度、完成也不提示」。
		// 现在把原因写进控制台，并在首次/手动刷新时提示用户。
		console.error('[jobs] 轮询失败', e);
		if (immediate) toast(`读取任务失败：${e.message}`, 'error');
		const status = document.getElementById('jobs-status');
		if (status) status.textContent = '任务列表刷新失败：' + e.message;
	}
	const active = state.jobs.some((j) => j.status === 'running' || j.status === 'queued');
	state.pollTimer = setTimeout(() => pollJobs(), active ? 700 : 2500);
}

function renderJobs() {
	const active = state.jobs.find((j) => j.status === 'running' || j.status === 'queued');
	const activeBox = $('#active-job');
	clear(activeBox);
	if (active) activeBox.appendChild(jobCard(active, true));
	else activeBox.appendChild(el('p', 'empty-small', '暂无进行中的任务'));

	const finished = state.jobs.filter((j) => j.status !== 'running' && j.status !== 'queued');
	const jobsBox = $('#jobs');
	clear(jobsBox);
	if (!finished.length) {
		jobsBox.appendChild(el('p', 'empty-small', '还没有下载记录'));
	} else {
		finished.slice(0, 12).forEach((job) => jobsBox.appendChild(jobCard(job, false)));
	}

	const running = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
	const badge = $('#queue-badge');
	badge.textContent = `${running} 个任务`;
	badge.classList.toggle('hidden', running === 0);
}

function jobCard(job, detailed) {
	const card = el('div', `job ${job.status === 'running' ? 'running' : ''}`.trim());
	card.dataset.id = job.id;

	const head = el('div', 'job-head');
	const left = el('div');
	left.style.minWidth = '0';
	left.appendChild(el('div', 'job-title', job.title));
	left.appendChild(el('div', 'job-sub', `${job.mode === 'source' ? '书源下载' : '链接下载'} · ${fmtTime(job.createdAt)}`));
	head.appendChild(left);
	head.appendChild(el('span', `chip ${chipClass(job.status)}`, statusText(job.status)));
	card.appendChild(head);

	const bar = el('div', 'bar');
	const fill = el('i');
	if (job.progress == null && (job.status === 'running' || job.status === 'queued')) {
		bar.classList.add('indeterminate');
	} else {
		const pct = job.status === 'done' ? 100 : Math.round((job.progress || 0) * 100);
		fill.style.width = `${pct}%`;
	}
	bar.appendChild(fill);
	card.appendChild(bar);

	const stats = el('div', 'job-stats');
	const parts = [];
	if (job.totalChapters) parts.push(`话 <b>${job.doneChapters}/${job.totalChapters}</b>`);
	else if (job.doneChapters) parts.push(`已下载 <b>${job.doneChapters}</b> 话`);
	if (job.currentChapter) parts.push(`当前：${escapeHtml(job.currentChapter)}${job.chapterPages ? ` <b>${job.currentPage}/${job.chapterPages}</b> 页` : ''}`);
	else if (job.status === 'running' && job.chapterPages) parts.push(`<b>${job.currentPage}/${job.chapterPages}</b> 页`);
	parts.push(`共 <b>${job.pages}</b> 页`);
	if (job.skippedPages) parts.push(`跳过 ${job.skippedPages} 页`);
	if (job.failedPages) parts.push(`失败 <b>${job.failedPages}</b> 页`);
	parts.push(fmtBytes(job.bytes));
	if (job.speed) parts.push(`${fmtBytes(job.speed)}/s`);
	stats.innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
	card.appendChild(stats);

	if (job.error) card.appendChild(el('div', 'error', job.error));

	const actions = el('div', 'job-actions');
	if (job.status === 'running' || job.status === 'queued') {
		const cancel = el('button', 'btn tiny danger', '取消');
		cancel.type = 'button';
		cancel.addEventListener('click', () => cancelJob(job.id));
		actions.appendChild(cancel);
	}
	if (job.output && job.status !== 'queued') {
		const open = el('button', 'btn tiny ghost', '打开文件夹');
		open.type = 'button';
		open.addEventListener('click', () => openPath(job.output));
		actions.appendChild(open);
	}
	if (job.cbz) {
		const copy = el('button', 'btn tiny ghost', '复制 CBZ 路径');
		copy.type = 'button';
		copy.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(job.cbz);
				toast('已复制 CBZ 路径');
			} catch {
				toast(job.cbz);
			}
		});
		actions.appendChild(copy);
	}
	const logBtn = el('button', 'btn tiny ghost', state.expanded.has(job.id) ? '收起日志' : '查看日志');
	logBtn.type = 'button';
	logBtn.addEventListener('click', () => {
		if (state.expanded.has(job.id)) state.expanded.delete(job.id);
		else state.expanded.add(job.id);
		renderJobs();
	});
	actions.appendChild(logBtn);
	card.appendChild(actions);

	if (detailed || state.expanded.has(job.id)) {
		const pre = el('pre', 'log', (job.log || []).join('\n') || '暂无日志');
		card.appendChild(pre);
		if (job.status === 'running') requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
	}

	return card;
}

async function cancelJob(id) {
	try {
		await api(`/api/jobs/${id}/cancel`, {});
		toast('已请求取消');
		pollJobs(true);
	} catch (e) {
		toast(e.message, 'error');
	}
}

async function openPath(target) {
	if (!target) { toast('还没有输出目录', 'error'); return; }
	try {
		await api('/api/open', { target });
	} catch (e) {
		toast(e.message, 'error');
	}
}

init();
