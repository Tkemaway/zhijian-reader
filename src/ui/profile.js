/**
 * 我的页 —— 阅读统计 + 防沉迷限额 + 书源管理
 */
import sources, { refreshSources } from '../core/sources.js';
import { addCustomSources, removeCustomSource } from '../core/custom-sources.js';
import { loadSettings, saveSettings, applyPaperInkPreset, getWeekData, getTodaySeconds, getLimitStateWithExtra, fmtDuration } from '../store/stats.js';
import { keepAwake } from '../store/wakelock.js';
import { applyDisplayMode } from '../store/display.js';
import { getBooks } from '../store/db.js';
import { loadSyncConfig, isSyncEnabled, enableSync, enableDavSync, disableSync, syncNow, getPendingLocalDownloads } from '../store/sync.js';
import { kickAutoSync } from '../store/auto-sync.js';
import {
	loadFileSyncConfig, saveFileSyncConfig, isFileSyncEnabled,
	uploadAllPending, downloadAndImport, testFileSyncConnection, normalizeDavUrl, JIANGUOYUN_DAV
} from '../store/book-files.js';
import { toast, showDialog, showSheet, applyInkMode } from './kit.js';
import { escapeHtml } from './library.js';
import { fqAppSearch, fqAppToc, fqAppChapter } from '../core/fanqie-app.js';
import { requestText } from '../core/http.js';

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '开发版';

export async function renderProfile(container, app) {
	const settings = loadSettings();
	const week = getWeekData();
	const todaySec = getTodaySeconds();
	const limit = getLimitStateWithExtra();

	// 先落一版骨架：切页时立刻有东西可看，不让入场动画播在空容器上
	container.innerHTML = `
		<div class="page-title">我的</div>
		<div class="page-subtitle">读书是把时间酿成酒</div>
		<div class="card skeleton" style="height:196px"></div>`;

	let books = [];
	try { books = await getBooks(); } catch { /* ignore */ }
	// 加载期间用户已经切走：别再往旧页面里写
	if (container.dataset.route !== 'profile') return;
	const totalChapters = books.reduce((a, b) => a + (b.cachedChapters || 0), 0);

	const maxSec = Math.max(...week.map((d) => d.seconds), 60);

	container.innerHTML = `
		<div class="page-title">我的</div>
		<div class="page-subtitle">读书是把时间酿成酒</div>

		<div class="card stat-card">
			<div class="stat-today">
				<div class="st-num">${fmtDuration(todaySec)}</div>
				<div class="st-label">今日阅读</div>
			</div>
			<div class="week-chart">
				${week
					.map(
						(d) => `
					<div class="wc-col ${d.isToday ? 'today' : ''}">
						<div class="wc-bar-wrap"><div class="wc-bar" style="height:${Math.max(4, Math.round((d.seconds / maxSec) * 52))}px"></div></div>
						<span class="wc-label">${d.isToday ? '今' : d.label}</span>
					</div>`
					)
					.join('')}
			</div>
			<div class="stat-footer">共 ${books.length} 本书 · 已缓存 ${totalChapters} 章</div>
		</div>

		<div class="section-title">防沉迷</div>
		<div class="card">
			<div class="setting-row">
				<div>
					<div class="setting-label">每日阅读限额</div>
					<div class="setting-hint">超过额度后会温柔提醒你合上书</div>
				</div>
				<label class="switch"><input type="checkbox" id="limit-switch" ${settings.limitEnabled ? 'checked' : ''} /><span class="switch-rail"></span></label>
			</div>
			<div class="setting-row" id="limit-row" style="${settings.limitEnabled ? '' : 'display:none'}">
				<div style="flex:1">
					<div class="setting-label" style="margin-bottom:10px">限额时长 <span id="limit-val" style="color:var(--accent);font-weight:700">${settings.limitMinutes} 分钟</span></div>
					<input type="range" id="limit-range" min="15" max="180" step="15" value="${settings.limitMinutes}" />
					<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-3);margin-top:-4px">
						<span>15 分钟</span><span>3 小时</span>
					</div>
				</div>
			</div>
			<div class="setting-row" id="limit-status-row">
				<div>
					<div class="setting-label">今日进度</div>
					<div class="setting-hint" id="limit-status-text"></div>
				</div>
			</div>
		</div>

		<div class="section-title">阅读设置</div>
		<div class="card">
			<div class="setting-row">
				<div>
					<div class="setting-label">纸墨护眼模式</div>
					<div class="setting-hint">普通 Android 的 Kindle 式低刺激阅读：低饱和纸色 · 深灰字迹 · 单页淡化翻页 · 无玻璃材质</div>
				</div>
				<label class="switch"><input type="checkbox" id="ink-switch" ${settings.inkMode ? 'checked' : ''} /><span class="switch-rail"></span></label>
			</div>
			<div class="setting-row" id="frontlight-row" style="${settings.inkMode ? '' : 'display:none'}">
				<div class="setting-label">前光色温</div>
				<div class="setting-value" id="frontlight-value">温暖</div>
			</div>
			<div class="setting-row" id="grain-row" style="${settings.inkMode ? '' : 'display:none'}">
				<div>
					<div class="setting-label">纸面微颗粒</div>
					<div class="setting-hint">保留很轻的灰阶纸纹，关闭可获得更干净的纯色背景</div>
				</div>
				<label class="switch"><input type="checkbox" id="grain-switch" ${settings.paperGrain ? 'checked' : ''} /><span class="switch-rail"></span></label>
			</div>
			<div class="setting-row" id="eink-row">
				<div>
					<div class="setting-label">墨水屏优化</div>
					<div class="setting-hint" id="eink-hint">纯黑白 · 关闭玻璃与阴影</div>
				</div>
				<div class="setting-value" id="eink-value">自动</div>
			</div>
			<div class="setting-row" id="motion-row">
				<div>
					<div class="setting-label">界面动效</div>
					<div class="setting-hint" id="motion-hint">淡入淡出 · 翻页动画</div>
				</div>
				<div class="setting-value" id="motion-value">自动</div>
			</div>
			<div class="setting-row" id="quick-theme">
				<div class="setting-label">阅读主题</div>
				<div class="setting-value" id="theme-value">纸白</div>
			</div>
			<div class="setting-row" id="quick-font">
				<div class="setting-label">正文字号</div>
				<div class="setting-value">${settings.fontSize} px</div>
			</div>
			<div class="setting-row">
				<div>
					<div class="setting-label">阅读时保持亮屏</div>
					<div class="setting-hint">在手机系统里需允许纸间保持屏幕常亮</div>
				</div>
				<label class="switch"><input type="checkbox" id="awake-switch" ${settings.keepAwake ? 'checked' : ''} /><span class="switch-rail"></span></label>
			</div>
		</div>

		<div class="section-title">数据同步</div>
		<div class="card">
			<div class="setting-row" id="sync-row">
				<div>
					<div class="setting-label">跨设备同步</div>
					<div class="setting-hint" id="sync-status">用 GitHub 同步书架、阅读进度、书签与阅读时长</div>
				</div>
				<div class="setting-value" id="sync-value">未开启</div>
			</div>
			<div class="setting-row" id="file-sync-row">
				<div>
					<div class="setting-label">本地书文件同步</div>
					<div class="setting-hint" id="file-sync-status">用 WebDAV 网盘同步导入的 EPUB / TXT 原文件</div>
				</div>
				<div class="setting-value" id="file-sync-value">未配置</div>
			</div>
		</div>

		<div class="section-title" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
			<span>书源（${sources.filter((s) => s.enabled !== false).length} 个启用）</span>
			<button class="btn btn-soft btn-sm" id="add-source" style="margin-bottom:8px">添加</button>
		</div>
		<div class="card" id="source-list"></div>

		<div class="section-title">关于</div>
		<div class="card">
			<div class="setting-row">
				<div class="setting-label">纸间 · 静心阅读</div>
				<div class="setting-value">v${APP_VERSION}</div>
			</div>
			<div class="setting-row">
				<div class="setting-hint" style="line-height:1.8">
					所有书源内容来自第三方网站，仅供个人学习使用<br/>
					请支持正版阅读 · 考研加油 📚
				</div>
			</div>
		</div>
	`;

	// ---------- 限额交互 ----------
	const limitSwitch = container.querySelector('#limit-switch');
	const limitRow = container.querySelector('#limit-row');
	limitSwitch.addEventListener('change', () => {
		saveSettings({ limitEnabled: limitSwitch.checked });
		limitRow.style.display = limitSwitch.checked ? '' : 'none';
		updateLimitStatus();
	});

	const limitRange = container.querySelector('#limit-range');
	const limitVal = container.querySelector('#limit-val');
	limitRange.addEventListener('input', () => {
		limitVal.textContent = `${limitRange.value} 分钟`;
	});
	limitRange.addEventListener('change', () => {
		saveSettings({ limitMinutes: parseInt(limitRange.value, 10) });
		updateLimitStatus();
		toast(`每日限额已设为 ${limitRange.value} 分钟`);
	});

	function updateLimitStatus() {
		const s = getLimitStateWithExtra();
		const el = container.querySelector('#limit-status-text');
		if (!el) return;
		if (!s.enabled) {
			el.textContent = '未开启 · 今日已读 ' + fmtDuration(s.usedSec);
		} else {
			const pct = Math.min(100, Math.round(s.ratio * 100));
			el.textContent = `${fmtDuration(s.usedSec)} / ${fmtDuration(s.limitSec)}（${pct}%）`;
		}
	}
	updateLimitStatus();

	// ---------- 纸墨护眼模式 ----------
	const inkSwitch = container.querySelector('#ink-switch');
	const frontlightRow = container.querySelector('#frontlight-row');
	const grainRow = container.querySelector('#grain-row');
	inkSwitch.addEventListener('change', () => {
		if (inkSwitch.checked) {
			// 开启时同时应用纸墨护眼预设，保证普通 Android 首次使用就接近 Kindle 的阅读路径。
			applyPaperInkPreset();
			applyInkMode(true);
			frontlightRow.style.display = '';
			grainRow.style.display = '';
			container.querySelector('#grain-switch').checked = true;
			toast('纸墨护眼模式已开启', 1800);
		} else {
			saveSettings({ inkMode: false, theme: 'paper' });
			applyInkMode(false);
			frontlightRow.style.display = 'none';
			grainRow.style.display = 'none';
			toast('已恢复普通阅读主题', 1400);
		}
	});
	container.querySelector('#grain-switch').addEventListener('change', (e) => {
		saveSettings({ paperGrain: e.target.checked });
	});

	// ---------- 墨水屏优化 / 动效档位 ----------
	const einkNames = { auto: '自动', on: '开启', off: '关闭' };
	const motionNames = { auto: '自动', full: '完整', lite: '精简', off: '关闭' };
	const syncDisplayRows = () => {
		const st = loadSettings();
		const { eink, motion } = applyDisplayMode(st);
		container.querySelector('#eink-value').textContent = einkNames[st.einkMode] || '自动';
		container.querySelector('#eink-hint').textContent = eink
			? '纯黑白 · 已按墨水屏渲染'
			: '当前为普通屏幕配色';
		container.querySelector('#motion-value').textContent = motionNames[st.motion] || '自动';
		container.querySelector('#motion-hint').textContent = st.motion === 'auto'
			? `跟随屏幕（当前：${motion === 'lite' ? '精简' : motion === 'off' ? '关闭' : '完整'}）`
			: { full: '所有过渡与翻页动画', lite: '保留淡化翻页，去掉位移与模糊', off: '关闭全部动效' }[st.motion] || '';
	};
	syncDisplayRows();

	const pickOption = (title, hint, options, current, onPick) => {
		showSheet({
			title,
			build: (body, close) => {
				const wrap = document.createElement('div');
				wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
				options.forEach(([k, label]) => {
					const b = document.createElement('button');
					b.className = 'btn btn-block ' + (current === k ? 'btn-primary' : 'btn-soft');
					b.textContent = label;
					b.onclick = () => { onPick(k); close(); syncDisplayRows(); };
					wrap.appendChild(b);
				});
				const note = document.createElement('p');
				note.className = 'setting-hint';
				note.style.marginTop = '6px';
				note.textContent = hint;
				wrap.appendChild(note);
				body.appendChild(wrap);
			}
		});
	};

	container.querySelector('#eink-row').addEventListener('click', () => {
		pickOption('墨水屏优化',
			'开启后整站改用纯黑白配色，并关闭模糊、阴影与位移动画。自动模式按设备特征识别。',
			[['auto', '自动识别'], ['on', '始终开启'], ['off', '关闭']],
			loadSettings().einkMode || 'auto',
			(k) => { saveSettings({ einkMode: k }); toast(k === 'off' ? '已关闭墨水屏优化' : '屏幕模式已更新', 1600); });
	});

	container.querySelector('#motion-row').addEventListener('click', () => {
		pickOption('界面动效',
			'「精简」保留淡入淡出与翻页动画，只去掉位移和实时模糊；墨水屏会自动选这一档。',
			[['auto', '自动'], ['full', '完整'], ['lite', '精简'], ['off', '关闭']],
			loadSettings().motion || 'auto',
			(k) => { saveSettings({ motion: k }); toast('动效设置已更新', 1400); });
	});

	// ---------- 前光色温（Kindle 式档位：2700K 琥珀 ↔ 6500K 冷白） ----------
	const frontLightNames = { off: '关闭', low: '柔和', mid: '温暖', high: '琥珀' };
	const frontLightDescs = {
		off: '冷白 ≈6500K · 关闭暖光',
		low: '微暖 ≈4500K · 淡淡奶白',
		mid: '暖白 ≈3500K · Kindle 夜间常用',
		high: '深琥珀 ≈2700K · 暖光拉满'
	};
	container.querySelector('#frontlight-value').textContent = frontLightNames[settings.frontLight] || '温暖';
	container.querySelector('#frontlight-row').addEventListener('click', () => {
		showSheet({
			title: '前光色温',
			build: (body, close) => {
				const wrap = document.createElement('div');
				wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
				Object.entries(frontLightDescs).forEach(([k, desc]) => {
					const b = document.createElement('button');
					b.className = 'btn btn-block ' + ((loadSettings().frontLight || 'mid') === k ? 'btn-primary' : 'btn-soft');
					b.textContent = `${frontLightNames[k]} · ${desc}`;
					b.onclick = () => {
						saveSettings({ frontLight: k });
						close();
						app.refresh();
						toast(k === 'off' ? '暖光已关闭（冷白 6500K）' : `前光色温：${frontLightNames[k]}`, 1600);
					};
					wrap.appendChild(b);
				});
				body.appendChild(wrap);
			}
		});
	});

	// ---------- 快速设置 ----------
	const themeNames = { paper: '纸白', sepia: '米黄', ink: '墨水', green: '青禾', night: '夜读' };
	container.querySelector('#theme-value').textContent = themeNames[settings.theme] || '纸白';

	container.querySelector('#quick-theme').addEventListener('click', () => {
		showSheet({
			title: '阅读主题',
			build: (body, close) => {
				const wrap = document.createElement('div');
				wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
				Object.entries(themeNames).forEach(([k, name]) => {
					const b = document.createElement('button');
					b.className = 'btn btn-block ' + (loadSettings().theme === k ? 'btn-primary' : 'btn-soft');
					b.textContent = name;
					b.onclick = () => {
						saveSettings({ theme: k });
						close();
						app.refresh();
					};
					wrap.appendChild(b);
				});
				body.appendChild(wrap);
			}
		});
	});

	container.querySelector('#quick-font').addEventListener('click', () => {
		showDialog({
			title: '正文字号',
			text: '在阅读界面中也可随时调整字号、行距与字体',
			actions: [
				{ label: `小一点（${Math.max(14, settings.fontSize - 1)}px）`, kind: 'soft', value: -1 },
				{ label: `大一点（${Math.min(26, settings.fontSize + 1)}px）`, kind: 'soft', value: 1 },
				{ label: '知道了', kind: 'primary', value: 0 }
			]
		}).then((v) => {
			if (v === 1 || v === -1) {
				saveSettings({ fontSize: Math.min(26, Math.max(14, loadSettings().fontSize + v)) });
				app.refresh();
			}
		});
	});

	const awakeSwitch = container.querySelector('#awake-switch');
	awakeSwitch.addEventListener('change', () => {
		saveSettings({ keepAwake: awakeSwitch.checked });
		keepAwake(awakeSwitch.checked);
	});

	// ---------- 跨设备同步 ----------
	const syncValue = container.querySelector('#sync-value');
	const syncStatus = container.querySelector('#sync-status');
	const refreshSyncUI = () => {
		const c = loadSyncConfig();
		if (c.enabled && c.token) {
			syncValue.textContent = '已开启';
			const ago = c.lastSyncAt ? fmtAgo(c.lastSyncAt) : '尚未同步';
			syncStatus.textContent = `${c.login ? `@${c.login} · ` : ''}${ago}${c.lastResult ? ` · ${c.lastResult}` : ''}`;
		} else {
			syncValue.textContent = '未开启';
			syncStatus.textContent = '用 GitHub 在平板与手机间同步阅读进度和书签';
		}
	};
	refreshSyncUI();
	container.querySelector('#sync-row').addEventListener('click', () => {
		showSyncPanel(container, () => {
			refreshSyncUI();
			app.refresh();
		});
	});

	// ---------- 本地书文件同步（独立于 GitHub 同步，可单独使用）----------
	const fileSyncValue = container.querySelector('#file-sync-value');
	const fileSyncStatus = container.querySelector('#file-sync-status');
	const refreshFileSyncUI = () => {
		const fc = loadFileSyncConfig();
		if (isFileSyncEnabled()) {
			fileSyncValue.textContent = '已开启';
			fileSyncStatus.textContent = `${fc.user || 'WebDAV'} · 导入的 EPUB / TXT 原文件跨设备同步`;
		} else if (fc.url && fc.user) {
			fileSyncValue.textContent = '未连接';
			fileSyncStatus.textContent = '配置未完成或连接失败，点此重新设置';
		} else {
			fileSyncValue.textContent = '未配置';
			fileSyncStatus.textContent = '用 WebDAV 网盘同步导入的 EPUB / TXT 原文件';
		}
	};
	refreshFileSyncUI();
	container.querySelector('#file-sync-row').addEventListener('click', () => {
		showFileSyncPanel(container, () => {
			refreshFileSyncUI();
			app.refresh();
		});
	});

	// ---------- 书源列表 ----------
	const listEl = container.querySelector('#source-list');
	sources.forEach((s, i) => {
		const row = document.createElement('div');
		row.className = 'setting-row';
		const isFanqieApp = s.type === 'fanqie-app';
		const hint = isFanqieApp
			? 'APP 协议源 · 全本直连（实验性）'
			: `${s.type === 'legado' ? '阅读系规则' : 'SoNovel 规则'}${s.scripted ? ' · 含脚本/登录验证' : ''} · ${escapeHtml(s.url)}`;
		row.innerHTML = `
			<div style="min-width:0">
				<div class="setting-label">${escapeHtml(s.name)} ${s.custom ? '<span class="src-tag src-tag-custom">自定义</span>' : ''}</div>
				<div class="setting-hint" style="word-break:break-all">${hint}</div>
			</div>
			${isFanqieApp ? '<button class="btn btn-soft btn-sm" style="margin-right:10px">自检</button>' : ''}
			${s.custom ? '<button class="btn btn-soft btn-sm src-del" style="margin-right:8px">删除</button>' : ''}
			<label class="switch"><input type="checkbox" data-sidx="${i}" ${s.enabled !== false ? 'checked' : ''} /><span class="switch-rail"></span></label>`;
		listEl.appendChild(row);
		if (isFanqieApp) {
			row.querySelector('button').addEventListener('click', () => runFanqieSelfTest());
		}
		if (s.custom) {
			row.querySelector('.src-del').addEventListener('click', () => {
				const ok = confirm(`删除书源「${s.name}」？`);
				if (!ok) return;
				removeCustomSource(s.id);
				refreshSources();
				toast('书源已删除');
				app.refresh();
			});
		}
	});
	listEl.querySelectorAll('input[data-sidx]').forEach((input) => {
		input.addEventListener('change', () => {
			const src = sources[parseInt(input.dataset.sidx, 10)];
			src.enabled = input.checked;
			try {
				localStorage.setItem('zj-sources-override', JSON.stringify(
					Object.fromEntries(sources.map((s) => [s.id, s.enabled !== false]))
				));
			} catch { /* ignore */ }
			toast(`${src.name} 已${input.checked ? '启用' : '停用'}`);
		});
	});

	container.querySelector('#add-source').addEventListener('click', () => showAddSourcePanel(app));
}

/**
 * 添加书源（Legado JSON）
 * App 只使用小说源；漫画源请留给 PC 下载器，导入 CBZ 后离线阅读
 */
function showAddSourcePanel(app) {
	showSheet({
		title: '添加书源',
		build: (body, close) => {
			const hint = document.createElement('p');
			hint.className = 'setting-hint';
			hint.style.cssText = 'line-height:1.75;margin-bottom:12px';
			hint.innerHTML = '粘贴 <b>Legado（阅读 3.0）书源</b> 的 JSON（单条或数组），或直接粘贴 <b>JSON 文件网址</b>（http 开头）。<br>仅支持小说源；<b>漫画源</b>不适用（App 的漫画只读本地导入的 EPUB / CBZ）。';
			body.appendChild(hint);

			const ta = document.createElement('textarea');
			ta.placeholder = '{ "bookSourceName": "…", "bookSourceUrl": "…", "ruleSearch": { … }, … }';
			ta.style.cssText = 'width:100%;box-sizing:border-box;height:180px;border:1px solid var(--line);border-radius:10px;padding:12px;font:inherit;font-size:12px;line-height:1.6;background:var(--elev-2);color:var(--ink);resize:vertical';
			body.appendChild(ta);

			const status = document.createElement('p');
			status.className = 'setting-hint';
			status.style.marginTop = '10px';
			body.appendChild(status);

			const btn = document.createElement('button');
			btn.className = 'btn btn-primary btn-block';
			btn.style.marginTop = '12px';
			btn.textContent = '添加';
			btn.onclick = async () => {
				const input = ta.value.trim();
				if (!input) { status.textContent = '请粘贴书源 JSON 或 JSON 链接'; return; }
				btn.disabled = true;
				btn.textContent = '读取中…';
				status.textContent = '';
				try {
					let text = input;
					// 直接贴网址：先把 JSON 下载回来（yckceo 等站点的书源都是这种链接）
					if (/^https?:\/\//i.test(input)) {
						status.textContent = '正在下载书源…';
						const res = await requestText(input, { timeout: 30000 });
						if (res.status >= 400) throw new Error(`链接返回 HTTP ${res.status}（可能需要登录或已失效）`);
						if (!String(res.text || '').trim()) throw new Error('链接内容为空');
						text = res.text;
						status.textContent = `已下载 ${(text.length / 1024).toFixed(1)} KB，正在添加…`;
					}
					const r = addCustomSources(text);
					refreshSources();
					if (!r.added) {
						status.textContent = '这些书源都已经添加过了';
						btn.disabled = false;
						btn.textContent = '添加';
						return;
					}
					const scripted = (r.addedList || []).filter((s) => s.scripted).length;
					const comics = (r.addedList || []).filter((s) => s.kind === 'comic').length;
					toast(`已添加 ${r.added} 个书源${r.skipped ? `（${r.skipped} 个已存在）` : ''}`, 2400);
					if (comics) {
						setTimeout(() => toast(`其中 ${comics} 个是漫画源，App 内不使用（漫画请用本地导入）`, 3600), 700);
					}
					close();
					app.refresh();
					if (scripted) {
						// 不阻断添加，但必须说清楚：这类源要跑脚本/过验证
						setTimeout(() => toast('其中含脚本或登录验证的源，搜索/目录可能不完整', 3600), 600);
					}
				} catch (e) {
					status.textContent = `添加失败：${e.message || e}`;
				} finally {
					btn.disabled = false;
					btn.textContent = '添加';
				}
			};
			body.appendChild(btn);
		}
	});
}

// ============================================================
//  跨设备同步面板
// ============================================================

/** 相对时间："3 分钟前 / 2 小时前 / 昨天 14:30" */
function fmtAgo(ts) {
	const diff = Date.now() - ts;
	if (diff < 60000) return '刚刚';
	if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
	if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
	return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function showSyncPanel(container, onChanged) {
	const cfg = loadSyncConfig();
	showSheet({
		title: '跨设备同步',
		build: (body, close) => {
			if (isSyncEnabled()) {
				// 已开启：状态 + 操作
				const chan = cfg.transport === 'dav'
					? '坚果云 WebDAV'
					: `GitHub @${escapeHtml(cfg.login || 'github')}`;
				const info = document.createElement('div');
				info.style.cssText = 'font-size:13px;line-height:2;color:var(--ink-2);margin-bottom:14px';
				info.innerHTML = `同步通道：<b style="color:var(--ink)">${chan}</b><br>
					上次同步：${cfg.lastSyncAt ? new Date(cfg.lastSyncAt).toLocaleString('zh-CN') : '尚未同步'}${cfg.lastResult ? `<br>结果：${escapeHtml(cfg.lastResult)}` : ''}`;
				body.appendChild(info);

				const syncBtn = document.createElement('button');
				syncBtn.className = 'btn btn-primary btn-block';
				syncBtn.textContent = '立即同步';
				syncBtn.onclick = async () => {
					syncBtn.disabled = true;
					syncBtn.textContent = '同步中…';
					try {
						const r = await syncNow();
						const a = r.applied || {};
						const bits = [];
						if (a.books) bits.push(`书架 +${a.books} 本`);
						if (a.progress) bits.push(`进度 ${a.progress} 条`);
						if (a.bookmarks) bits.push(`书签 +${a.bookmarks}`);
						if (r.reconciled) bits.push(`合并重复 ${r.reconciled}`);
						// 本地书文件：先上传待同步的，再下载云端缺少的
						if (isFileSyncEnabled()) {
							syncBtn.textContent = '同步本地书文件…';
							const up = await uploadAllPending({ onProgress: (m) => { if (syncBtn.isConnected) syncBtn.textContent = m; } });
							if (up.uploaded) bits.push(`本地书上传 ${up.uploaded} 本`);
							if (up.failed) bits.push(`本地书失败 ${up.failed} 本`);
							if (up.missing?.length) bits.push(`缺原文件 ${up.missing.length} 本`);
							const pend = getPendingLocalDownloads();
							if (pend.length) {
								const down = await downloadAndImport(pend, { onProgress: (m) => { if (syncBtn.isConnected) syncBtn.textContent = m; } });
								if (down.downloaded) bits.push(`本地书下载 ${down.downloaded} 本`);
								if (down.failed) bits.push(`下载失败 ${down.failed}`);
							}
						}
						toast(`同步完成${bits.length ? ` · ${bits.join(' · ')}` : ' · 已是最新'}`, 2600);
						close();
						onChanged?.();
					} catch (e) {
						syncBtn.disabled = false;
						syncBtn.textContent = '立即同步';
						toast(`同步失败：${e.message || e}`, 2800);
					}
				};
				body.appendChild(syncBtn);

				// 本地书文件同步（WebDAV）
				const fileBtn = document.createElement('button');
				fileBtn.className = 'btn btn-soft btn-block';
				fileBtn.style.marginTop = '10px';
				fileBtn.innerHTML = `本地书文件同步 · ${isFileSyncEnabled() ? '已开启' : '未配置'}`;
				fileBtn.onclick = () => {
					close();
					showFileSyncPanel(container, onChanged);
				};
				body.appendChild(fileBtn);

				const retokenBtn = document.createElement('button');
				retokenBtn.className = 'btn btn-soft btn-block';
				retokenBtn.style.marginTop = '10px';
				if (cfg.transport === 'dav') {
					retokenBtn.textContent = '坚果云账号设置';
					retokenBtn.onclick = () => { close(); showFileSyncPanel(container, onChanged); };
				} else {
					retokenBtn.textContent = '更换 Token';
					retokenBtn.onclick = () => { close(); showTokenForm(container, onChanged); };
				}
				body.appendChild(retokenBtn);

				const offBtn = document.createElement('button');
				offBtn.className = 'btn btn-soft btn-block';
				offBtn.style.marginTop = '10px';
				offBtn.style.color = 'var(--danger)';
				offBtn.textContent = '关闭同步';
				offBtn.onclick = async () => {
					close();
					const ok = await showDialog({
						title: '关闭同步',
						text: '关闭后本设备将不再拉取/上传进度（云端数据保留，可随时重新开启）。',
						actions: [
							{ label: '关闭同步', kind: 'danger', value: 1 },
							{ label: '取消', kind: 'soft', value: 0 }
						]
					});
					if (ok === 1) {
						disableSync();
						toast('同步已关闭');
						onChanged?.();
					}
				};
				body.appendChild(offBtn);
			} else {
				close();
				showSyncChooser(container, onChanged);
			}
		}
	});
}

/**
 * 选择同步通道：
 *   坚果云 WebDAV —— 复用本地书同步的账号，国内直连快（推荐）
 *   GitHub Gist  —— 免费，但国内拉取经常几十 KB/s
 */
function showSyncChooser(container, onChanged) {
	const davReady = isFileSyncEnabled();
	showSheet({
		title: '开启跨设备同步',
		build: (body, close) => {
			const hint = document.createElement('p');
			hint.className = 'setting-hint';
			hint.style.cssText = 'margin-bottom:14px;line-height:1.75';
			hint.innerHTML = '同步书架、阅读进度、书签与阅读时长。<br>两个通道选一个即可：坚果云走国内线路，速度明显更快。';
			body.appendChild(hint);

			const davBtn = document.createElement('button');
			davBtn.className = davReady ? 'btn btn-primary btn-block' : 'btn btn-soft btn-block';
			davBtn.textContent = davReady ? '用坚果云同步（推荐 · 速度快）' : '用坚果云同步（先配置网盘）';
			davBtn.onclick = async () => {
				if (!davReady) {
					close();
					showFileSyncPanel(container, onChanged);
					return;
				}
				davBtn.disabled = true;
				davBtn.textContent = '首次同步中…';
				try {
					await enableDavSync();
					toast('已开启 · 坚果云通道');
					close();
					onChanged?.();
				} catch (e) {
					toast(`开启失败：${e.message || e}`, 2800);
					davBtn.disabled = false;
					davBtn.textContent = '用坚果云同步（推荐 · 速度快）';
				}
			};
			body.appendChild(davBtn);

			const ghBtn = document.createElement('button');
			ghBtn.className = 'btn btn-soft btn-block';
			ghBtn.style.marginTop = '10px';
			ghBtn.textContent = '用 GitHub 同步（免费 · 国内较慢）';
			ghBtn.onclick = () => {
				close();
				showTokenForm(container, onChanged);
			};
			body.appendChild(ghBtn);
		}
	});
}

/**
 * 本地书文件同步（WebDAV）配置面板
 * 推荐坚果云：免费额度、国内直连快、无需买服务器
 */
function showFileSyncPanel(container, onChanged) {
	const cfg = loadFileSyncConfig();
	showSheet({
		title: '本地书文件同步',
		build: (body, close) => {
			const hint = document.createElement('p');
			hint.className = 'setting-hint';
			hint.style.cssText = 'margin-bottom:12px;line-height:1.75';
			hint.innerHTML = '把导入的 EPUB / TXT / 漫画原文件同步到网盘，另一台设备同步时自动下载导入（阅读进度照常同步）。<br>推荐 <b>坚果云</b>：免费、国内直连快、不需要服务器。<br>首次使用请先在坚果云网页版 <b>我的文件 → 新建文件夹「zhijian」</b>（坚果云不允许在根目录直接放文件）。<br>密码用「应用密码」：网页版 → 账户信息 → 安全选项 → 添加应用密码。';
			body.appendChild(hint);

			const fields = [
				{ key: 'url', label: '服务器地址', ph: JIANGUOYUN_DAV },
				{ key: 'user', label: '账号（邮箱）', ph: 'you@example.com' },
				{ key: 'pass', label: '应用密码', ph: '••••••', type: 'password' }
			];
			const inputs = {};
			for (const f of fields) {
				const row = document.createElement('div');
				row.className = 'setting-row';
				const label = document.createElement('span');
				label.className = 'setting-label';
				label.textContent = f.label;
				const input = document.createElement('input');
				input.type = f.type || 'text';
				input.value = cfg[f.key] || (f.key === 'url' ? JIANGUOYUN_DAV : '');
				input.placeholder = f.ph;
				input.autocomplete = 'off';
				input.style.cssText = 'border:none;background:transparent;text-align:right;font:inherit;color:var(--ink);width:62%;outline:none';
				row.appendChild(label);
				row.appendChild(input);
				inputs[f.key] = input;
				body.appendChild(row);
			}

			const urlHint = document.createElement('p');
			urlHint.className = 'setting-hint';
			urlHint.style.cssText = 'margin:8px 0 0;font-size:11.5px;word-break:break-all';
			const refreshHint = () => {
				const finalUrl = normalizeDavUrl(inputs.url.value);
				urlHint.textContent = `实际请求地址：${finalUrl || '—'}（缺少 /dav/ 时会自动补全）`;
			};
			inputs.url.addEventListener('input', refreshHint);
			inputs.url.addEventListener('blur', refreshHint);
			refreshHint();
			body.appendChild(urlHint);

			// 明确告诉用户：书架上到底有几本本地书、传了几本
			const countLine = document.createElement('p');
			countLine.className = 'setting-hint';
			countLine.style.marginTop = '6px';
			countLine.textContent = '正在统计书架上的本地书…';
			getBooks().then((all) => {
				if (!countLine.isConnected) return;
				const locals = all.filter((b) => b.sourceId === 'local');
				if (!locals.length) {
					countLine.textContent = '书架上的书都来自在线书源，不需要传文件；导入的 EPUB/TXT 才会同步';
					return;
				}
				const uploaded = locals.filter((b) => b.fileUploadedAt).length;
				countLine.textContent = `本地书 ${locals.length} 本 · 已上传 ${uploaded} 本${uploaded < locals.length ? '（点下方按钮上传）' : ''}`;
			}).catch(() => { countLine.remove(); });
			body.appendChild(countLine);



			const status = document.createElement('p');
			status.className = 'setting-hint';
			status.style.marginTop = '10px';
			body.appendChild(status);

			const saveBtn = document.createElement('button');
			saveBtn.className = 'btn btn-primary btn-block';
			saveBtn.style.marginTop = '12px';
			saveBtn.textContent = cfg.enabled ? '保存并测试连接' : '开启并测试连接';
			saveBtn.onclick = async () => {
				saveBtn.disabled = true;
				saveBtn.textContent = '连接中…';
				status.textContent = '';
				try {
					saveFileSyncConfig({
						url: inputs.url.value.trim(),
						user: inputs.user.value.trim(),
						pass: inputs.pass.value,
						enabled: true
					});
					await testFileSyncConnection();
					toast('连接成功，正在上传现有本地书…');
					close();
					onChanged?.();
					// 配置好就交给自动同步：自动开启坚果云通道、上传本地书、下载云端缺书
					kickAutoSync();
				} catch (e) {
					saveFileSyncConfig({ enabled: false });
					status.textContent = `连接失败：${e.message || e}`;
					saveBtn.disabled = false;
					saveBtn.textContent = '重试';
				}
			};
			body.appendChild(saveBtn);

			const upBtn = document.createElement('button');
			upBtn.className = 'btn btn-soft btn-block';
			upBtn.style.marginTop = '10px';
			upBtn.textContent = '上传未同步的本地书';
			upBtn.onclick = async () => {
				upBtn.disabled = true;
				try {
					const r = await uploadAllPending({ onProgress: (m) => { if (upBtn.isConnected) upBtn.textContent = m; } });
					const extra = [r.failed ? `失败 ${r.failed}` : '', r.missing?.length ? `缺原文件 ${r.missing.length}` : ''].filter(Boolean).join(' · ');
					toast(r.uploaded ? `已上传 ${r.uploaded} 本${extra ? ` · ${extra}` : ''}` : (extra ? `上传完成 · ${extra}` : '没有待上传的书'), 3000);
				} catch (e) {
					toast(`上传失败：${e.message || e}`, 2600);
				}
				upBtn.disabled = false;
				upBtn.textContent = '上传未同步的本地书';
			};
			body.appendChild(upBtn);

			const pending = getPendingLocalDownloads();
			if (pending.length) {
				const downBtn = document.createElement('button');
				downBtn.className = 'btn btn-soft btn-block';
				downBtn.style.marginTop = '10px';
				downBtn.textContent = `下载其他设备的 ${pending.length} 本本地书`;
				downBtn.onclick = async () => {
					downBtn.disabled = true;
					try {
						const r = await downloadAndImport(pending, { onProgress: (m) => { if (downBtn.isConnected) downBtn.textContent = m; } });
						toast(`已下载 ${r.downloaded} 本${r.failed ? ` · 失败 ${r.failed}` : ''}`, 2600);
						close();
						onChanged?.();
					} catch (e) {
						toast(`下载失败：${e.message || e}`, 2600);
						downBtn.disabled = false;
						downBtn.textContent = `下载其他设备的 ${pending.length} 本本地书`;
					}
				};
				body.appendChild(downBtn);
			}

			if (cfg.enabled) {
				const offBtn = document.createElement('button');
				offBtn.className = 'btn btn-soft btn-block';
				offBtn.style.cssText = 'margin-top:10px;color:var(--danger)';
				offBtn.textContent = '关闭文件同步';
				offBtn.onclick = () => {
					saveFileSyncConfig({ enabled: false });
					toast('已关闭本地书文件同步');
					close();
					onChanged?.();
				};
				body.appendChild(offBtn);
			}
		}
	});
}

/** Token 配置表单（含获取步骤说明） */
function showTokenForm(container, onChanged) {	showSheet({
		title: '开启同步',
		build: (body, close) => {
			const steps = document.createElement('div');
			steps.style.cssText = 'font-size:12.5px;line-height:1.9;color:var(--ink-2);margin-bottom:12px;background:var(--elev-2);border-radius:12px;padding:13px 14px';
			steps.innerHTML = `<div style="font-weight:700;color:var(--ink);margin-bottom:5px">在 GitHub 获取 Token（约 2 分钟）</div>
				1. 打开 github.com 登录（没有账号先免费注册）<br>
				2. 访问 <b>github.com/settings/tokens/new</b><br>
				3. Note 随便填（如：纸间同步）；Expiration 选 No expiration<br>
				4. 权限只勾选 <b>gist</b> 这一项<br>
				5. 拉到底点「Generate token」，复制 <b>ghp_</b> 开头的串<br>
				6. 粘贴到下面并开启。第二台设备填<b>同一账号</b>的 Token 即可自动接上`;
			body.appendChild(steps);

			const input = document.createElement('input');
			input.type = 'password';
			input.placeholder = '粘贴 GitHub Token（ghp_…）';
			input.style.cssText = 'width:100%;box-sizing:border-box;padding:13px 14px;border-radius:12px;border:1px solid var(--line-strong);background:var(--elev);color:var(--ink);font-size:14px;margin-bottom:12px;font-family:var(--font-ui)';
			body.appendChild(input);

			const btn = document.createElement('button');
			btn.className = 'btn btn-primary btn-block';
			btn.textContent = '开启同步';
			btn.onclick = async () => {
				const token = input.value.trim();
				if (!token || !/^gh[pousr]_/.test(token)) {
					toast('Token 格式不对（应以 ghp_ 开头）');
					return;
				}
				btn.disabled = true;
				btn.textContent = '验证中…';
				try {
					const r = await enableSync(token);
					toast(`同步已开启（@${r.login}）${r.created ? ' · 已创建同步仓库' : ' · 已连接' }`, 2600);
					close();
					onChanged?.();
				} catch (e) {
					btn.disabled = false;
					btn.textContent = '开启同步';
					toast(`开启失败：${e.message || e}`, 3000);
				}
			};
			body.appendChild(btn);
		}
	});
}



// ============================================================
//  番茄源自检（诊断工具）
// ============================================================

function runFanqieSelfTest() {
	showSheet({
		title: '番茄源自检',
		build: (body) => {
			const log = document.createElement('div');
			log.style.cssText = 'font-size:13px;line-height:2;color:var(--ink-2);font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-all';
			log.textContent = '开始自检（需联网）…\n';
			body.appendChild(log);
			const step = (msg, ok) => {
				log.textContent += `${ok === true ? '✅' : ok === false ? '❌' : '…'} ${msg}\n`;
			};
			(async () => {
				// 每一步独立捕获：一处失败不影响其余环节的诊断
				let t = Date.now();
				let results = null;
				try {
					results = await fqAppSearch('十日终焉');
					step(`搜索「十日终焉」：${results.length} 条（${Date.now() - t}ms）`, results.length > 0);
					if (results[0]) step(`首条：${results[0].bookName}`, true);
				} catch (e) {
					step(`搜索失败：${e.message || e}`, false);
				}
				let toc = null;
				try {
					t = Date.now();
					toc = await fqAppToc('7143038691944959011');
					step(`目录：${toc.chapters.length} 章（${Date.now() - t}ms）`, toc.chapters.length > 100);
				} catch (e) {
					step(`目录失败：${e.message || e}`, false);
				}
				if (toc && toc.chapters.length) {
					try {
						t = Date.now();
						const paras = await fqAppChapter(toc.chapters[0].url);
						step(`正文：${paras.length} 段（${Date.now() - t}ms）`, paras.length > 3);
						if (paras[0]) step(`首段：${paras[0].slice(0, 42)}`, true);
					} catch (e) {
						step(`正文失败：${e.message || e}`, false);
					}
				}
				log.textContent += '\n自检完成';
			})();
		}
	});
}
