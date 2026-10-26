/**
 * 批量打包回归：把一个下载器输出目录里的多部作品，各自打成一个 CBZ
 *
 * 背景：work_crawler 这类桌面下载器的输出层级是
 *   <站点>/<作品>/<话>/NNN.jpg
 * 一部作品有几十上百话，逐话导入不现实。批量模式要能把每个「作品目录」
 * 打成一个 CBZ，同时**不能**把每一话当成一部作品（曾出现过的 bug）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = (p) => pathToFileURL(path.join(__dirname, '..', p)).href;
const { packComicBatch } = await import(id('scripts/pack-comic.mjs'));
const { parseBookFile } = await import(id('src/core/importer.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

const PNG = Uint8Array.from(Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zj-batch-'));
const outDir = path.join(root, '_out');
const make = (rel) => {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, PNG);
};

// 模拟 work_crawler 的真实层级：<站点>/<作品>/[<作品id>]/<话>/<页>
make('comic.cmn-Hans-CN/海贼王/12345/0001 第01话/12345-1-001.jpg');
make('comic.cmn-Hans-CN/海贼王/12345/0001 第01话/12345-1-002.jpg');
make('comic.cmn-Hans-CN/海贼王/12345/0002 第02话/12345-2-001.jpg');
make('comic.cmn-Hans-CN/进击的巨人/67890/0001 第01话/67890-1-001.jpg');
make('comic.cmn-Hans-CN/进击的巨人/67890/0001 第01话/67890-1-002.jpg');
// 无章节层的散图作品
make('comic.cmn-Hans-CN/短篇集/11111/001.jpg');
make('comic.cmn-Hans-CN/短篇集/11111/002.jpg');
// 应被忽略的垃圾
make('comic.cmn-Hans-CN/__MACOSX/._x.jpg');
make('comic.cmn-Hans-CN/空目录占位/.keep');

console.log('== 1. 作品识别 ==');
const list = packComicBatch(path.join(root, 'comic.cmn-Hans-CN'), outDir);
const titles = list.filter((r) => !r.error && !r.skipped).map((r) => r.title).sort();
check('识别出 3 部作品', titles.length === 3, JSON.stringify(titles));
check('没有把每一话当成作品', !titles.some((t) => /第0\d话/.test(t)), JSON.stringify(titles));
check('作品名正确', ['海贼王', '进击的巨人', '短篇集'].every((t) => titles.includes(t)), JSON.stringify(titles));
check('无失败项', list.every((r) => !r.error), JSON.stringify(list.filter((r) => r.error)));

console.log('\n== 2. 章节与页数 ==');
{
	const one = list.find((r) => r.title === '海贼王');
	check('海贼王 分 2 话', one?.chapters === 2, String(one?.chapters));
	check('海贼王 共 3 页', one?.pages === 3, String(one?.pages));
	const short = list.find((r) => r.title === '短篇集');
	check('散图作品 1 话 2 页', short?.chapters === 1 && short?.pages === 2, JSON.stringify({ c: short?.chapters, p: short?.pages }));
}

console.log('\n== 3. 产物可被 App 导入 ==');
{
	for (const name of ['海贼王', '进击的巨人', '短篇集']) {
		const p = path.join(outDir, name + '.cbz');
		check(name + '.cbz 已生成', fs.existsSync(p));
		if (!fs.existsSync(p)) continue;
		const buf = new Uint8Array(fs.readFileSync(p));
		const parsed = parseBookFile(buf, name + '.cbz', DOMParser);
		check(name + ' 被识别为漫画', parsed.kind === 'comic', parsed.kind);
		check(name + ' 书名取自文件名', parsed.title === name, parsed.title);
	}
	const parsed = parseBookFile(new Uint8Array(fs.readFileSync(path.join(outDir, '海贼王.cbz'))), '海贼王.cbz', DOMParser);
	check('海贼王导入后仍 2 话', parsed.chapters.length === 2, String(parsed.chapters.length));
}

console.log('\n== 4. 重复运行不覆盖已有文件 ==');
{
	const again = packComicBatch(path.join(root, 'comic.cmn-Hans-CN'), outDir);
	check('默认跳过已存在', again.filter((r) => r.skipped).length === 3, String(again.filter((r) => r.skipped).length));
	const forced = packComicBatch(path.join(root, 'comic.cmn-Hans-CN'), outDir, { skipExisting: false });
	check('--force 时重新打包', forced.filter((r) => !r.skipped && !r.error).length === 3);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
