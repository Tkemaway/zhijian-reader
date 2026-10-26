/**
 * 屏幕常亮（Screen Wake Lock API，WebView 与浏览器通用）
 */
let lock = null;
let wantOn = false;

export async function keepAwake(on) {
	wantOn = !!on;
	try {
		if (on) {
			if (!lock && typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
				lock = await navigator.wakeLock.request('screen');
				lock.addEventListener?.('release', () => {
					lock = null;
					// 系统回收后如果仍需要，稍后重试
					if (wantOn) setTimeout(() => keepAwake(true), 2000);
				});
			}
		} else if (lock) {
			await lock.release();
			lock = null;
		}
	} catch {
		lock = null;
	}
}
