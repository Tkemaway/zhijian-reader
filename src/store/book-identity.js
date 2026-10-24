/**
 * 书籍身份 —— 全应用统一的「同一本书」判定口径
 *
 * 为什么需要它：本地 book.id 每台设备、每次入架都不同，不能作为跨设备主键；
 * 而「同一本书」横跨多个功能（书架分组 / 换源 / 同步去重 / 搜索入架去重）。
 * 各处各写一套归一化规则时，必然出现「书架的键和同步的键不一致」——
 * 表现为同步时匹配不上本地已有记录，于是源源不断地新建重复书籍。
 *
 * 本模块是**唯一**的身份口径：
 *   - 字段先做显式归一化（去首尾空白 / 全角空格 / 压缩空白 / NFKC /
 *     书名去包裹符号 / 作者去「作者：」前缀）
 *   - 身份键 = 归一化书名 + 归一化作者 + 书源 id
 *   - 匹配时先按完整身份键，再退化为「书名+书源」（作者缺失很常见），
 *     都匹配不到才认为是一本新书
 *
 * 零依赖纯函数，便于在 Node 中直接单测。
 */
/** 身份键分隔符（控制字符，正常书名不会包含） */
import { cleanMetaText } from '../core/text-clean.js';

export const KEY_SEP = String.fromCharCode(1);

/** 全部「空白」类码位：ASCII 空白 + 各类 Unicode 空格/行分隔符 */
const WS_CODES = [
	0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
	0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
	0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000
];
const SPACE_CLASS = WS_CODES.map((c) => String.fromCharCode(c)).join('');
const SPACE_RE = new RegExp('[' + SPACE_CLASS + ']+', 'g');

/** 作者前缀（「作者：」「作者:」） */
const AUTHOR_PREFIX_RE = /^\s*(?:作者|著者|作家)\s*[:：]\s*/;

/** 书名包裹符号：「书名号」[]【】"" 等 */
const TITLE_WRAP_RE = /^[《〈「『【\[（(\s]+|[》〉」』】\]）)\s]+$/g;

/** 「连载中 / 完结」等状态尾巴，不属于书名本身 */
const TITLE_TAIL_RE = /[\s（(\[]*(?:连载中?|已完结|全本|完结|免费阅读|无弹窗)[）)\]]*\s*$/;


/**
 * 基础文本归一化：NFKC + 压缩空白 + 去首尾
 * 只把「看起来一样、字节不一样」的写法收敛到同一形态，
 * 不改动有意义的字符（CJK / 字母 / 数字全部保留）。
 */
export function normalizeText(value) {
	if (value === null || value === undefined) return '';
	let s = String(value);
	try {
		s = s.normalize('NFKC');
	} catch { /* 老环境不支持则跳过 */ }
	s = s.replace(SPACE_RE, ' ').trim();
	return s;
}

/**
 * 书名归一化：去包裹符、去状态尾巴、去空白。
 * 包裹符要循环剥离：「《《书名》》」这类多重包裹若只替换一趟会残留，
 * 导致同一本书在两次归一化后得到不同结果（键漂移 → 同步重复建书）。
 */
export function normalizeTitle(title) {
	let s = normalizeText(cleanMetaText(title));
	if (!s) return '';
	for (let i = 0; i < 4; i++) {
		const next = normalizeText(s.replace(TITLE_WRAP_RE, ''));
		if (next === s) break;
		s = next;
	}
	s = normalizeText(s.replace(TITLE_TAIL_RE, ''));
	return normalizeText(s.replace(TITLE_TAIL_RE, ''));
}

/** 作者归一化：去「作者：」前缀、去包裹符、去空白 */
export function normalizeAuthor(author) {
	let s = normalizeText(cleanMetaText(author));
	if (!s) return '';
	s = normalizeText(s.replace(AUTHOR_PREFIX_RE, ''));
	for (let i = 0; i < 4; i++) {
		const next = normalizeText(s.replace(TITLE_WRAP_RE, ''));
		if (next === s) break;
		s = next;
	}
	// 注意：这里**不**剥离「著 / 作者」这类后缀。
	// 破坏性地改写作者名会误伤真名（「王著」→「王」）或把作者清空，
	// 而「天蚕土豆」与「天蚕土豆 著」的差异交给 authorsCompatible 处理——
	// 匹配层能识别它们是同一人，身份键本身保持忠实。
	return normalizeText(s);
}

/** 书源 id 归一化（去空白 + 小写） */
export function normalizeSourceId(sourceId) {
	return normalizeText(sourceId).toLowerCase();
}

/** 写入书籍记录前统一身份字段（保留其它字段） */
export function normalizeBookFields(book) {
	if (!book) return book;
	return {
		...book,
		title: normalizeTitle(book.title),
		author: normalizeAuthor(book.author),
		sourceId: normalizeSourceId(book.sourceId)
	};
}

/** 完整身份键：书名 + 作者 + 书源 */
export function bookIdentityKey(book) {
	return bookKeyOfParts(book?.title, book?.author, book?.sourceId);
}

/** 由三段原始值构造身份键 */
export function bookKeyOfParts(title, author, sourceId) {
	return [normalizeTitle(title), normalizeAuthor(author), normalizeSourceId(sourceId)].join(KEY_SEP);
}

/** 书名 + 书源（作者常缺失，作为高优先级退化匹配） */
export function bookTitleSourceKey(book) {
	return normalizeTitle(book?.title) + KEY_SEP + normalizeSourceId(book?.sourceId);
}

/** 书名 + 作者（忽略书源，用于识别「同名同作者的另一书源」） */
export function bookTitleAuthorKey(book) {
	return normalizeTitle(book?.title) + KEY_SEP + normalizeAuthor(book?.author);
}

/** 按「书名+作者」把书架记录聚类（同一本书的多个书源归为一组） */
export function groupBooksByIdentity(books) {
	const groups = new Map();
	for (const b of books || []) {
		if (!b) continue;
		const k = bookTitleAuthorKey(b);
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(b);
	}
	return groups;
}

/**
 * 两位作者的署名是否「兼容」（可视为同一人）。
 * 只有以下情况才算兼容，避免把「同名不同作者」的两本书误判成一本：
 *   - 任一侧为空（大量书源不返回作者，这是最常见的写法差异）；
 *   - 归一化后完全相同（已含「著」后缀、「作者：」前缀的收敛）；
 *   - 一方是另一方的前缀（如「天蚕土豆」vs「天蚕土豆 著」被截断的情况）。
 * 明确不同且互不包含时返回 false —— 调用方必须把它们当成两本书。
 */
export function authorsCompatible(a, b) {
	const na = normalizeAuthor(a);
	const nb = normalizeAuthor(b);
	if (!na || !nb) return true;
	if (na === nb) return true;
	return na.startsWith(nb) || nb.startsWith(na);
}

/**
 * 在已有记录中查找与 target 代表「同一本 + 同一书源」的记录。
 * 优先级：完整身份键 → 书名+书源（**且作者兼容**）。
 * 找不到返回 null，调用方据此决定是否新建（这是杜绝重复插入的关键闸门）。
 *
 * 「作者兼容」这一层是必要的：书名+书源的退化匹配能救回大量因作者缺失/
 * 写法差异而算不出同一个键的重复，但如果不校验作者，同书源下的
 * 「同名不同作者」两本书会被误合并 —— 那是丢书，比重复更严重。
 */
export function findSameBookRecord(target, books) {
	if (!target) return null;
	const list = books || [];
	const full = bookIdentityKey(target);
	const sameFull = list.filter((b) => b && bookIdentityKey(b) === full);
	if (sameFull.length) return pickMostRecent(sameFull);

	const tsKey = bookTitleSourceKey(target);
	const sameTs = list.filter((b) => b && bookTitleSourceKey(b) === tsKey
		&& authorsCompatible(target.author, b.author));
	if (sameTs.length) return pickMostRecent(sameTs);

	return null;
}

/**
 * 同一本书的全部来源记录（换源面板用）。
 * 先按「书名+作者」精确取，再补上作者写法不同但兼容的记录
 * （「天蚕土豆」vs「天蚕土豆 著」）——否则换源面板会漏掉那些来源。
 * 作者明确不同的同名书绝不并入（那是另一本书）。
 */
export function findSourceVariants(target, books) {
	const key = bookTitleAuthorKey(target);
	const title = normalizeTitle(target?.title);
	return (books || []).filter((b) => {
		if (!b) return false;
		if (bookTitleAuthorKey(b) === key) return true;
		// 作者写法差异：仅当书名一致且署名兼容时才追加
		return normalizeTitle(b.title) === title && authorsCompatible(target?.author, b.author);
	});
}

/** 同身份多条记录中挑最值得保留的：有阅读进度 > 有缓存 > 有目录 > 其余 */
export function pickMostRecent(list) {
	if (!list?.length) return null;
	const score = (b) =>
		(Number(b.lastReadAt) || 0) > 0 ? 4 :
		(Number(b.cachedChapters) || 0) > 0 ? 3 :
		(Number(b.totalChapters) || 0) > 0 ? 2 : 1;
	return [...list].sort((a, b) =>
		score(b) - score(a) ||
		(Number(b.lastReadAt) || 0) - (Number(a.lastReadAt) || 0) ||
		(Number(b.addedAt) || 0) - (Number(a.addedAt) || 0))[0];
}

/**
 * 去重：同身份 + 同书源的重复记录只保留一条。
 * 用于修复历史上已被同步逻辑复制出来的重复书籍记录。
 * @returns {{ books: Array, removed: Array, byKey: Map }}
 */
export function dedupeBooks(books) {
	const kept = new Map();
	const removed = [];
	for (const b of books || []) {
		if (!b) continue;
		const key = bookIdentityKey(b);
		if (!kept.has(key)) { kept.set(key, b); continue; }
		const prev = kept.get(key);
		const winner = pickMostRecent([prev, b]);
		const loser = winner === prev ? b : prev;
		kept.set(key, winner);
		removed.push(loser);
	}
	return { books: [...kept.values()], removed, byKey: kept };
}
