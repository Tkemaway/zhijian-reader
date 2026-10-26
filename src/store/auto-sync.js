/**
 * 自动同步服务
 *
 * 目标：用户不需要打开任何界面点「同步」。启动、回到前台、网络恢复、
 * 以及每 5 分钟都会自动跑一轮：
 *   1. 已经配好坚果云网盘但还没开同步 → 自动用坚果云通道开启
 *   2. 上传待传的本地书（没有原文件的旧书自动打包成 EPUB）
 *   3. 拉取远端快照（书架 / 进度 / 书签 / 阅读时长）
 *   4. 下载「云端有、本机没有」的本地书并导入
 *   5. 本轮有任何变化 → 再推一次，让另一台设备立刻看到
 */
import { isSyncEnabled, syncNow, enableDavSync, getPendingLocalDownloads, loadSyncConfig } from './sync.js';
import { isFileSyncEnabled, uploadAllPending, downloadAndImport } from './book-files.js';

const MIN_GAP = 30 * 1000; // 非强制触发的最小间隔

let _running = false;
let _lastRun = 0;
let _notify = null;

/**
 * 跑一轮自动同步
 * @param {{force?: boolean, reason?: string}} opts
 * @returns {Promise<{changed:boolean, uploaded:number, downloaded:number, failed:number}|null>}
 */
export async function runAutoSync({ force = false, reason = 'timer' } = {}) {
	if (_running) return null;
	if (!force && Date.now() - _lastRun < MIN_GAP) return null;
	if (!isFileSyncEnabled() && !isSyncEnabled()) return null;
	_running = true;
	try {
		let changed = false;

		// 1. 有网盘账号但同步没开 → 自动开（用户手动关过就不再自动开）
		const cfg = loadSyncConfig();
		if (isFileSyncEnabled() && !isSyncEnabled() && !cfg.autoDisabled) {
			try {
				await enableDavSync();
				_notify?.('已自动开启坚果云同步');
			} catch { /* 网络/服务异常，下一轮再试 */ }
		}

		// 2. 先拉一次远端（应用进度、发现云端缺的书）
		if (isSyncEnabled()) {
			try { await syncNow(); } catch { /* 静默，离线时下轮再试 */ }
		}

		// 3. 上传本地书（旧书会先打包）
		let uploaded = 0;
		let failed = 0;
		try {
			const up = await uploadAllPending({});
			uploaded = up.uploaded || 0;
			failed = up.failed || 0;
			if (uploaded) {
				changed = true;
				_notify?.(`已自动上传 ${uploaded} 本本地书`);
			}
		} catch { /* 忽略，下轮再试 */ }

		// 4. 下载云端有、本机没有的本地书
		let downloaded = 0;
		const pend = getPendingLocalDownloads();
		if (pend.length) {
			try {
				const down = await downloadAndImport(pend, {});
				downloaded = down.downloaded || 0;
				if (downloaded) {
					changed = true;
					_notify?.(`已自动下载 ${downloaded} 本本地书`);
				}
			} catch { /* 忽略 */ }
		}

		// 5. 有变化 → 立刻再推一次，让另一台设备看到新书/新文件
		if (changed && isSyncEnabled()) {
			try { await syncNow(); } catch { /* 忽略 */ }
		}

		_lastRun = Date.now();
		return { changed, uploaded, downloaded, failed, reason };
	} finally {
		_running = false;
	}
}

/**
 * 启动自动同步调度
 * @param {{notify?: (msg: string) => void}} opts
 */
export function startAutoSync({ notify } = {}) {
	_notify = typeof notify === 'function' ? notify : null;

	// 启动后稍等（让首屏渲染完成）再跑
	setTimeout(() => { runAutoSync({ force: true, reason: 'boot' }).catch(() => {}); }, 2500);

	// 回到前台
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			runAutoSync({ reason: 'visible' }).catch(() => {});
		}
	});

	// 网络恢复
	window.addEventListener('online', () => {
		runAutoSync({ force: true, reason: 'online' }).catch(() => {});
	});
}

/**
 * 导入书籍后触发同步：3 秒内多次调用会合并成一次，避免连续导入时反复联网
 */
let _kickTimer = null;
export function kickAutoSync() {
	clearTimeout(_kickTimer);
	_kickTimer = setTimeout(() => {
		runAutoSync({ force: true, reason: 'import' }).catch(() => {});
	}, 3000);
}
