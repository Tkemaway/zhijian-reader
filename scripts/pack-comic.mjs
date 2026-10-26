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
import { zipSync, unzipSync } from 'fflate';
import { naturalCompare } from '../src/core/comic-book.js';

const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

/**
 * 读取一个 zip / cbz 里的图片条目。
 *
 * 为什么需要：work_crawler 默认 `archive_images = true`，会把**每一话**打成一个
 * zip（`0001 第01话.zip`）。用户拿到的产物是 zip 而不是图片目录，
 * 原来的打包器只认文件夹，对这些 zip 完全无能为力。
 *
 * @returns {Array<{name:string, bytes:Uint8Array}>} 已按自然顺序排好
 */
export function readZipImages(zipPath) {
	const raw = new Uint8Array(fs.readFileSync(zipPath));
	let entries;
	try {
		entries = unzipSync(raw);
	} catch (e) {
		throw new Error(`不是有效的 zip（${e.message || e}）`);
	}
	const out = [];
	for (const [name, bytes] of Object.entries(entries)) {
		// 跳过目录项、macOS 垃圾文件
		if (!bytes || !bytes.length) continue;
		if (!IMAGE_RE.test(name)) continue;
		if (/(^|\/)__MACOSX\//.test(name) || /(^|\/)\._/.test(name)) continue;
		// 有些 zip 会把图片装在一层目录里（`images/001.jpg`），只取文件名部分即可
		out.push({ name: path.basename(name), full: name, bytes });
	}
	return out.sort((a, b) => naturalCompare(a.full, b.full));
}

/** 判断一个路径是不是压缩包 */
export function isArchive(p) {
	return /\.(zip|cbz)$/i.test(String(p || ''));
}

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

/** 只取这一层目录里的图片（不往下钻） */
function directImages(dir) {
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && IMAGE_RE.test(e.name))
		.map((e) => e.name)
		.sort(naturalCompare);
}

/**
 * 收集一个「作品目录」里的全部话：
 *   - 子目录里的图片 = 一话（目录名当话名）
 *   - 子目录里的 zip/cbz = 一话（文件名去掉扩展名当话名）
 *   - 根目录散图（未分话）= 归到「未分话」一话里
 *
 * 注意「这一层有图」和「子树里有图」必须分开判断：
 * work_crawler 的层级是 <作品>/<作品id>/<话>/<页>.jpg，
 * 若把递归找到的图当成「本层的一话」，整部作品会被压成 1 话。
 *
 * @returns {Array<{title:string, images:Array<{name:string,bytes:Uint8Array}>}>}
 */
export function collectChapters(root, { includeRoot = false, _depth = 0 } = {}) {
	const chapters = [];
	const rootImages = [];

	for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
		if (ent.name.startsWith('.') || ent.name === '__MACOSX') continue;
		const full = path.join(root, ent.name);

		if (ent.isDirectory()) {
			// ① 本层直接放的图 = 章节目录；没有就继续往下找
			const ownNames = directImages(full);
			const ownImgs = ownNames.map((name) => ({
				name,
				bytes: new Uint8Array(fs.readFileSync(path.join(full, name)))
			}));
			// ② 本层直接放的「每一话一个 zip」
			const ownZips = fs.readdirSync(full, { withFileTypes: true })
				.filter((e) => e.isFile() && isArchive(e.name))
				.filter((e) => !e.name.toLowerCase().startsWith('desktop.ini'));

			// ③ 两者都没有 → 它只是容器（如 work_crawler 的 <作品id> 目录），继续往下钻
			if (!ownImgs.length && !ownZips.length) {
				if (_depth < 4) {
					const deeper = collectChapters(full, { includeRoot, _depth: _depth + 1 });
					if (deeper.length) chapters.push(...deeper);
				}
				continue;
			}
			if (ownImgs.length) chapters.push({ title: ent.name, images: ownImgs });
			for (const z of ownZips) {
				const imgs = readZipImages(path.join(full, z.name));
				if (imgs.length) chapters.push({ title: z.name.replace(/\.(zip|cbz)$/i, ''), images: imgs });
			}
			continue;
		}

		if (isArchive(ent.name)) {
			// 每一话一个 zip：解出来的图片就是这个章节
			const imgs = readZipImages(full);
			if (imgs.length) {
				chapters.push({ title: ent.name.replace(/\.(zip|cbz)$/i, ''), images: imgs });
			}
			continue;
		}

		if (IMAGE_RE.test(ent.name)) rootImages.push({ name: ent.name, bytes: new Uint8Array(fs.readFileSync(full)) });
	}

	// 根目录散图：默认只当封面忽略；除非 --include-root 或整个作品都没分话
	if (rootImages.length && (includeRoot || !chapters.length)) {
		rootImages.sort((a, b) => naturalCompare(a.name, b.name));
		chapters.push({ title: '', images: rootImages });
	}

	return chapters;
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

	// 统一收集：章节目录 + 每话 zip 都算一话
	const chapters = collectChapters(inputDir, { includeRoot });
	if (!chapters.length) throw new Error('这个文件夹里没有图片或漫画 zip');

	const files = {};
	let pages = 0;
	let chapterCount = 0;
	const usedNames = new Set();

	const push = (name, bytes) => {
		let n = name;
		let k = 1;
		while (usedNames.has(n)) n = `${k++}-${name}`;
		usedNames.add(n);
		files[n] = bytes;
		pages++;
	};

	if (flat) {
		// 全部摊平成一话，按「章节顺序 → 页序」铺开
		let i = 0;
		for (const ch of chapters) {
			for (const img of ch.images) {
				const ext = path.extname(img.name).toLowerCase() || '.jpg';
				push(`${String(++i).padStart(4, '0')}${ext}`, img.bytes);
			}
		}
		chapterCount = 1;
	} else {
		chapters.forEach((ch, ci) => {
			// 章节前缀补零，保证解压后按顺序排（第2话在第10话前面）。
			// 若话名本身已带序号（work_crawler 的「0001 第01话」），就不再重复加前缀。
			const alreadyNumbered = /^\d+\s/.test(ch.title || '');
			const dir = ch.title
				? (alreadyNumbered ? ch.title : `${String(ci + 1).padStart(4, '0')} ${ch.title}`)
				: `${String(ci + 1).padStart(4, '0')}`;
			ch.images.forEach((img, pi) => {
				// 文件名统一重排，避免 work_crawler 的 `123456-1-001.jpg` 这类命名
				// 在合并多话后相互覆盖
				const ext = path.extname(img.name).toLowerCase() || '.jpg';
				const base = `${String(pi + 1).padStart(4, '0')}${ext}`;
				push(dir ? `${dir}/${base}` : base, img.bytes);
			});
			chapterCount++;
		});
	}

	const zip = zipSync(files, { level: 0 });
	fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
	fs.writeFileSync(outputFile, zip);

	return {
		output: path.resolve(outputFile),
		pages,
		chapters: chapterCount,
		bytes: zip.length
	};
}

/**
 * 批量打包：一个父目录下通常有多个作品文件夹（work_crawler 的输出目录就是
 *   <下载根>/<站点>/<作品>/<章节>/001.jpg
 * 逐个手动打包太费事，这里一次全扫出来。
 *
 * @param {string} parentDir 父目录
 * @param {string} outDir 输出目录
 * @param {{flat?:boolean, includeRoot?:boolean, skipExisting?:boolean}} opts
 * @returns {Array<{title:string, output:string, pages:number, chapters:number, bytes:number, error?:string}>}
 */
export function packComicBatch(parentDir, outDir, { flat = false, includeRoot = false, skipExisting = true } = {}) {
	const stat = fs.statSync(parentDir);
	if (!stat.isDirectory()) throw new Error('批量模式需要传入「父目录」');
	fs.mkdirSync(outDir, { recursive: true });

	// 判定一个目录是不是「作品目录」：它自身没有图片，但子树里有图片
	// 注意：work_crawler 默认把每一话打成 zip，所以「有内容」不只等于有图片，
	// 有 zip/cbz 也算有内容。否则批量扫描会把整部作品当成空目录跳过。
	const hasImages = (dir) => {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			if (ent.name.startsWith('.') || ent.name === '__MACOSX') continue;
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				if (hasImages(full)) return true;
			} else if (IMAGE_RE.test(ent.name) || isArchive(ent.name)) {
				return true;
			}
		}
		return false;
	};

	const results = [];

	/** 目录里有没有子目录包含图片（用于区分「作品目录」与「章节目录」） */
	const childDirsWithImages = (dir) => fs.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX')
		.filter((e) => hasImages(path.join(dir, e.name)));

	/**
	 * 判断一个目录是不是「作品根」。
	 *
	 * work_crawler 的层级是 <站点>/<作品>/<章节>/NNN.jpg，所以：
	 *   - 有子目录含图 → 这一层是「作品」（章节在下一层）
	 *   - 没有子目录含图、但自身有图 → 这一层是「章节/散图」层级，作品是它的父目录
	 * 早先的实现只要「有图」就当作品，结果把每一话都打成一本，必须避免。
	 */
	const entriesOf = (dir) => fs.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX');

	/**
	 * 判断一个目录是「作品根」还是「作品内部的 id/卷目录」。
	 *
	 * work_crawler 的层级其实是：
	 *    <站点>/<作品名>/<作品id>/<NNNN 第N话>.zip
	 * 所以只看一层会把「作品id」当成作品名（生成 123456.cbz 这种文件）。
	 * 规则：如果这一层只有一个子目录、且自己没有直接的图片/zip，
	 * 就把它当作容器继续往下，用父级目录名当作品名。
	 */
	const isPureContainer = (dir) => {
		const ents = fs.readdirSync(dir, { withFileTypes: true })
			.filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX');
		const dirs = ents.filter((e) => e.isDirectory());
		const files = ents.filter((e) => e.isFile() && (IMAGE_RE.test(e.name) || isArchive(e.name)));
		// 只有一个子目录、没有直接内容 → 是容器
		return !files.length && dirs.length === 1;
	};

	/** 一直往下钻到真正放内容的层，返回该层路径 */
	const descendToContent = (dir, depth = 0) => {
		if (depth > 3) return dir;
		if (!isPureContainer(dir)) return dir;
		const only = fs.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX')[0];
		return only ? descendToContent(path.join(dir, only.name), depth + 1) : dir;
	};

	const walk = (dir) => {
		for (const ent of entriesOf(dir)) {
			const full = path.join(dir, ent.name);
			if (!hasImages(full)) continue;

			const nested = childDirsWithImages(full);

			if (!nested.length) {
				// 这一层自己就是内容（散图 / 单话 zip），作品名取这一层
				addWorkspace(ent.name, full);
				continue;
			}

			// 这一层自己也有直接的图片/zip，同时还有含内容的子目录：
			// 说明子目录是「话」，这一层就是作品
			const hasDirectFiles = fs.readdirSync(full, { withFileTypes: true })
				.some((e) => e.isFile() && (IMAGE_RE.test(e.name) || isArchive(e.name)));
			if (hasDirectFiles) { addWorkspace(ent.name, full); continue; }

			// 否则它可能只是 <作品id> 之类的容器：
			// 若它只有一个子目录 → 用当前名（作品名）打包整个子树
			if (isPureContainer(full)) { addWorkspace(ent.name, full); continue; }

			// 多个子目录且自己没内容 → 这些子目录才是作品，继续往下
			walk(full);
		}
	};

	const addWorkspace = (title, dir) => {
		const out = path.join(outDir, title + '.cbz');
		if (skipExisting && fs.existsSync(out)) {
			results.push({ title, output: out, pages: 0, chapters: 0, bytes: 0, skipped: true });
			return;
		}
		try {
			results.push({ title, ...packComicFolder(dir, out, { flat, includeRoot }) });
		} catch (e) {
			results.push({ title, output: out, pages: 0, chapters: 0, bytes: 0, error: e.message });
		}
	};

	// 顶层也可能直接就是作品（父目录本身含散图）
	walk(parentDir);
	return results;
}

function main() {
	const argv = process.argv.slice(2);
	if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
		console.log(`漫画文件夹 → CBZ

用法:
  node scripts/pack-comic.mjs <文件夹> [-o 输出.cbz] [--flat] [--include-root]
  node scripts/pack-comic.mjs --batch <父目录> [-o 输出目录] [--flat] [--force]

选项:
  -o, --output    单本：输出文件（默认 <文件夹名>.cbz）；批量：输出目录
  --batch         批量模式：把父目录下每个「作品目录」各打成一个 CBZ
  --flat          不按子目录分话，所有图片打成一话
  --include-root  连根目录的散图（封面等）也一起打包
  --force         批量时覆盖已存在的 CBZ（默认跳过）

例:
  node scripts/pack-comic.mjs "D:\\comics\\海贼王" -o "D:\\海贼王.cbz"
  node scripts/pack-comic.mjs --batch "D:\\work_crawler\\comic.cmn-Hans-CN" -o "D:\\cbz"`);
		process.exit(0);
	}

	// ---------- 批量模式 ----------
	if (argv.includes('--batch')) {
		const pos = argv.filter((a) => !a.startsWith('-'));
		const outIdx = argv.findIndex((a) => a === '-o' || a === '--output');
		const explicitOut = outIdx !== -1 ? argv[outIdx + 1] : '';
		const parentDir = path.resolve(pos[0] === '--batch' ? pos[1] || '.' : pos[0] || '.');
		const outDir = explicitOut ? path.resolve(explicitOut) : path.resolve(process.cwd(), 'cbz');
		const list = packComicBatch(parentDir, outDir, {
			flat: argv.includes('--flat'),
			includeRoot: argv.includes('--include-root'),
			skipExisting: !argv.includes('--force')
		});
		const ok = list.filter((r) => !r.error && !r.skipped);
		const skipped = list.filter((r) => r.skipped);
		const failed = list.filter((r) => r.error);
		const mb = (ok.reduce((s, r) => s + r.bytes, 0) / 1024 / 1024).toFixed(1);
		console.log(`✅ 批量打包完成：${ok.length} 本 / ${mb} MB`);
		ok.forEach((r) => console.log(`   ${r.title}  ${r.chapters} 话 · ${r.pages} 页`));
		if (skipped.length) console.log(`   （跳过已存在 ${skipped.length} 本，加 --force 覆盖）`);
		if (failed.length) {
			console.log(`   ⚠️ 失败 ${failed.length} 本：`);
			failed.forEach((r) => console.log(`     ${r.title}: ${r.error}`));
		}
		console.log(`\n   输出目录：${outDir}`);
		console.log('   全部选中这些 .cbz 导入即可（App 内「导入」支持多选）');
		process.exit(failed.length ? 1 : 0);
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
