/**
 * 发布构建脚本 —— 版本号自动化
 *
 * 用法:
 *   npm run release            用当前版本构建
 *   npm run release -- patch   1.3.0 → 1.3.1
 *   npm run release -- minor   1.3.0 → 1.4.0
 *   npm run release -- major   1.3.0 → 2.0.0
 *
 * 流程:
 *   1. 更新 package.json 版本（唯一版本源）
 *   2. versionCode = major*10000 + minor*100 + patch（单调递增）
 *   3. 写入 android/app/build.gradle
 *   4. Vite 构建 → cap sync → Gradle 打包
 *   5. 输出 纸间-v<version>.apk 到项目根目录
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
process.chdir(root);

const run = (cmd, opts = {}) => {
	const { cwd = root, ...env } = opts;
	console.log(`\n$ ${cmd}`);
	execSync(cmd, {
		stdio: 'inherit',
		env: { ...process.env, ...env },
		cwd,
		shell: true
	});
};

// ---------- 1. 版本管理 ----------
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const bump = (process.argv[2] || '').toLowerCase();

if (['patch', 'minor', 'major'].includes(bump)) {
	const [maj, min, pat] = pkg.version.split('.').map(Number);
	if (bump === 'major') pkg.version = `${maj + 1}.0.0`;
	else if (bump === 'minor') pkg.version = `${maj}.${min + 1}.0`;
	else pkg.version = `${maj}.${min}.${pat + 1}`;
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
	console.log(`版本号提升 (${bump}) → v${pkg.version}`);
}

const [maj, min, pat] = pkg.version.split('.').map(Number);
const versionCode = maj * 10000 + min * 100 + pat;

// ---------- 2. 写入安卓工程 ----------
const gradlePath = path.join(root, 'android/app/build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf-8');
const beforeCode = (gradle.match(/versionCode (\d+)/) || [])[1];
gradle = gradle.replace(/versionCode \d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);
fs.writeFileSync(gradlePath, gradle, 'utf-8');
console.log(`\n安卓版本: versionCode ${beforeCode || '?'} → ${versionCode} | versionName → "${pkg.version}"`);

// ---------- 3. 构建 ----------
run('npm run build');
run('npx cap sync android');

// ---------- 4. Gradle 打包 ----------
const javaHome = process.env.JAVA_HOME || 'D:\\android-build\\jdk-21.0.12.1+1';
const isWin = process.platform === 'win32';
run(`${isWin ? 'gradlew.bat' : './gradlew'} assembleDebug --no-daemon`, {
	JAVA_HOME: javaHome,
	cwd: path.join(root, 'android')
});

// ---------- 5. 输出 ----------
const apkSrc = path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
const apkOut = path.join(root, `纸间-v${pkg.version}.apk`);
fs.copyFileSync(apkSrc, apkOut);
const size = (fs.statSync(apkOut).size / 1024 / 1024).toFixed(2);

// ---------- 6. 归档旧包：根目录只保留最新，历史最多留 3 个 ----------
// 每版 APK 约 9MB，长期堆在根目录会越来越乱；旧包统一进 _apk_history/（已 gitignore）
const apkName = path.basename(apkOut);
const historyDir = path.join(root, '_apk_history');
fs.mkdirSync(historyDir, { recursive: true });
for (const f of fs.readdirSync(root)) {
	if (!f.endsWith('.apk') || f === apkName) continue;
	try { fs.renameSync(path.join(root, f), path.join(historyDir, f)); } catch { /* ignore */ }
}
const archived = fs.readdirSync(historyDir)
	.filter((f) => f.endsWith('.apk'))
	.map((f) => ({ f, t: fs.statSync(path.join(historyDir, f)).mtimeMs }))
	.sort((a, b) => b.t - a.t);
for (const old of archived.slice(3)) {
	try { fs.unlinkSync(path.join(historyDir, old.f)); } catch { /* ignore */ }
}

console.log(`\n========================================`);
console.log(`  ✅ 纸间 v${pkg.version} 构建完成`);
console.log(`     versionCode: ${versionCode}`);
console.log(`     输出: ${apkOut}（${size} MB）`);
console.log(`========================================`);
