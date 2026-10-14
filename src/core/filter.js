/**
 * 章节内容清洗器 —— 复刻 so-novel ChapterFilter + ChapterFormatter
 * 流程: 不可见字符 → HTML实体 → 广告过滤 → 标题去重 → 空标签清理 → 段落格式化
 */

/** 清理不可见字符（控制字符 / 格式控制符 / PUA / BOM 等） */
export function cleanInvisibleChars(text) {
	if (!text) return '';
	// 对应 Java: [\p{C}\p{Cf}\p{Co}\p{Zl}\p{Zp}\u200B\uFEFF]
	return text
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
		.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
		.replace(/[\uE000-\uF8FF]/g, '')
		.replace(/[\u2028\u2029]/g, '');
}

/** 移除 HTML 实体引用（&nbsp; 等） */
export function removeHtmlEntities(text) {
	if (!text) return '';
	return text.replace(/&[^\s;]{1,12};/g, '');
}

/** 用 DOMParser 建一个 body 容器（完整壳包裹，兼容 linkedom 片段解析缺陷） */
function parseBody(html, DOMParserImpl) {
	const DP = DOMParserImpl || (typeof DOMParser !== 'undefined' ? DOMParser : null);
	if (!DP) throw new Error('DOMParser unavailable');
	const doc = new DP().parseFromString(
		`<!DOCTYPE html><html><head></head><body>${html}</body></html>`,
		'text/html'
	);
	return doc.body || doc.documentElement;
}

/** 删除匹配 CSS 选择器的标签 */
export function removeTags(html, cssQuery, DOMParserImpl) {
	if (!html || !cssQuery) return html;
	try {
		const body = parseBody(html, DOMParserImpl);
		body.querySelectorAll(cssQuery).forEach((el) => el.remove());
		return body.innerHTML;
	} catch {
		return html;
	}
}

/** 清除所有元素的属性 */
export function clearAllAttributes(html, DOMParserImpl) {
	try {
		const body = parseBody(html, DOMParserImpl);
		body.querySelectorAll('*').forEach((el) => {
			for (const attr of Array.from(el.attributes || [])) {
				el.removeAttribute(attr.name);
			}
		});
		return body.innerHTML;
	} catch {
		// 降级：正则去属性
		return html.replace(/<([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)\s*\/?>/g, (m, tag) =>
			tag.toLowerCase() === 'br' || tag.toLowerCase() === 'img' ? m : `<${tag}>`
		);
	}
}

/** 删除空标签（如 <p></p>） */
export function cleanEmptyTags(html, DOMParserImpl) {
	try {
		const body = parseBody(html, DOMParserImpl);
		let removed = true;
		let guard = 0;
		while (removed && guard++ < 10) {
			removed = false;
			body.querySelectorAll('p, div, span, li, em, strong, b, i, font, h1, h2, h3').forEach((el) => {
				if (!el.textContent.trim() && !el.querySelector('img')) {
					el.remove();
					removed = true;
				}
			});
		}
		return body.innerHTML;
	} catch {
		return html;
	}
}

/**
 * 正文格式化 → 统一为 <p>...</p> 序列
 * @param {string} content HTML 内容
 * @param {object} chapterRule { paragraphTagClosed, paragraphTag }
 */
export function formatParagraphs(content, chapterRule, DOMParserImpl) {
	let html = clearAllAttributes(content, DOMParserImpl);

	const closed = chapterRule?.paragraphTagClosed;
	const tagPattern = chapterRule?.paragraphTag || '</p>\\s*<p>';

	if (closed) {
		// <tag>段落</tag> → <p>段落</p>（非 p 标签）
		html = html.replace(/<(?!p\b|\/p\b)([a-zA-Z][\w-]*)[^>]*>([\s\S]*?)<\/\1>/g, '<p>$2</p>');
		return html;
	}

	// 按分隔符切分 → 每段 <p>
	let parts;
	try {
		parts = html.split(new RegExp(tagPattern));
	} catch {
		parts = html.split(/<br\s*\/?>+/i);
	}
	const sb = [];
	for (let line of parts) {
		line = line.trim();
		if (!line) continue;
		sb.push(`<p>${line}</p>`);
	}
	return sb.join('');
}

/**
 * 完整清洗链（对应 ChapterRenderer.process 的 txt/epub 输出路径）
 * @returns {string} 清洗后的 HTML（<p> 序列）
 */
export function cleanChapterContent(chapter, rule, DOMParserImpl) {
	let content = chapter.content || '';
	const title = chapter.title || '';

	// 1. 不可见字符
	content = cleanInvisibleChars(content);
	// 2. HTML 实体
	content = removeHtmlEntities(content);
	// 3. 广告过滤
	if (rule?.filterTxt) {
		try {
			content = content.replace(new RegExp(rule.filterTxt, 'g'), '');
		} catch { /* 无效正则跳过 */ }
	}
	if (rule?.filterTag) {
		content = removeTags(content, rule.filterTag, DOMParserImpl);
	}
	// 4. 正文开头重复标题
	if (title) {
		const escaped = escapeRegExp(title);
		const cleaned = escapeRegExp(title.replace(/\s+/g, ''));
		try {
			const re = new RegExp(`^(\\s|<[^>]+>)*(${escaped}|${cleaned})`);
			content = content.replace(re, '$1');
		} catch { /* ignore */ }
	}
	// 5. 空标签
	content = cleanEmptyTags(content, DOMParserImpl);
	// 6. 段落格式化
	content = formatParagraphs(content, rule, DOMParserImpl);

	return content;
}

/** HTML → 纯段落数组（App 渲染用） */
export function htmlToParagraphs(html, DOMParserImpl) {
	try {
		const body = parseBody(html, DOMParserImpl);
		const paragraphs = [];
		const walk = (node) => {
			for (const child of node.childNodes) {
				if (child.nodeType === 3) {
					const t = child.nodeValue.replace(/\s+/g, ' ').trim();
					if (t) {
						if (paragraphs.length && !isBlockContext(child.parentNode)) {
							// 内联文本并入上一段
							paragraphs[paragraphs.length - 1] += t;
						} else {
							paragraphs.push(t);
						}
					}
				} else if (child.nodeType === 1) {
					const tag = (child.tagName || '').toLowerCase();
					if (tag === 'br') {
						paragraphs.push('\n');
						continue;
					}
					if (tag === 'script' || tag === 'style') continue;
					const text = child.textContent.replace(/\s+/g, ' ').trim();
					if (text) paragraphs.push(text);
				}
			}
		};
		walk(body);
		return paragraphs.map((p) => p.replace(/^\n+|\n+$/g, '')).filter((p) => p && p !== '\n');
	} catch {
		// 降级：按 <br> 与 </p> 拆
		return String(html || '')
			.replace(/<br\s*\/?>+/gi, '\n')
			.replace(/<\/p>/gi, '\n')
			.split('\n')
			.map((s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
			.filter(Boolean);
	}
}

function isBlockContext(node) {
	if (!node || !node.tagName) return true;
	const t = node.tagName.toLowerCase();
	return ['p', 'div', 'li', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'].includes(t);
}

function escapeRegExp(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 标题清洗：1.章节名 → 第1章 章节名（复刻 TITLE_NUMBER_PATTERN） */
export function cleanChapterTitle(title) {
	if (!title) return '';
	const m = String(title).match(/^(\d+)\s*\.\s*(.+)$/);
	if (m) return `第${m[1]}章 ${m[2]}`;
	return title;
}
