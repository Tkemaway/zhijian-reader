/**
 * 书源入口 —— 加载内置书源并应用用户的启用/停用偏好
 * 所有消费方从这里 import，保证偏好全局一致
 */
import raw from './sources.json';

// 应用用户的书源开关偏好（localStorage 持久化）
try {
	const overrideJson = typeof localStorage !== 'undefined' ? localStorage.getItem('zj-sources-override') : null;
	if (overrideJson) {
		const override = JSON.parse(overrideJson);
		for (const s of raw) {
			if (Object.prototype.hasOwnProperty.call(override, s.id)) {
				s.enabled = !!override[s.id];
			}
		}
	}
} catch { /* ignore */ }

export default raw;
