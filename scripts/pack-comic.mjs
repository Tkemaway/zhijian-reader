#!/usr/bin/env node
/**
 * 漫画文件夹 → CBZ 打包器
 *
 * 用途：work_crawler 这类桌面下载器会把漫画存成
 *   <作品>/<章节>/001.jpg ...
 * 纸间可以直接读 CBZ，所以这里把目录原样打进 zip
 * （保留章节子目录 → 导入后按目录分话）。
 *
 * 用法：
 *   node scripts/pack-comic.mjs "D:\downloads\某漫画"
 *   node scripts/pack-comic.mjs "D:\downloads\某漫画" -o "D:\某漫画.cbz"
 *   node scripts/pack-comic.mjs "D:\downloads\某漫画" --flat   # 全部图片当作一话
 *
 * 说明：
 * - 默认跳过根目录下的散图（通常是封面/logo），只打包章节子目录
 * - 图片按自然顺序排序（2 在 10 前面）
 * - 图片本身已压缩，zip 用存储模式（level 0），打包快、体积几乎不变
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { naturalCompare } from '../src/core/comic-book.js';

const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

/** 递归收集图片；返回相对路径（POSIX 风格） */
export function collectComicImages(root, { includeRoot = false } = {}) {
	const all = [];
	const walk = (dir) => {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			if (ent.name.startsWith('.') || ent.name === '__MACOSX') continue;
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full);
				continue;
			}
			if (!IMAGE_RE.test(ent.name)) continue;
			all.push({ full, rel: path.relative(root, full).split(path.sep).join('/') });
		}
	};
	walk(root);

	const nested = all.filter((it) => it.rel.includes('/'));
	// 有章节子目录时，根目录的散图（封面、banner）默认不放进正文
	const picked = nested.length && !includeRoot ? nested : all;
	return picked.sort((a, b) => naturalCompare(a.rel, b.rel));
}

/**
 * 打包
 * @param {string} inputDir
 * @param {string} outputFile
 * @param {{flat?: boolean, includeRoot?: boolean}} opts
 * @returns {{output: string, pages: number, chapters: number, bytes: number}}
 */
export function packComicFolder(inputDir, outputFile, { flat = false, includeRoot = false } = {}) {
	const stat = fs.statSync(inputDir);
	if (!stat.isDirectory()) throw new Error('输入必须是文件夹');
	const images = collectComicImages(inputDir, { includeRoot });
	if (!images.length) throw new Error('这个文件夹里没有图片（jpg/png/webp/gif/avif/bmp）');

	const files = {};
	const chapterDirs = new Set();
	images.forEach((img, i) => {
		let name;
		if (flat || !img.rel.includes('/')) {
			const ext = path.extname(img.rel).toLowerCase();
			name = `${String(i + 1).padStart(3, '0')}${ext}`;
		} else {
			name = img.rel;
			chapterDirs.add(name.slice(0, name.lastIndexOf('/')));
		}
		// 同名（flat 下不重复，这里只兜底）
		if (files[name]) name = `${i}-${name}`;
		files[name] = new Uint8Array(fs.readFileSync(img.full));
	});

	const zip = zipSync(files, { level: 0 });
	fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
	fs.writeFileSync(outputFile, zip);

	return {
		output: path.resolve(outputFile),
		pages: images.length,
		chapters: chapterDirs.size || 1,
		bytes: zip.length
	};
}

function main() {
	const argv = process.argv.slice(2);
	if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
		console.log(`漫画文件夹 → CBZ

用法:
  node scripts/pack-comic.mjs <文件夹> [-o 输出.cbz] [--flat] [--include-root]

选项:
  -o, --output    输出文件（默认：<文件夹名>.cbz，放在当前目录）
  --flat          不按子目录分话，所有图片打成一话
  --include-root  连根目录的散图（封面等）也一起打包

例:
  node scripts/pack-comic.mjs "D:\\comics\\海贼王" -o "D:\\海贼王.cbz"`);
		process.exit(0);
	}

	const inputDir = path.resolve(argv[0]);
	const outIdx = argv.findIndex((a) => a === '-o' || a === '--output');
	const explicitOut = outIdx !== -1 ? argv[outIdx + 1] : '';
	const outputFile = explicitOut
		? path.resolve(explicitOut)
		: path.resolve(process.cwd(), `${path.basename(inputDir)}.cbz`);

	const result = packComicFolder(inputDir, outputFile, {
		flat: argv.includes('--flat'),
		includeRoot: argv.includes('--include-root')
	});
	const mb = (result.bytes / 1024 / 1024).toFixed(1);
	console.log(`✅ 打包完成：${result.chapters} 话 / ${result.pages} 页 / ${mb} MB`);
	console.log(`   ${result.output}`);
	console.log('   传到手机后：本地 → 导入，选中这个 .cbz 即可');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
	main();
}
