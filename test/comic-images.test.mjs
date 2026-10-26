/**
 * 漫画图片地址提取回归
 *
 * 两类真实缺陷的护栏：
 *  1. 装饰图过滤正则曾把 /uploads/ 里的 "ads/" 当成广告图，
 *     导致使用 uploads 目录的站点（漫画DB 系）整站图片被丢弃；
 *  2. 一部分站点的图片地址不在 <img> 里，而在脚本变量里（base64 后的
 *     JSON、一行一个地址、JSON 数组）。这类站点必须能靠书源规则直接
 *     产出地址列表，否则只能显示「没有解析到图片」。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = (p) => pathToFileURL(path.join(__dirname, '..', 'src', p)).href;
const { collectComicImages, parseImageUrlList } = await import(id('core/engine.js'));
const { runLegadoJs } = await import(id('core/legado.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

console.log('== 1. 装饰图过滤不能误杀正常图片目录 ==');
{
	const pick = (html) => collectComicImages(html, 'https://x.com/', {}, DOMParser);
	// 这条曾经是 bug：uploads 中的 "ads/" 命中广告正则
	check('uploads/ 目录不被当成广告', pick('<div><img src="https://i.manhuadb.com/uploads/0001/1.jpg"></div>').length === 1);
	check('upload/ 单数正常', pick('<div><img src="https://x.com/upload/p/1.jpg"></div>').length === 1);
	check('adapt 等含 ad 的词不误杀', pick('<div><img src="https://x.com/adapt/p/1.jpg"></div>').length === 1);
	check('相对路径正常', pick('<div><img src="/p/1.jpg"></div>').length === 1);
	// 真正的装饰图仍要过滤
	check('logo 被过滤', pick('<div><img src="https://x.com/logo.png"></div>').length === 0);
	check('ads/ 目录被过滤', pick('<div><img src="https://x.com/ads/banner.jpg"></div>').length === 0);
	check('icon 被过滤', pick('<div><img src="https://x.com/img/icon/star.png"></div>').length === 0);
	check('loading 占位被过滤', pick('<div><img src="https://x.com/img/loading.gif"></div>').length === 0);
}

console.log('\n== 2. 规则产出的地址列表（脚本变量型站点） ==');
{
	const base = 'https://www.manhuadb.com/ch/1';
	check('每行一个地址', parseImageUrlList('https://a.com/1.jpg\nhttps://a.com/2.jpg', base, {}, DOMParser).length === 2);
	check('JSON 字符串数组', parseImageUrlList('["https://a.com/1.jpg","https://a.com/2.jpg"]', base, {}, DOMParser).length === 2);
	check('JSON 对象数组取 url/img', parseImageUrlList('[{"img":"https://a.com/x.jpg"},{"url":"https://a.com/y.jpg"}]', base, {}, DOMParser).length === 2);
	check('HTML 片段', parseImageUrlList('<img src="/p/1.jpg"><img src="/p/2.jpg">', base, {}, DOMParser).length === 2);
	check('相对路径补全', parseImageUrlList('/uploads/1.jpg', base, {}, DOMParser)[0] === 'https://www.manhuadb.com/uploads/1.jpg');
	check('协议相对补全', parseImageUrlList('//cdn.a.com/1.jpg', base, {}, DOMParser)[0] === 'https://cdn.a.com/1.jpg');
	check('重复地址去重', parseImageUrlList('https://a.com/1.jpg\nhttps://a.com/1.jpg', base, {}, DOMParser).length === 1);
	check('广告地址被剔除', parseImageUrlList('https://a.com/logo.png\nhttps://a.com/p/1.jpg', base, {}, DOMParser).length === 1);
	check('空输入返回空', parseImageUrlList('', base, {}, DOMParser).length === 0);
}

console.log('\n== 3. 端到端：base64 脚本变量 → 地址列表（漫画DB 形态） ==');
{
	const pages = ['0001/1.jpg', '0001/2.jpg', '0001/3.jpg'];
	const imgData = Buffer.from(JSON.stringify(pages.map((u) => ({ img: u })))).toString('base64');
	const html = `<html><body><h2 class="h4 text-center">第01回</h2>
<script>var img_data='${imgData}';</script>
<div data-host="https://i.manhuadb.com" data-img_pre="/uploads/"></div></body></html>`;

	// 书源里写的一条 @js 规则（与内置源同形态）
	const rule = `(function(){
		var m = result.match(/img_data\\s*=\\s*'([^']+)'/); if(!m) return '';
		var h = (result.match(/data-host\\s*=\\s*"([^"]+)"/)||[,''])[1];
		var pre = (result.match(/data-img_pre\\s*=\\s*"([^"]+)"/)||[,''])[1];
		return JSON.parse(atob(m[1])).map(function(o){ return h+pre+((o&&o.img)||o); }).join('\\n');
	})()`;

	const produced = runLegadoJs(html, rule, { baseUrl: 'https://www.manhuadb.com/ch/1' });
	const urls = parseImageUrlList(produced, 'https://www.manhuadb.com/ch/1', {}, DOMParser);
	check('解出全部 3 张图', urls.length === 3, JSON.stringify(urls));
	check('地址拼接正确', urls[0] === 'https://i.manhuadb.com/uploads/0001/1.jpg', urls[0]);
	check('顺序保持不变', urls[1].endsWith('2.jpg') && urls[2].endsWith('3.jpg'));
	// 对照：同一份 HTML 直接扫 <img> 是找不到图的（这正是需要该通道的原因）
	check('直接扫 img 确实抓不到', collectComicImages(html, 'https://www.manhuadb.com/ch/1', {}, DOMParser).length === 0);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
