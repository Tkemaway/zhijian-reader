/**
 * 引擎全链路测试：搜索 → 目录 → 章节内容
 * 运行: npm run test:engine
 */
import { DOMParser } from 'linkedom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { searchSource, fetchToc, fetchChapter } from '../src/core/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(readFileSync(path.join(__dirname, '../src/core/sources.json'), 'utf-8'));

const KEYWORD = process.argv[2] || '斗破苍穹';
const ONLY = process.argv[3] ? parseInt(process.argv[3], 10) : null;

console.log(`关键词: ${KEYWORD}`);
console.log('='.repeat(72));

const summary = [];

for (const [i, source] of sources.entries()) {
	if (ONLY && i !== ONLY) continue;
	const label = `[${i}] ${source.name} (${source.type})`;
	const row = { label, search: '✗', toc: '-', chapter: '-', note: '' };

	try {
		const t0 = Date.now();
		const { results, error } = await searchSource(source, KEYWORD, DOMParser);
		if (error) {
			row.note = error.slice(0, 80);
			console.log(`${label}\n  搜索失败: ${error.slice(0, 120)}`);
			summary.push(row);
			continue;
		}
		const searchMs = Date.now() - t0;
		row.search = `✓ ${results.length}`;
		console.log(`${label}  搜索 ${results.length} 条 (${searchMs}ms)`);
		results.slice(0, 3).forEach((r) =>
			console.log(`    · ${r.bookName} | ${r.author || '?'} | ${(r.bookUrl || '').slice(0, 70)}`)
		);
		if (!results.length) { summary.push(row); continue; }

		// 取第一个结果抓目录
		const book = results[0];
		const toc = await fetchToc(source, { bookUrl: book.bookUrl, tocUrl: book.tocUrl }, DOMParser);
		if (toc.error || !toc.chapters.length) {
			row.toc = '✗';
			row.note = (toc.error || '无章节').slice(0, 80);
			console.log(`   目录失败: ${toc.error || '无章节'}`);
			summary.push(row);
			continue;
		}
		row.toc = `✓ ${toc.chapters.length}`;
		console.log(`   目录 ${toc.chapters.length} 章, 例: ${toc.chapters[0].title} → ${toc.chapters[0].url.slice(0, 60)}`);
		console.log(`   ... 末章: ${toc.chapters[toc.chapters.length - 1].title}`);

		// 抓第 1 章
		const ch = toc.chapters[0];
		const chapter = await fetchChapter(source, ch.url, DOMParser, ch.title);
		if (chapter.error || !chapter.paragraphs.length) {
			row.chapter = '✗';
			row.note = (chapter.error || '空内容').slice(0, 80);
			console.log(`   章节失败: ${chapter.error || '空内容'}`);
		} else {
			row.chapter = `✓ ${chapter.paragraphs.length}段`;
			console.log(`   章节《${chapter.title}》 ${chapter.paragraphs.length} 段, 首段: ${chapter.paragraphs[0].slice(0, 60)}`);
		}
	} catch (e) {
		row.note = String(e.message || e).slice(0, 80);
		console.log(`  异常: ${row.note}`);
	}
	summary.push(row);
}

console.log('\n' + '='.repeat(72));
console.log('汇总:');
for (const r of summary) {
	console.log(`  ${r.label.padEnd(30)} 搜索:${r.search.padEnd(5)} 目录:${r.toc.padEnd(8)} 章节:${r.chapter.padEnd(8)} ${r.note}`);
}
