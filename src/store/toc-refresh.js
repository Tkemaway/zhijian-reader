/**
 * 目录刷新 —— 检查书源是否更新了新章节
 *
 * 安全策略：只有"新目录是旧目录的尾部追加"（前缀完全一致）时才替换本地目录——
 * 避免书源目录重排/换源导致阅读位置错乱。无新章节或无法校验时不做任何改动。
 */
import sources from '../core/sources.js';
import { fetchToc } from '../core/engine.js';
import { getToc, saveToc, updateBook } from './db.js';

/**
 * 检查并更新某本书的目录
 * @param {object} book 书籍记录（需要 id / sourceId / tocUrl / bookUrl）
 * @returns {Promise<{added: number, total: number} | null>}
 *   null = 无法检查（无目录/无书源）；{added:0} = 检查过，无新章节
 */
export async function refreshBookToc(book) {
	if (!book || !(book.tocUrl || book.bookUrl) || typeof DOMParser === 'undefined') return null;
	const source = sources.find((s) => s.id === book.sourceId);
	if (!source) return null;
	const oldToc = (await getToc(book.id)) || [];
	if (!oldToc.length) return null; // 本地还没有目录（走首拉逻辑）

	const fresh = await fetchToc(source, book, DOMParser);
	if (!fresh?.chapters?.length) return null;

	if (fresh.chapters.length <= oldToc.length) return { added: 0, total: oldToc.length };

	// 严格前缀校验：仅允许"尾部追加新章节"
	const prefixOk = oldToc.every((c, i) => fresh.chapters[i]?.url === c.url);
	if (!prefixOk) return { added: 0, total: oldToc.length };

	await saveToc(book.id, fresh.chapters);
	await updateBook(book.id, {
		totalChapters: fresh.chapters.length,
		tocUrl: fresh.tocUrl || book.tocUrl
	});
	// 同步内存中的书籍对象（供调用方立即显示）
	book.totalChapters = fresh.chapters.length;
	if (fresh.tocUrl) book.tocUrl = fresh.tocUrl;
	return { added: fresh.chapters.length - oldToc.length, total: fresh.chapters.length };
}
