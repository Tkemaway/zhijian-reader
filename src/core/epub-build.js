/**
 * 用已缓存的章节反向打包成 EPUB
 *
 * 用途：v3.0 之前导入的本地书只存了"解析后的章节"，没有保留原文件，
 * 跨设备同步时无从上传。这里把它们重新封装成标准 EPUB（2.0/3.0 兼容），
 * 另一台设备下载后仍用同一个解析器导入，章节结构与原来完全一致。
 */
import { zipSync, strToU8 } from 'fflate';

const escapeXml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
	'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
}[c]));

/**
 * @param {{ title?: string, author?: string, id?: string, chapters: Array<{title: string, paragraphs: string[]}> }} input
 * @returns {Uint8Array} epub 字节
 */
export function buildEpubFromChapters({ title, author, id, chapters }) {
	const list = (chapters || []).filter((c) => c && (c.paragraphs || []).length);
	if (!list.length) throw new Error('没有可打包的章节');
	const bookTitle = title || '未命名书籍';
	const bookAuthor = author || '';
	const uid = `urn:zhijian:${id || Date.now()}`;

	const files = {};
	files.mimetype = strToU8('application/epub+zip');
	files['META-INF/container.xml'] = strToU8(
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
		'<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
		'</container>'
	);

	const manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
	const spine = [];
	const navItems = [];

	list.forEach((ch, i) => {
		const cid = `c${i}`;
		const chTitle = ch.title || `第 ${i + 1} 章`;
		manifest.push(`<item id="${cid}" href="${cid}.xhtml" media-type="application/xhtml+xml"/>`);
		spine.push(`<itemref idref="${cid}"/>`);
		navItems.push(`<li><a href="${cid}.xhtml">${escapeXml(chTitle)}</a></li>`);
		const body = (ch.paragraphs || [])
			.map((p) => `<p>${escapeXml(p)}</p>`)
			.join('\n');
		files[`OEBPS/${cid}.xhtml`] = strToU8(
			'<?xml version="1.0" encoding="utf-8"?>\n' +
			'<!DOCTYPE html>\n' +
			'<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>' +
			`<title>${escapeXml(chTitle)}</title></head>` +
			`<body><h2>${escapeXml(chTitle)}</h2>\n${body}\n</body></html>`
		);
	});

	files['OEBPS/nav.xhtml'] = strToU8(
		'<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
		'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
		`<head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${navItems.join('')}</ol></nav></body></html>`
	);

	files['OEBPS/content.opf'] = strToU8(
		'<?xml version="1.0" encoding="utf-8"?>\n' +
		'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">' +
		'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
		`<dc:identifier id="bookid">${escapeXml(uid)}</dc:identifier>` +
		`<dc:title>${escapeXml(bookTitle)}</dc:title>` +
		`<dc:creator>${escapeXml(bookAuthor)}</dc:creator>` +
		'<dc:language>zh-CN</dc:language>' +
		'</metadata>' +
		`<manifest>${manifest.join('')}</manifest>` +
		`<spine>${spine.join('')}</spine>` +
		'</package>'
	);

	return zipSync(files, { level: 6 });
}

/** 书名 → 安全的文件名 */
export function epubFileName(title) {
	const base = String(title || 'book').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'book';
	return `${base}.epub`;
}
