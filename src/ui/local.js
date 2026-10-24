/**
 * 本地页 —— 导入的 EPUB / TXT，以及它们与网盘的同步状态
 *
 * 与书架的区别：书架是"所有书"（在线书源 + 本地），这里只看导入的文件，
 * 能看到占用空间、云端已同步几本，入口也更直接。
 */
import { getBooks } from '../store/db.js';
import { isFileSyncEnabled, importBookFromBytes } from '../store/book-files.js';
import { requestBytes } from '../core/http.js';
import { bookCard, importLocalBook } from './library.js';
import { toast, showSheet } from './kit.js';

export async function renderLocal(container, app) {
	let books = [];
	try {
		books = (await getBooks()).filter((b) => b.sourceId === 'local');
	} catch (e) {
		console.error(e);
	}
	books.sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));

	const synced = books.filter((b) => b.fileUploadedAt).length;
	const bytes = books.reduce((n, b) => n + (Number(b.fileSize) || 0), 0);
	const size = bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.max(0, Math.round(bytes / 1024))} KB`;
	const cloudReady = isFileSyncEnabled();

	container.innerHTML = `
		<header class="shelf-top">
			<h1 class="shelf-title">本地</h1>
			<div class="shelf-tools">
				<button class="shelf-tool" id="local-url">链接</button>
				<button class="shelf-tool" id="local-import">导入</button>
			</div>
		</header>
		<div class="local-summary">${books.length
			? `${books.length} 本 · ${size} · ${cloudReady ? `云端已同步 ${synced} 本` : '未配置网盘同步'}`
			: '导入的 EPUB / TXT 会出现在这里'}</div>
		<div id="local-books"></div>
	`;

	const zone = container.querySelector('#local-books');
	if (!books.length) {
		zone.innerHTML = `
			<div class="empty-state">
				<div class="glyph">书</div>
				<h3>还没有本地书</h3>
				<p>导入手机里的 EPUB / TXT<br/>开启网盘同步后，平板和手机会自动互通</p>
			</div>`;
	} else {
		const grid = document.createElement('div');
		grid.className = 'book-grid fade-in';
		books.forEach((b) => grid.appendChild(bookCard(b, app, null, null)));
		zone.appendChild(grid);
	}

	// 导入文件
	const input = document.createElement('input');
	input.type = 'file';
	input.accept = '.txt,.epub,.text';
	input.style.display = 'none';
	container.appendChild(input);
	container.querySelector('#local-import').addEventListener('click', () => input.click());
	input.addEventListener('change', async () => {
		const file = input.files?.[0];
		input.value = '';
		if (file) await importLocalBook(file, app);
	});

	// 从链接导入：粘贴 EPUB / TXT 的直接下载地址（不内置任何书源）
	container.querySelector('#local-url').addEventListener('click', () => {
		showSheet({
			title: '从链接导入',
			build: (body, close) => {
				const hint = document.createElement('p');
				hint.className = 'setting-hint';
				hint.style.cssText = 'margin-bottom:12px;line-height:1.7';
				hint.textContent = '粘贴 EPUB / TXT 的直接下载链接。仅用于你有权访问的文件（如公版书站点、自己的网盘直链）。';
				body.appendChild(hint);

				const input = document.createElement('input');
				input.type = 'url';
				input.inputMode = 'url';
				input.placeholder = 'https://example.com/book.epub';
				input.style.cssText = 'width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;padding:12px;font:inherit;font-size:13px;background:var(--elev-2);color:var(--ink)';
				body.appendChild(input);

				const status = document.createElement('p');
				status.className = 'setting-hint';
				status.style.marginTop = '10px';
				body.appendChild(status);

				const go = document.createElement('button');
				go.className = 'btn btn-primary btn-block';
				go.style.marginTop = '12px';
				go.textContent = '下载并导入';
				go.onclick = async () => {
					const url = input.value.trim();
					if (!/^https?:\/\//i.test(url)) { status.textContent = '请填写 http(s) 开头的完整地址'; return; }
					go.disabled = true;
					go.textContent = '下载中…';
					status.textContent = '';
					try {
						const res = await requestBytes(url, { timeout: 60000 });
						if (res.status >= 400) throw new Error(`下载失败（HTTP ${res.status}）`);
						if (!res.bytes?.length) throw new Error('下载到的文件为空');
						// 文件名：优先取地址里的文件名，其次按类型补扩展名
						const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
						let name = base && /\.(epub|txt)$/i.test(base) ? base : '';
						if (!name) {
							const ct = String(res.contentType || '').toLowerCase();
							name = `下载.${ct.includes('epub') ? 'epub' : 'txt'}`;
						}
						status.textContent = `已下载 ${(res.bytes.length / 1024 / 1024).toFixed(1)} MB，正在解析…`;
						await importBookFromBytes(res.bytes, name);
						toast(`《${name.replace(/\.[^.]+$/, '')}》已导入`, 2400);
						close();
						app.refresh();
					} catch (e) {
						status.textContent = `导入失败：${e.message || e}`;
						go.disabled = false;
						go.textContent = '下载并导入';
					}
				};
				body.appendChild(go);
			}
		});
	});
}
