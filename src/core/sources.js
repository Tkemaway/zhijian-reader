/**
 * 书源入口 —— 内置书源 + 用户自定义书源，并应用启用/停用偏好
 * 所有消费方从这里 import，保证偏好全局一致
 *
 * App 只处理文字书：漫画不再走在线书源（阅读器只读本地导入的图片），
 * 因此这里把漫画类型的自定义源过滤掉，避免出现「能搜到但打不开」。
 * 漫画源仍然可以喂给 PC 下载器（tools/comic-downloader）。
 */
import raw from './sources.json';
import { loadCustomSources } from './custom-sources.js';

const builtin = raw.map((s) => ({ kind: '', ...s }));
const textOnly = (list) => list.filter((s) => s.kind !== 'comic');

const all = [...builtin, ...textOnly(loadCustomSources())];

function applyOverrides() {
	try {
		const overrideJson = typeof localStorage !== 'undefined' ? localStorage.getItem('zj-sources-override') : null;
		if (!overrideJson) return;
		const override = JSON.parse(overrideJson);
		for (const s of all) {
			if (Object.prototype.hasOwnProperty.call(override, s.id)) {
				s.enabled = !!override[s.id];
			}
		}
	} catch { /* ignore */ }
}
applyOverrides();

/**
 * 重新读取自定义书源（在设置里添加/删除后调用）。
 * 就地修改数组，所有 import 了 sources 的页面都会看到新列表。
 */
export function refreshSources() {
	for (let i = all.length - 1; i >= 0; i--) {
		if (all[i].custom) all.splice(i, 1);
	}
	all.push(...textOnly(loadCustomSources()));
	applyOverrides();
	return all;
}

export default all;

