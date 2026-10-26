/**
 * 显示模式 —— 墨水屏识别 + 动效预算
 *
 * 为什么需要：墨水屏（E Ink）刷新一整屏要几百毫秒，期间会留下残影。
 * 所有"大面积连续变化"的动画（位移、模糊、循环渐变）在真机上都会变成拖影，
 * 而"只改亮度"的淡入淡出是安全的（Kindle 自己就是这么翻页的）。
 *
 * 所以这里不删动画，只分档：
 *   full  完整（默认，普通手机/平板）
 *   lite  精简（墨水屏默认：保留淡化，去掉位移/模糊/循环动画）
 *   off   关闭（连淡化也去掉，适合老设备或晕动敏感用户）
 */

// 主流墨水屏品牌/机型（BOOX、汉王、掌阅、Meebook…）会把自己的品牌写进 UA
const EINK_UA = /(Onyx|BOOX|Hisense|iReader|Likebook|Boyue|Meebook|Hanwang|Hanvon|tolino|Kobo|Supernote|PocketBook|Dasung|Bigme|E-?ink)/i;

/**
 * 是否像墨水屏设备。
 * 只认 UA：`(update: slow)` 在部分普通手机省电模式下也会命中，
 * 用它来决定"整站变纯黑白"风险太大，只拿它来降动效。
 */
export function detectEink() {
	if (typeof navigator === 'undefined') return false;
	return EINK_UA.test(navigator.userAgent || '');
}

/** 屏幕更新是否偏慢（低刷新率 / 墨水屏）；只用于决定动效档位 */
export function detectSlowDisplay() {
	try {
		return typeof window !== 'undefined' && !!window.matchMedia?.('(update: slow)').matches;
	} catch {
		return false;
	}
}

/**
 * 应用显示模式（幂等，可反复调用）
 * @param {{einkMode?: string, motion?: string}} settings
 * @returns {{eink: boolean, motion: 'full'|'lite'|'off', auto: boolean}}
 */
export function applyDisplayMode(settings = {}) {
	if (typeof document === 'undefined') return { eink: false, motion: 'full', auto: false };
	const auto = detectEink();
	const einkMode = settings.einkMode || 'auto';
	const eink = einkMode === 'on' || (einkMode === 'auto' && auto);

	const wanted = settings.motion || 'auto';
	const autoMotion = eink || detectSlowDisplay() ? 'lite' : 'full';
	const motion = wanted === 'auto' ? autoMotion : wanted;

	const body = document.body;
	body.classList.toggle('eink', eink);
	body.classList.remove('motion-full', 'motion-lite', 'motion-off');
	body.classList.add(`motion-${motion}`);

	// 系统栏颜色：墨水屏用纯白，避免状态栏和纸面不是同一个白
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) {
		meta.content = eink ? '#ffffff' : (body.classList.contains('ink-mode') ? '#e8e7e1' : '#faf8f5');
	}

	return { eink, motion, auto };
}
