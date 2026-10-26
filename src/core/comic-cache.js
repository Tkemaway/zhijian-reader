/**
 * 漫画章节缓存 —— 解析图片地址 → 并发下载 → 写回章节表
 *
 * 阅读器和「整本缓存」共用这一条链路，避免两处各写一套下载逻辑。
 */
import { requestBytes } from './http.js';
import { fetchComicChapter, refererHeaders } from './engine.js';
import { getChapter, saveChapters } from '../store/db.js';

const CONCURRENCY = 4;

function mimeOfUrl(url) {
	const m = String(url || '').match(/\.([a-z0-9]+)(?:\?|#|$)/i);
	const ext = (m?.[1] || 'jpg').toLowerCase();
	return ext === 'png' ? 'image/png'
		: ext === 'webp' ? 'image/webp'
			: ext === 'gif' ? 'image/gif'
				: ext === 'avif' ? 'image/avif'
					: 'image/jpeg';
}

/** 有些站点对盗链/未登录返回 HTML 页面，不能当图片存下来 */
function looksLikeHtml(bytes) {
	if (!bytes?.length) return false;
	let i = 0;
	while (i < Math.min(bytes.length, 12) && [0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf].includes(bytes[i])) i++;
	return bytes[i] === 0x3c; // '<'
}

async function downloadImages(urls, headers, { signal, onProgress } = {}) {
	const out = new Array(urls.length);
	const errors = [];
	let cursor = 0;
	let done = 0;

	const worker = async () => {
		for (;;) {
			if (signal?.aborted) return;
			const i = cursor++;
			if (i >= urls.length) return;
			try {
				const res = await requestBytes(urls[i], { headers, timeout: 30000, signal });
				if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
				if (!res.bytes?.length) throw new Error('空文件');
				if (looksLikeHtml(res.bytes)) throw new Error('返回的是网页（可能需要登录或有防盗链）');
				const ct = String(res.contentType || '').split(';')[0].trim();
				out[i] = {
					mime: ct.startsWith('image/') ? ct : mimeOfUrl(urls[i]),
					bytes: res.bytes
				};
			} catch (e) {
				if (signal?.aborted) return;
				errors.push(e.message || String(e));
			}
			done++;
			onProgress?.(done, urls.length);
		}
	};

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
	if (signal?.aborted) throw new Error('已取消');
	const images = out.filter(Boolean);
	if (!images.length) throw new Error(errors[0] || '图片下载失败');
	return images;
}

/**
 * 取一话的图片（本地缓存优先，缺则联网）
 * @param {object} book
 * @param {object} source 书源（本地书可为 null）
 * @param {number} idx
 * @param {{title?:string,url?:string}} tocItem
 * @param {{signal?:AbortSignal, onProgress?:(done:number,total:number)=>void, onStage?:(text:string)=>void}} opts
 * @returns {Promise<Array<{mime:string, bytes:Uint8Array}>>}
 */
export async function getComicChapterImages(book, source, idx, tocItem, { signal, onProgress, onStage } = {}) {
	const cached = await getChapter(book.id, idx);
	if (cached?.images?.length) return cached.images;

	if (book.sourceId === 'local') {
		throw new Error('这一话的图片丢失了，请重新导入文件');
	}
	if (!source) throw new Error('书源缺失，无法获取在线漫画');

	let urls = cached?.imageUrls || [];
	if (!urls.length) {
		const chapterUrl = tocItem?.url;
		if (!chapterUrl) throw new Error('章节地址缺失');
		onStage?.('正在解析图片…');
		const parsed = await fetchComicChapter(source, chapterUrl, DOMParser, { signal });
		if (parsed.error) throw new Error(parsed.error);
		urls = parsed.imageUrls || [];
		if (!urls.length) throw new Error('这一话没有找到图片');
		// 先记住地址：即使下载中途退出，下次也不用重新解析
		await saveChapters(book.id, [{
			idx,
			title: tocItem?.title || '',
			imageUrls: urls,
			url: chapterUrl
		}]);
	}

	onStage?.(`正在下载 0 / ${urls.length} 页…`);
	const images = await downloadImages(urls, refererHeaders(source), {
		signal,
		onProgress: (done, total) => onStage?.(`正在下载 ${done} / ${total} 页…`)
	});

	await saveChapters(book.id, [{
		idx,
		title: tocItem?.title || '',
		images,
		url: tocItem?.url || ''
	}]);
	return images;
}
