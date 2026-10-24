/** 书名/作者清洗回归：HTML 实体（含双重转义）、零宽字符、空白 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = (p) => pathToFileURL(path.join(__dirname, '..', 'src', p)).href;
const { cleanMetaText, decodeEntitiesDeep } = await import(id('core/text-clean.js'));
const identity = await import(id('store/book-identity.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}${extra ? ' | ' + extra : ''}`); }
};

console.log('== 实体解码 ==');
check('单层实体', decodeEntitiesDeep('龙族&#183;悼亡者') === '龙族·悼亡者', decodeEntitiesDeep('龙族&#183;悼亡者'));
check('双重转义', cleanMetaText('龙族Ⅴ&amp;#183;悼亡者的归来') === '龙族Ⅴ·悼亡者的归来', cleanMetaText('龙族Ⅴ&amp;#183;悼亡者的归来'));
check('十六进制实体', cleanMetaText('A&#xB7;B') === 'A·B', cleanMetaText('A&#xB7;B'));
check('命名实体', cleanMetaText('A&middot;B&nbsp;C') === 'A·B C', cleanMetaText('A&middot;B&nbsp;C'));

console.log('== 脏字符清理 ==');
check('零宽字符', cleanMetaText('书\u200b名') === '书名', JSON.stringify(cleanMetaText('书\u200b名')));
check('控制符', cleanMetaText('书\u0001名') === '书名');
check('全角空格压缩', cleanMetaText('书\u3000\u3000名') === '书 名', JSON.stringify(cleanMetaText('书\u3000\u3000名')));
check('首尾空白', cleanMetaText('  书名  ') === '书名');

console.log('== 身份键收敛 ==');
const a = identity.bookIdentityKey({ title: '龙族Ⅴ&amp;#183;悼亡者的归来', author: '江南', sourceId: 's1' });
const b = identity.bookIdentityKey({ title: '龙族Ⅴ·悼亡者的归来', author: '江南', sourceId: 's1' });
check('脏写法与净写法同键', a === b, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
