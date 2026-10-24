/**
 * 元数据文本清洗 —— 书名 / 作者
 *
 * 电子书（尤其是 Z-Library 等来源的 EPUB）里常见：
 *   - HTML 实体（`&amp;#183;` 这种被双重转义的也很多）→ 应还原成 `·`
 *   - 零宽字符 / 方向控制符 / BOM → 会显示成"乱码方块"或吞掉字符
 *   - 连续空白、全角空格
 * 这些都会直接从书架上透出来（例如「龙族Ⅴ&#183;悼亡者的归来」）。
 */

const ENTITIES = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
	middot: '·', bull: '•', hellip: '…', mdash: '—', ndash: '–',
	ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×',
	laquo: '«', raquo: '»', deg: '°', copy: '©', reg: '®'
};

/**
 * 解码 HTML 实体（最多 3 轮，处理 `&amp;#183;` 这类多重转义）
 * @param {string} input
 * @returns {string}
 */
export function decodeEntitiesDeep(input) {
	let s = String(input ?? '');
	for (let pass = 0; pass < 3; pass++) {
		const next = s
			.replace(/&#x([0-9a-f]+);/gi, (m, h) => {
				try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; }
			})
			.replace(/&#(\d+);/g, (m, d) => {
				try { return String.fromCodePoint(Number(d)); } catch { return m; }
			})
			.replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
		if (next === s) break;
		s = next;
	}
	return s;
}

/**
 * 书名/作者清洗：解实体 → 去控制符/零宽 → 压缩空白
 * 不做"去符号"的破坏性处理（书名里的 ·、·、Ⅴ 都是有意义的）
 */
export function cleanMetaText(input) {
	let s = decodeEntitiesDeep(input);
	// 控制字符、零宽字符、方向控制符、BOM
	s = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '');
	// 连续空白（含全角空格）压成一个
	s = s.replace(/[\s\u3000]+/g, ' ').trim();
	return s;
}

/**
 * 书名是否"看起来不完整"（用于导入时给出提示，不做强制修改）：
 * 只有实体残留、控制符、或全是符号时返回 true
 */
export function looksUnclean(input) {
	const raw = String(input ?? '');
	if (!raw) return false;
	if (/&#?\w+;/.test(raw)) return true;
	if (/[\u0000-\u001f\u200b-\u200f\ufeff]/.test(raw)) return true;
	return false;
}
