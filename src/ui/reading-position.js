// Text offsets survive font, viewport and reading-mode changes.
function characterRect(paragraph, offset) {
	const text = paragraph.firstChild;
	if (!text?.length) return paragraph.getBoundingClientRect();
	const range = document.createRange();
	const start = Math.max(0, Math.min(offset, text.length - 1));
	range.setStart(text, start);
	range.setEnd(text, start + 1);
	return range.getBoundingClientRect();
}

export function capturePosition({ body, block, chapterIdx, isPaged, page = 0 }) {
	if (!body || !block) return null;
	const bounds = body.getBoundingClientRect();
	const line = bounds.top + body.clientHeight * (isPaged ? 0 : 0.35);
	const paragraphs = [...block.querySelectorAll('p')];
	let index = paragraphs.findIndex((p) => [...p.getClientRects()].some((r) =>
		isPaged ? r.right > bounds.left && r.left < bounds.right : r.bottom > line));
	if (index < 0) index = Math.max(0, paragraphs.length - 1);
	const paragraph = paragraphs[index];
	if (!paragraph) return { chapterIdx, paragraphIdx: 0, charOffset: 0, atStart: true };
	const title = block.querySelector('.chapter-title')?.getBoundingClientRect();
	if ((isPaged && page === 0) || (!isPaged && title && title.bottom > line)) {
		return { chapterIdx, paragraphIdx: 0, charOffset: 0, atStart: true };
	}
	let low = 0;
	let high = paragraph.firstChild?.length || 0;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const rect = characterRect(paragraph, mid);
		const before = isPaged ? rect.right <= bounds.left : rect.bottom <= line;
		if (before) low = mid + 1;
		else high = mid;
	}
	return { chapterIdx, paragraphIdx: index, charOffset: low, viewportRatio: isPaged ? 0 : 0.35 };
}

export function locatePosition(anchor, { body, block, isPaged, step = 1 }) {
	if (!anchor || !body || !block) return 0;
	if (anchor.atStart) return 0;
	const paragraphs = block.querySelectorAll('p');
	const paragraph = paragraphs[Math.max(0, Math.min(paragraphs.length - 1, anchor.paragraphIdx || 0))];
	if (!paragraph) return 0;
	// Older builds stored a paragraph-height ratio. Keep those positions readable.
	const offset = Number.isInteger(anchor.charOffset) ? anchor.charOffset
		: Math.round((paragraph.firstChild?.length || 0) * (anchor.paragraphOffset || 0));
	const rect = characterRect(paragraph, offset);
	const bounds = body.getBoundingClientRect();
	if (isPaged) return Math.max(0, Math.floor((rect.left - bounds.left + body.scrollLeft) / step));
	return Math.max(0, rect.top - bounds.top + body.scrollTop - body.clientHeight * (anchor.viewportRatio ?? 0.35));
}
