/**
 * 设置 + 阅读统计 + 防沉迷限额
 */

const SETTINGS_KEY = 'zj-settings-v1';
const READING_KEY = 'zj-reading-v1';

export const DEFAULT_SETTINGS = {
	theme: 'paper',           // paper | sepia | ink | night | green
	fontSize: 18,             // 正文字号 px
	lineHeight: 1.9,          // 行高
	paragraphGap: 0.9,        // 段间距 em
	pageMode: 'scroll',       // scroll | page
	turnStyle: 'fade',        // fade(淡化翻页·Kindle式) | slide(平滑滑动)
	fontFamily: 'serif',      // serif(宋体) | wenkai(文楷) | sans(黑体)
	limitEnabled: true,       // 防沉迷限额开关
	limitMinutes: 60,         // 每日限额（分钟）
	pinToBottom: false,
	keepAwake: true,          // 阅读时保持亮屏
	inkMode: false,           // 纸墨护眼模式（普通 Android 上的低刺激阅读主题）
	frontLight: 'mid',        // 前光色温：off(6500K) | low(~4500K) | mid(~3500K) | high(2700K 琥珀)
	paperGrain: true          // 轻微纸面颗粒（普通屏幕上的材质提示）
};

/** 普通 Android 的纸墨护眼阅读预设：低饱和纸色 + 单页短淡化翻页。 */
export const PAPER_INK_PRESET = {
	inkMode: true,
	theme: 'ink',
	pageMode: 'page',
	turnStyle: 'fade',
	fontFamily: 'serif',
	fontSize: 18,
	lineHeight: 1.85,
	paragraphGap: 0.8,
	frontLight: 'mid',
	paperGrain: true
};

export function applyPaperInkPreset() {
	return saveSettings(PAPER_INK_PRESET);
}

export function loadSettings() {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		const s = { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
		// 迁移：旧的"点击翻页"(flip) 升级为新的"翻页阅读"(page)
		if (s.pageMode === 'flip') s.pageMode = 'page';
		if (s.pageMode !== 'scroll' && s.pageMode !== 'page') s.pageMode = 'scroll';
		// 迁移：前光从开关升级为色温档位（true→中档，false→关）
		if (typeof s.frontLight === 'boolean') s.frontLight = s.frontLight ? 'mid' : 'off';
		if (!['off', 'low', 'mid', 'high'].includes(s.frontLight)) s.frontLight = 'mid';
		return s;
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(patch) {
	const next = { ...loadSettings(), ...patch };
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
	} catch { /* ignore */ }
	return next;
}

// ---------- 阅读时长 ----------

function todayKey(d = new Date()) {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function loadReading() {
	try {
		const raw = localStorage.getItem(READING_KEY);
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

function saveReading(data) {
	try {
		localStorage.setItem(READING_KEY, JSON.stringify(data));
	} catch { /* ignore */ }
}

// ---------- 跨设备时长汇总（由 sync.js 在同步时写入） ----------
// 结构：{ 'YYYY-MM-DD': 其他设备合计秒数 }
// 设计：每台设备只维护"自己那份"贡献，汇总时相加，天然不会重复计算。

const REMOTE_READING_KEY = 'zj-reading-remote-v1';

function loadRemoteReading() {
	try {
		const raw = localStorage.getItem(REMOTE_READING_KEY);
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

export function saveRemoteReadingMap(map) {
	try {
		localStorage.setItem(REMOTE_READING_KEY, JSON.stringify(map || {}));
	} catch { /* ignore */ }
}

export function getRemoteReadingMap() {
	return loadRemoteReading();
}

/** 本机原始每日时长（供同步上传；不含其他设备的部分） */
export function getLocalDailyMap() {
	const data = loadReading();
	const out = {};
	for (const [k, v] of Object.entries(data)) out[k] = v?.seconds || 0;
	return out;
}

/** 今日已读秒数（本机 + 其他设备的同步贡献） */
export function getTodaySeconds() {
	const data = loadReading();
	const remote = loadRemoteReading();
	return (data[todayKey()]?.seconds || 0) + (remote[todayKey()] || 0);
}

/** 累加阅读时长 */
export function addReadingSeconds(sec) {
	if (sec <= 0) return;
	const data = loadReading();
	const key = todayKey();
	if (!data[key]) data[key] = { seconds: 0 };
	data[key].seconds += sec;
	// 清理 90 天前的数据
	const cutoff = Date.now() - 90 * 86400 * 1000;
	for (const k of Object.keys(data)) {
		const t = new Date(k + 'T00:00:00').getTime();
		if (!Number.isNaN(t) && t < cutoff) delete data[k];
	}
	saveReading(data);
}

/** 近 7 天数据（含今天，从旧到新；本机 + 其他设备同步贡献） */
export function getWeekData() {
	const data = loadReading();
	const remote = loadRemoteReading();
	const out = [];
	for (let i = 6; i >= 0; i--) {
		const d = new Date(Date.now() - i * 86400 * 1000);
		const key = todayKey(d);
		out.push({
			key,
			label: ['日', '一', '二', '三', '四', '五', '六'][d.getDay()],
			seconds: (data[key]?.seconds || 0) + (remote[key] || 0),
			isToday: i === 0
		});
	}
	return out;
}

/** 限额状态 */
export function getLimitState() {
	const s = loadSettings();
	if (!s.limitEnabled || s.limitMinutes <= 0) {
		return { enabled: false, usedSec: getTodaySeconds(), limitSec: Infinity, ratio: 0, exceeded: false, nearly: false };
	}
	const usedSec = getTodaySeconds();
	const limitSec = s.limitMinutes * 60;
	const ratio = usedSec / limitSec;
	return {
		enabled: true,
		usedSec,
		limitSec,
		ratio,
		exceeded: ratio >= 1,
		nearly: ratio >= 0.8 && ratio < 1
	};
}

/** 临时延长额度（分钟） */
const EXTRA_KEY = 'zj-extra-v1';
export function grantExtraMinutes(min) {
	try {
		const raw = localStorage.getItem(EXTRA_KEY);
		const data = raw ? JSON.parse(raw) : {};
		const key = todayKey();
		data[key] = (data[key] || 0) + min;
		localStorage.setItem(EXTRA_KEY, JSON.stringify(data));
	} catch { /* ignore */ }
}

export function getExtraMinutes() {
	try {
		const raw = localStorage.getItem(EXTRA_KEY);
		const data = raw ? JSON.parse(raw) : {};
		return data[todayKey()] || 0;
	} catch {
		return 0;
	}
}

/** 限额状态（含延长） */
export function getLimitStateWithExtra() {
	const base = getLimitState();
	if (!base.enabled) return base;
	const extraSec = getExtraMinutes() * 60;
	const usedSec = base.usedSec;
	const limitSec = base.limitSec + extraSec;
	const ratio = usedSec / limitSec;
	return {
		...base,
		limitSec,
		ratio,
		exceeded: ratio >= 1,
		nearly: ratio >= 0.8 && ratio < 1
	};
}

/** 格式化时长 */
export function fmtDuration(sec) {
	const m = Math.floor(sec / 60);
	if (m < 60) return `${m} 分钟`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

// ---------- 阅读速度（用于"剩余阅读时间"估算，Kindle 式） ----------

const SPEED_KEY = 'zj-reading-speed-v1';
const DEFAULT_SPEED = 450; // 字/分钟（网文平均阅读速度的经验值）

/** 获取当前阅读速度（字/分钟） */
export function getReadingSpeed() {
	try {
		const v = parseFloat(localStorage.getItem(SPEED_KEY));
		if (Number.isFinite(v) && v > 120 && v < 2200) return Math.round(v);
	} catch { /* ignore */ }
	return DEFAULT_SPEED;
}

/** 用新样本平滑校准阅读速度（EMA，抗抖动） */
export function updateReadingSpeed(chars, seconds) {
	try {
		if (!(chars >= 40 && seconds >= 4 && seconds <= 600)) return;
		const sample = chars / (seconds / 60);
		if (sample < 80 || sample > 2600) return; // 异常样本（随手翻页/挂机）过滤
		const cur = getReadingSpeed();
		const next = Math.round(cur * 0.82 + sample * 0.18);
		localStorage.setItem(SPEED_KEY, String(next));
	} catch { /* ignore */ }
}

/** 估算剩余阅读分钟数 */
export function estimateMinutes(remainChars) {
	if (!Number.isFinite(remainChars) || remainChars <= 0) return 0;
	return Math.max(1, Math.round(remainChars / getReadingSpeed()));
}
