/**
 * 内置漫画源回归
 *
 * 下载器自带一份漫画书源，打开页面自动载入 → 直接搜索。
 * 之前没有内置源，用户看到界面上有搜索框却点不动（只会弹「先加载书源」），
 * 这是「看不到搜索下载」的真正原因，这里守住这条链路。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = (p) => pathToFileURL(path.join(__dirname, '..', p)).href;
const { parseSourceInput } = await import(id('src/core/custom-sources.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

const file = path.join(__dirname, '..', 'tools', 'comic-downloader', 'builtin-sources.json');
console.log('== 1. 内置源文件存在且可解析 ==');
check('builtin-sources.json 存在', fs.existsSync(file));
const text = fs.readFileSync(file, 'utf8');
const parsed = parseSourceInput(text);
check('能解析出书源', !parsed.error, parsed.error);
check('源数量 >= 20', parsed.list.length >= 20, String(parsed.list.length));

console.log('\n== 2. 每个源都是可用的漫画源 ==');
const list = parsed.list;
check('全部标记为漫画源', list.every((s) => s.kind === 'comic'), list.filter((s) => s.kind !== 'comic').map((s) => s.name).join(','));
check('全部是 legado 规则', list.every((s) => s.type === 'legado'));
check('全部有 searchUrl', list.every((s) => !!s.searchUrl));
check('全部有目录规则', list.every((s) => !!s.ruleToc?.chapterList));
check('全部有正文/图片规则', list.every((s) => !!s.ruleContent?.content));
check('url 都是 http(s)', list.every((s) => /^https?:\/\//i.test(s.url)));
check('id 唯一', new Set(list.map((s) => s.id)).size === list.length);

console.log('\n== 3. 接口与前端接线 ==');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'comic-downloader', 'server.mjs'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'comic-downloader', 'public', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'comic-downloader', 'public', 'index.html'), 'utf8');
check('服务端暴露 /api/sources/builtin', serverSrc.includes('/api/sources/builtin'));
check('前端启动时自动加载内置源', /loadBuiltinSources\(\{\s*silent:\s*true\s*\}\)/.test(appSrc));
check('页面有「加载内置源」按钮', htmlSrc.includes('load-builtin'));

fs.statSync(file);
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
