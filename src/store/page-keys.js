/**
 * 硬件翻页键 —— 音量键桥
 *
 * 只有阅读器打开时把音量键当翻页键（原生层 dispatchKeyEvent 拦截），
 * 退出阅读器立刻交还给系统音量。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

const PageKeys = registerPlugin('PageKeys');

let last = null;

export function setPageKeysEnabled(on) {
	const next = !!on;
	if (last === next) return;
	last = next;
	if (!Capacitor.isNativePlatform()) return;
	try {
		PageKeys.setEnabled({ enabled: next }).catch(() => {});
	} catch { /* 网页环境没有这个插件 */ }
}
