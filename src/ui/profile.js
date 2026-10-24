/**
 * 我的页 —— 阅读统计 + 防沉迷限额 + 书源管理
 */
import sources from '../core/sources.js';
import { loadSettings, saveSettings, applyPaperInkPreset, getWeekData, getTodaySeconds, getLimitStateWithExtra, fmtDuration } from '../store/stats.js';
import { keepAwake } from '../store/wakelock.js';
import { getBooks } from '../store/db.js';
import { loadSyncConfig, isSyncEnabled, enableSync, enableDavSync, disableSync, syncNow, getPendingLocalDownloads } from '../store/sync.js';
import {
	loadFileSyncConfig, saveFileSyncConfig, isFileSyncEnabled,
	uploadAllPending, downloadAndImport, testFileSyncConnection, JIANGUOYUN_DAV
} from '../store/book-files.js';
import { icon, toast, showDialog, showSheet, applyInkMode } from './kit.js';
import { escapeHtml } from './library.js';

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '开发版';

export async function renderProfile(container, app) {
	const settings = loadSettings();
	const week = getWeekData();
	const todaySec = getTodaySeconds();
	const limit = getLimitStateWithExtra();

	let books = [];
	try { books = await getBooks(); } catch { /* ignore */ }
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

		<div class="section-title">书源（${sources.filter((s) => s.enabled !== false).length} 个启用）</div>
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
			: `${s.type === 'legado' ? '阅读系规则' : 'SoNovel 规则'} · ${escapeHtml(s.url)}`;
		row.innerHTML = `
			<div>
				<div class="setting-label">${escapeHtml(s.name)}</div>
				<div class="setting-hint">${hint}</div>
			</div>
			${isFanqieApp ? '<button class="btn btn-soft btn-sm" style="margin-right:10px">自检</button>' : ''}
			<label class="switch"><input type="checkbox" data-sidx="${i}" ${s.enabled !== false ? 'checked' : ''} /><span class="switch-rail"></span></label>`;
		listEl.appendChild(row);
		if (isFanqieApp) {
			row.querySelector('button').addEventListener('click', () => runFanqieSelfTest());
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
			hint.innerHTML = '把导入的 EPUB / TXT 原文件同步到网盘，另一台设备同步时自动下载导入（阅读进度照常同步）。<br>推荐 <b>坚果云</b>：免费、国内直连快、不需要服务器。<br>密码请用「应用密码」：网页版 → 账户信息 → 安全选项 → 添加应用密码。';
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
					toast('连接成功，本地书会在同步时自动上传');
					close();
					onChanged?.();
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
					toast(r.uploaded ? `已上传 ${r.uploaded} 本${r.failed ? ` · 失败 ${r.failed}` : ''}` : (r.failed ? `上传失败 ${r.failed} 本` : '没有待上传的书'), 2600);
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
				const { fqAppSearch, fqAppToc, fqAppChapter } = await import('../core/fanqie-app.js');
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
