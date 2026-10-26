/**
 * 书源入口 —— 内置书源 + 用户自定义书源，并应用启用/停用偏好
 * 所有消费方从这里 import，保证偏好全局一致
 */
import raw from './sources.json';
import { loadCustomSources } from './custom-sources.js';

const builtin = raw.map((s) => ({ kind: '', ...s }));

const all = [...builtin, ...loadCustomSources()];

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
	all.push(...loadCustomSources());
	applyOverrides();
	return all;
}

export default all;

