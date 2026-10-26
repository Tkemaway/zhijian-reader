/** 漫画文件夹 → CBZ：打包结构、封面跳过、自然排序、可被 App 解析 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = (p) => pathToFileURL(path.join(__dirname, '..', p)).href;
const { packComicFolder } = await import(id('scripts/pack-comic.mjs'));
const { parseCbz } = await import(id('src/core/comic-book.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

const PNG = Uint8Array.from(Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zj-comic-'));
const make = (rel, bytes = PNG) => {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, bytes);
};

// 典型 work_crawler 输出：作品/话/页 + 根目录封面
make('cover.jpg');
make('第1话/001.jpg');
make('第1话/002.jpg');
make('第2话/001.png');
make('第2话/010.png'); // 自然排序：应排在 001 后
make('__MACOSX/._001.jpg');
make('第2话/note.txt');

const out = path.join(root, '..', `${path.basename(root)}.cbz`);
const result = packComicFolder(root, out);

check('打包页数（跳过封面与垃圾文件）', result.pages === 4, String(result.pages));
check('按目录分 2 话', result.chapters === 2, String(result.chapters));
check('产出文件存在', fs.existsSync(out) && fs.statSync(out).size > 100);

const parsed = parseCbz(new Uint8Array(fs.readFileSync(out)), '测试漫画.cbz');
check('App 能解析 CBZ', parsed.kind === 'comic', parsed.kind);
check('解析出 2 话', parsed.chapters.length === 2, String(parsed.chapters.length));
check('话名来自目录', parsed.chapters[0].title === '第1话' && parsed.chapters[1].title === '第2话', JSON.stringify(parsed.chapters.map((c) => c.title)));
check('每话页数正确', parsed.chapters[0].images.length === 2 && parsed.chapters[1].images.length === 2);

const withCover = packComicFolder(root, path.join(root, 'with-cover.cbz'), { includeRoot: true });
check('--include-root 会把封面也算进去', withCover.pages === 5, String(withCover.pages));

const flat = packComicFolder(root, path.join(root, 'flat.cbz'), { flat: true, includeRoot: true });
const flatParsed = parseCbz(new Uint8Array(fs.readFileSync(path.join(root, 'flat.cbz'))), 'flat.cbz');
check('--flat 打成一话', flatParsed.chapters.length === 1, String(flatParsed.chapters.length));
check('--flat 保留全部 5 页', flatParsed.chapters[0].images.length === 5, String(flatParsed.chapters[0].images.length));

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(out, { force: true });

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
