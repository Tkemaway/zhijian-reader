/**
 * 统一书源引擎 —— 调度搜索 / 目录 / 章节
 * 同时支持 so-novel 规则与 legado 规则的书源
 */
import * as sonovel from './source-sonovel.js';
import * as legado from './source-legado.js';
import { requestText, sleep, randomInterval, tryFixMojibake } from './http.js';
import { cleanChapterContent, htmlToParagraphs, cleanChapterTitle, cleanInvisibleChars } from './filter.js';
import { extractFanqieId, parseFanqieToc, parseFanqieChapter, fanqieHeaders } from './fanqie.js';
import { fqAppSearch, fqAppToc, fqAppChapter } from './fanqie-app.js';

/** 根据书源类型选择适配器 */
export function getAdapter(source) {
	return source?.type === 'legado' ? legado : sonovel;
}

/** 带重试的请求（默认重试 2 次） */
export async function robustRequest(url, opts = {}, retries = 2) {
	let lastErr;
	for (let i = 0; i <= retries; i++) {
		opts.signal?.throwIfAborted();
		try {
			return await requestText(url, opts);
		} catch (e) {
			if (opts.signal?.aborted || e.name === 'AbortError') throw e;
			lastErr = e;
			if (i < retries) await sleep(800 * (i + 1));
		}
	}
	throw lastErr;
}

/**
 * 搜索单个书源
 * @returns {Promise<{results: Array, error: string|null}>}
 */
export async function searchSource(source, keyword, DOMParserImpl) {
	// 番茄源不参与书名搜索（无公开搜索接口），通过粘贴链接/ID 入架
	if (source.type === 'fanqie') return { results: [], error: null };
	// 番茄 App 协议源：直连官方搜索接口
	if (source.type === 'fanqie-app') {
		try {
			const results = (await fqAppSearch(keyword)).map((r) => ({
				...r,
				sourceId: source.id,
				sourceName: source.name
			}));
			return { results, error: null };
		} catch (e) {
			return { results: [], error: e.message || String(e) };
		}
	}
	const adapter = getAdapter(source);
	try {
		const req = adapter.buildSearchRequest(source, keyword);
		if (!req) return { results: [], error: '该书源不支持搜索' };

		const { text, finalUrl } = await robustRequest(req.url, {
			method: req.method,
			body: req.body,
			headers: req.headers,
			charset: req.charset
		});

		const results = adapter.parseSearchResults(text, finalUrl, source, DOMParserImpl, keyword) || [];
		return { results, error: null };
	} catch (e) {
		return { results: [], error: e.message || String(e) };
	}
}

/**
 * 聚合搜索多个书源（并发 + 逐源回调）
 * @param {Array} sources
 * @param {string} keyword
 * @param {object} opts { concurrency, onSourceResult(source, results, error), onSourceStart(source) }
 */
export async function searchAll(sources, keyword, opts = {}) {
	const { concurrency = 4, onSourceResult, onSourceStart, DOMParserImpl } = opts;
	const enabled = sources.filter((s) => s.enabled !== false);
	const queue = [...enabled];
	const allResults = [];

	async function worker() {
		while (queue.length) {
			const source = queue.shift();
			onSourceStart?.(source);
			const { results, error } = await searchSource(source, keyword, DOMParserImpl);
			allResults.push(...results);
			onSourceResult?.(source, results, error);
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
	await Promise.all(workers);
	return allResults;
}

/**
 * 获取书籍目录
 * @param {object} source 书源
 * @param {object} book { bookUrl, tocUrl? } bookUrl=详情页（搜索结果的 url）
 * @returns {Promise<{chapters: Array<{title,url}>, tocUrl: string, error: string|null}>}
 */
export async function fetchToc(source, book, DOMParserImpl) {
	// 番茄 App 协议源：直连官方目录接口
	if (source.type === 'fanqie-app') {
		const bookId = extractFanqieId(book.bookUrl || book.tocUrl || '');
		if (!bookId) throw new Error('无法识别番茄书籍链接');
		const toc = await fqAppToc(bookId);
		return { chapters: toc.chapters, tocUrl: `https://fanqienovel.com/page/${bookId}` };
	}
	// 番茄小说：直连官方页面解析（试读源）
	if (source.type === 'fanqie') {
		const bookId = extractFanqieId(book.bookUrl || book.tocUrl || '');
		if (!bookId) throw new Error('无法识别番茄书籍链接（请粘贴 fanqienovel.com/page/{id} 或书籍 ID）');
		const url = `https://fanqienovel.com/page/${bookId}`;
		const resp = await robustRequest(url, { headers: fanqieHeaders() });
		const parsed = parseFanqieToc(resp.text);
		if (!parsed.chapters.length) throw new Error('未解析到章节列表（番茄页面结构可能已变化）');
		return {
			chapters: parsed.chapters.map((c) => ({ title: c.title, url: c.url, locked: !!c.locked })),
			tocUrl: url,
			bookTitle: parsed.title,
			bookAuthor: parsed.author
		};
	}
	const adapter = getAdapter(source);
	try {
		let tocUrl = book.tocUrl || '';
		let bookHtml = '';
		let bookFinalUrl = book.bookUrl;

		// 1. 确定目录页 URL
		if (source.type === 'legado') {
			if (!tocUrl && source.ruleBookInfo?.tocUrl) {
				const resp = await robustRequest(book.bookUrl, { headers: refererHeaders(source) });
				bookHtml = resp.text;
				bookFinalUrl = resp.finalUrl;
				const info = adapter.parseBookInfo(bookHtml, bookFinalUrl, source, DOMParserImpl) || {};
				tocUrl = info.tocUrl || bookFinalUrl;
			}
			tocUrl = tocUrl || bookFinalUrl;
		} else {
			// so-novel: toc.url 模板（%s ← 从 book.url 正则提取 id）
			const tocRule = source.rule?.toc || {};
			const bookRule = source.rule?.book || {};
			if (tocRule.url) {
				let id = null;
				if (bookRule.url) {
					const pattern = String(bookRule.url).split('@js:')[0].trim();
					try {
						const m = new URL(bookRule.url).origin ? bookFinalUrl.match(new RegExp(pattern)) : null;
						id = m ? m[1] : null;
					} catch {
						try {
							const m = bookFinalUrl.match(new RegExp(pattern));
							id = m ? m[1] : null;
						} catch { /* ignore */ }
					}
				}
				tocUrl = id != null ? String(tocRule.url).replace('%s', id) : String(tocRule.url);
			}
			tocUrl = tocUrl || bookFinalUrl;
		}

		// 2. 抓取目录页（如果与详情页不同）
		let tocHtml = bookHtml;
		let tocFinalUrl = tocUrl;
		if (tocUrl !== bookFinalUrl || !tocHtml) {
			const resp = await robustRequest(tocUrl, { headers: refererHeaders(source) });
			tocHtml = resp.text;
			tocFinalUrl = resp.finalUrl;
		}

		// 3. 解析章节
		let chapters = adapter.parseToc(tocHtml, tocFinalUrl, source, DOMParserImpl) || [];

		// 4. 目录分页
		if (!chapters.length || (source.rule?.toc?.nextPage || source.ruleToc?.nextTocUrl)) {
			try {
				const nextPages = adapter.parseTocNextPages
					? adapter.parseTocNextPages(tocHtml, tocFinalUrl, source, DOMParserImpl) || []
					: [];
				for (const pageUrl of nextPages.slice(0, 30)) {
					if (!pageUrl || pageUrl === tocFinalUrl) continue;
					await sleep(randomInterval(300, 800));
					const resp = await robustRequest(pageUrl, { headers: refererHeaders(source) });
					const more = adapter.parseToc(resp.text, resp.finalUrl, source, DOMParserImpl) || [];
					chapters.push(...more);
				}
			} catch { /* 分页失败不影响已有章节 */ }
		}

		// 去重（按 url）
		const seen = new Set();
		chapters = chapters.filter((c) => {
			if (!c.url || seen.has(c.url)) return false;
			seen.add(c.url);
			return true;
		});

		return { chapters, tocUrl: tocFinalUrl, error: null };
	} catch (e) {
		return { chapters: [], tocUrl: '', error: e.message || String(e) };
	}
}

/**
 * 获取章节内容（含分页合并 + 清洗）
 * @returns {Promise<{title, paragraphs, html, error}>}
 */
export async function fetchChapter(source, chapterUrl, DOMParserImpl, chapterTitle = '', { signal } = {}) {
	if (!source) return { title: chapterTitle, paragraphs: [], html: '', error: '书源缺失（本地导入的书应在导入设备上阅读）' };
	// 番茄 App 协议源：直连官方接口 + CM 通道解密
	if (source.type === 'fanqie-app') {
		try {
			const paragraphs = await fqAppChapter(chapterUrl);
			return { title: chapterTitle, paragraphs, html: '', error: null };
		} catch (e) {
			return { title: chapterTitle, paragraphs: [], html: '', error: e.message || '章节获取失败' };
		}
	}
	// 番茄小说：解析官方章节页 + 字符解密（试读章节给出明确提示）
	if (source.type === 'fanqie') {
		if (!chapterUrl) return { title: chapterTitle, paragraphs: [], html: '', error: '章节地址缺失' };
		const resp = await robustRequest(chapterUrl, { headers: fanqieHeaders(), signal });
		const parsed = parseFanqieChapter(resp.text);
		if (parsed.preview) {
			return {
				title: parsed.title || chapterTitle,
				paragraphs: [],
				html: '',
				error: '此章仅含番茄官方试读片段——完整内容请在番茄 App 或支持 SVIP 的官方渠道阅读'
			};
		}
		if (!parsed.paragraphs.length) {
			return { title: parsed.title || chapterTitle, paragraphs: [], html: resp.text, error: '未解析到正文内容（页面结构可能已变化）' };
		}
		return { title: parsed.title || chapterTitle, paragraphs: parsed.paragraphs, html: resp.text, error: null };
	}
	const adapter = getAdapter(source);
	try {
		let url = chapterUrl;
		let html = '';
		let title = chapterTitle;
		let pages = 0;
		const contentParts = [];

		while (url && pages < 15) {
			signal?.throwIfAborted();
			const resp = await robustRequest(url, { headers: refererHeaders(source), signal });
			const parsed = adapter.parseChapter(resp.text, resp.finalUrl, source, DOMParserImpl) || {};
			if (parsed.title && !title) title = parsed.title;
			contentParts.push(parsed.contentHtml || '');

			// 下一页
			const nextUrl = adapter.parseChapterNextPage
				? adapter.parseChapterNextPage(resp.text, resp.finalUrl, source, DOMParserImpl)
				: '';
			if (!nextUrl || nextUrl === url) break;
			url = nextUrl;
			pages++;
			await sleep(randomInterval(200, 500));
		}

		let contentHtml = contentParts.join('');
		if (!contentHtml.trim()) {
			return { title, paragraphs: [], html: '', error: '正文内容为空' };
		}

		// 清洗（so-novel 规则有完整清洗参数；legado 内容已过 replaceRegex）
		const chapterRule = source.rule?.chapter || {};
		if (source.type !== 'legado') {
			contentHtml = cleanChapterContent({ title, content: contentHtml }, chapterRule, DOMParserImpl);
		} else {
			contentHtml = sanitizeLegadoContent(contentHtml, DOMParserImpl);
		}

		const paragraphs = htmlToParagraphs(contentHtml, DOMParserImpl)
			// 段落级 mojibake 修复（服务端双重编码的乱码正文）
			.map((p) => tryFixMojibake(p))
			// 超长不可断串（URL、长编号）插入零宽断点：
			// 防止 CSS 多列布局的列宽被 min-content 撑开（导致分页错位/文字被切）
			.map((p) => breakLongTokens(p))
			.filter((p) => !isAdParagraph(p));
		return { title: cleanChapterTitle(tryFixMojibake(title)), paragraphs, html: contentHtml, error: null };
	} catch (e) {
		return { title: chapterTitle, paragraphs: [], html: '', error: e.message || String(e) };
	}
}

/**
 * 超长不可断串插入零宽断点（每 16 字符一处）
 * 场景：正文里的 URL / 长编号等连续 32+ 的 ASCII 串，会让
 * CSS 多列布局（分页阅读）的列宽被 min-content 撑开 → 翻页错位
 */
function breakLongTokens(text) {
	if (!text || text.length < 32) return text;
	return text.replace(/[A-Za-z0-9_\-./:?&=%@#+~]{32,}/g, (m) => {
		let out = '';
		for (let i = 0; i < m.length; i += 16) out += m.slice(i, i + 16) + '\u200b';
		return out;
	});
}

/** 常见站点广告段落（仅短行匹配，避免误伤正文） */
const AD_PARAGRAPH_PATTERNS = [
	/^最新网址[:：]/,
	/^请(记住|收藏)(本书|本站)/,
	/^记住(本书|本站)/,
	/^(天才)?一[秒秒]记住/,
	/^手机(用户)?请(浏览|访问|阅读)/,
	/^（?本章完）?$/,
	/^喜欢.{0,12}请大家收藏/,
	/^加入书签/,
	/^推荐票/,
	/^[\w.]+[。.]?(最快更新|全文字更新|无弹窗)/
];

function isAdParagraph(p) {
	const s = (p || '').trim();
	if (!s || s.length > 48) return false;
	return AD_PARAGRAPH_PATTERNS.some((re) => re.test(s));
}

/** legado 内容基础清洗（去 script/style/不可见字符） */
function sanitizeLegadoContent(html, DOMParserImpl) {
	let s = cleanInvisibleChars(html);
	s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
	s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
	return s;
}

export function refererHeaders(source) {
	const headers = {};
	try {
		const u = new URL(source.url);
		headers.Referer = `${u.protocol}//${u.host}`;
	} catch { /* ignore */ }
	return headers;
}

// ============================================================
//  漫画书源
// ============================================================

/** 站点装饰图（logo/广告/图标/占位图）——不要当成漫画页 */
const BAD_IMAGE_RE = /(logo|banner|advert|ads?[-_/]|ad[-_/]|icon|avatar|qrcode|qr[-_]?code|placeholder|loading|lazy[-_]?load|spacer|blank|pixel|captcha|share|btn|button|sprite)/i;

/** 从 <img> 上挑出真实地址（兼容懒加载属性） */
function pickImageUrl(img, baseUrl) {
	const attrs = [
		'data-original', 'data-src', 'data-lazy-src', 'data-echo', 'data-url',
		'data-original-src', 'data-lazy', 'data-actualsrc', 'src'
	];
	let raw = '';
	for (const a of attrs) {
		const v = (img.getAttribute?.(a) || '').trim();
		if (!v) continue;
		// 常见的 1px 占位 gif / svg 跳过，继续找下一个属性
		if (/^data:image\/(gif|svg)/i.test(v) && v.length < 400) continue;
		raw = v;
		break;
	}
	if (!raw) {
		const srcset = (img.getAttribute?.('srcset') || '').trim();
		if (srcset) raw = srcset.split(',')[0].trim().split(/\s+/)[0];
	}
	if (!raw) return '';
	if (/^data:image\//i.test(raw)) return raw; // 内嵌 base64，可直接给 <img>
	if (/^(blob|about|javascript):/i.test(raw)) return '';
	try {
		return new URL(raw, baseUrl).href;
	} catch {
		return '';
	}
}

/** 判断一个地址像不像漫画页 */
function isUsableImage(url, img, source) {
	if (!url) return false;
	if (/^data:image\//i.test(url)) return true;
	if (BAD_IMAGE_RE.test(url)) return false;
	// 明确是图片扩展名 → 通过；没有扩展名的 CDN 地址也放行（只排除明显是网页的）
	if (/\.(html?|php|jsp|aspx?)(?:$|[?#])/i.test(url)) return false;
	if (img) {
		const w = parseInt(img.getAttribute?.('width') || '', 10);
		const h = parseInt(img.getAttribute?.('height') || '', 10);
		if ((w && w <= 60) || (h && h <= 60)) return false;
		const alt = (img.getAttribute?.('alt') || '') + (img.getAttribute?.('class') || '');
		if (BAD_IMAGE_RE.test(alt)) return false;
	}
	// 书源可以自定义白/黑名单
	if (source?.comicInclude) {
		try { if (!new RegExp(source.comicInclude, 'i').test(url)) return false; } catch { /* ignore */ }
	}
	if (source?.comicExclude) {
		try { if (new RegExp(source.comicExclude, 'i').test(url)) return false; } catch { /* ignore */ }
	}
	return true;
}

/** 从一段 HTML / 文档里按顺序收集图片地址 */
export function collectComicImages(htmlOrDoc, baseUrl, source, DOMParserImpl) {
	let doc = htmlOrDoc;
	if (typeof htmlOrDoc === 'string') {
		doc = new DOMParserImpl().parseFromString(htmlOrDoc, 'text/html');
	}
	if (!doc) return [];
	const urls = [];
	const seen = new Set();
	for (const img of doc.querySelectorAll('img')) {
		const url = pickImageUrl(img, baseUrl);
		if (!url || seen.has(url) || !isUsableImage(url, img, source)) continue;
		seen.add(url);
		urls.push(url);
	}
	return urls;
}

/**
 * 获取漫画一话的图片地址列表
 * 优先用书源的内容规则圈定范围（避免把页面上的 logo / 推荐位当成漫画页）
 */
export async function fetchComicChapter(source, chapterUrl, DOMParserImpl, { signal } = {}) {
	if (!source) return { imageUrls: [], error: '书源缺失' };
	if (!chapterUrl) return { imageUrls: [], error: '章节地址缺失' };
	try {
		const resp = await robustRequest(chapterUrl, { headers: refererHeaders(source), signal });
		const parser = new DOMParserImpl();
		let urls = [];

		// 1) 先按内容规则取正文 HTML，再从中找图
		try {
			const parsed = getAdapter(source).parseChapter(resp.text, resp.finalUrl, source, DOMParserImpl);
			if (parsed?.contentHtml) {
				urls = collectComicImages(parsed.contentHtml, resp.finalUrl, source, DOMParserImpl);
			}
		} catch { /* 规则不匹配就走整页 */ }

		// 2) 规则没圈到图 → 整页扫（再过滤装饰图）
		if (!urls.length) {
			urls = collectComicImages(resp.text, resp.finalUrl, source, DOMParserImpl);
		}

		if (!urls.length) {
			return { imageUrls: [], error: '这一话没有解析到图片（该来源可能靠脚本加载图片）', finalUrl: resp.finalUrl };
		}
		return { imageUrls: urls, error: null, finalUrl: resp.finalUrl };
	} catch (e) {
		return { imageUrls: [], error: e.message || '图片地址获取失败' };
	}
}
