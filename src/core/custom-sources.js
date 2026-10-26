/**
 * 自定义书源 —— 粘贴 Legado（阅读 3.0）书源 JSON 即可加入书架引擎
 *
 * 为什么需要它：
 *   内置书源都是小说站；漫画站的结构差异极大，没法用一份固定规则覆盖。
 *   这里只做「规则搬运」：用户自己有账号/有权访问的站点，把它的书源规则
 *   贴进来，App 用同一套 legado 适配器跑。
 *
 * bookSourceType 的约定（Legado 原生字段）：
 *   0 = 文本，1 = 音频，2 = 图片（漫画）→ 2 会自动标记成漫画书源
 */
const KEY = 'zj-custom-sources-v1';

function hash(str) {
	let h = 5381;
	for (let i = 0; i < String(str).length; i++) h = ((h << 5) + h + String(str).charCodeAt(i)) >>> 0;
	return h.toString(36);
}

/** 书源名/地址都能看出是漫画站时，兜底识别 */
function guessKind(raw, name, url) {
	if (Number(raw.bookSourceType) === 2) return 'comic';
	if (raw.kind === 'comic' || raw.sourceType === 'comic' || raw.type === 'comic') return 'comic';
	if (/漫画|漫畫|comic|manga|manhua|manhwa/i.test(`${name} ${url}`)) return 'comic';
	return '';
}

/** 把一条 Legado 原始书源转成 App 内部结构 */
export function normalizeCustomSource(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const url = String(raw.bookSourceUrl || raw.url || '').trim();
	const name = String(raw.bookSourceName || raw.name || '').trim();
	if (!url || !name) return null;
	if (!/^https?:\/\//i.test(url)) return null;
	const ruleSearch = raw.ruleSearch || {};
	const ruleToc = raw.ruleToc || raw.ruleChapterList || {};
	const ruleContent = raw.ruleContent || {};
	// 至少要能搜到书、能拿目录、能拿内容，否则加进去也是坏的
	if (!raw.searchUrl && !ruleSearch.bookList) return null;
	if (!ruleToc.chapterList) return null;
	if (!ruleContent.content) return null;

	// 依赖脚本 / 登录验证的源：能加，但不保证能跑
	const scriptText = [
		raw.searchUrl || '',
		raw.loginUrl || '',
		raw.loginCheckJs || '',
		JSON.stringify(ruleSearch),
		JSON.stringify(ruleToc),
		JSON.stringify(ruleContent)
	].join('\n');
	const scripted = /@js:|<js>|java\.|startBrowserAwait|loginCheckJs/i.test(scriptText);

	const kind = guessKind(raw, name, url);
	return {
		id: `cs-${hash(url)}`,
		name,
		type: 'legado',
		url: url.replace(/\/+$/, ''),
		enabled: true,
		custom: true,
		kind,
		searchUrl: String(raw.searchUrl || ''),
		ruleSearch,
		ruleBookInfo: raw.ruleBookInfo || {},
		ruleToc,
		ruleContent,
		header: raw.header || '',
		comicInclude: raw.comicInclude || '',
		comicExclude: raw.comicExclude || '',
		scripted
	};
}

export function loadCustomSources() {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return [];
		const list = JSON.parse(raw);
		if (!Array.isArray(list)) return [];
		return list.filter((s) => s && s.id && s.url && s.type === 'legado');
	} catch {
		return [];
	}
}

export function saveCustomSources(list) {
	try {
		localStorage.setItem(KEY, JSON.stringify(list || []));
	} catch { /* ignore */ }
	return list || [];
}

/**
 * 解析用户粘贴的 JSON（支持单条 / 数组 / {sources:[...]}）
 * @returns {{list: Array, error: string}}
 */
/** 这条书源缺什么（用于「添加失败」的具体提示） */
export function describeMissingSource(raw) {
	if (!raw || typeof raw !== 'object') return '不是有效的书源对象';
	const url = String(raw.bookSourceUrl || raw.url || '').trim();
	const name = String(raw.bookSourceName || raw.name || '').trim();
	const ruleSearch = raw.ruleSearch || {};
	const ruleToc = raw.ruleToc || {};
	const ruleContent = raw.ruleContent || {};
	if (!url) return '缺少 bookSourceUrl';
	if (!/^https?:\/\//i.test(url)) return 'bookSourceUrl 不是 http(s) 地址';
	if (!name) return '缺少 bookSourceName';
	if (!raw.searchUrl && !ruleSearch.bookList) return '缺少 searchUrl（或 ruleSearch.bookList）';
	if (!ruleToc.chapterList) return '缺少 ruleToc.chapterList（目录规则）';
	if (!ruleContent.content) return '缺少 ruleContent.content（正文规则）';
	return '';
}

export function parseSourceInput(text) {
	const trimmed = String(text || '').trim();
	if (!trimmed) return { list: [], error: '请粘贴书源 JSON' };
	let data;
	try {
		data = JSON.parse(trimmed);
	} catch {
		return { list: [], error: '不是合法的 JSON（注意不要带注释、结尾不要多逗号）' };
	}
	const arr = Array.isArray(data)
		? data
		: Array.isArray(data?.sources)
			? data.sources
			: [data];
	const list = arr.map(normalizeCustomSource).filter(Boolean);
	if (!list.length) {
		// 指出第一条到底缺什么，别让用户对着「格式不对」猜
		const reasons = arr.map((raw, i) => {
			const why = describeMissingSource(raw);
			return why ? `第 ${i + 1} 条：${why}` : '';
		}).filter(Boolean);
		return { list: [], error: `没有可用的书源${reasons.length ? `（${reasons[0]}）` : '：需要 bookSourceUrl / bookSourceName / searchUrl / ruleToc / ruleContent'}` };
	}
	return { list, error: '' };
}

/** 追加书源（按 url 去重），返回 {added, skipped, list} */
export function addCustomSources(text) {
	const { list, error } = parseSourceInput(text);
	if (error) throw new Error(error);
	const current = loadCustomSources();
	const byUrl = new Map(current.map((s) => [s.url, s]));
	const addedList = [];
	let skipped = 0;
	for (const s of list) {
		if (byUrl.has(s.url)) { skipped++; continue; }
		byUrl.set(s.url, s);
		addedList.push(s);
	}
	const next = [...byUrl.values()];
	saveCustomSources(next);
	return { added: addedList.length, skipped, list: next, addedList };
}

export function removeCustomSource(id) {
	const next = loadCustomSources().filter((s) => s.id !== id);
	saveCustomSources(next);
	return next;
}
