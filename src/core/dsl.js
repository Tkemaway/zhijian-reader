/**
 * DSL 引擎 —— so-novel 规则语法的 JS 复刻
 *
 * 语法: selector@js:code1@java:code2
 * 执行: init(选择器部分) + 串行 steps，前一步的输出作为后一步的输入
 * JS 语义: function func(r) { <code>; return r; }
 */

/**
 * 解析 DSL 字符串为 { init, steps }
 * 复刻 DSLParser.java 的解析逻辑
 */
export function parseDsl(input) {
	if (!input) return { init: '', steps: [] };

	const first = input.indexOf('@');
	const init = first === -1 ? input : input.substring(0, first);

	const steps = [];
	let i = first;

	while (i !== -1 && i < input.length) {
		const at = input.indexOf('@', i + 1);
		const colon = input.indexOf(':', i);

		if (colon === -1) break;

		const lang = input.substring(i + 1, colon);
		const nextAt = at === -1 ? input.length : at;
		const code = input.substring(colon + 1, nextAt);

		steps.push({ lang, code: code.trim() });
		i = at;
	}

	return { init, steps };
}

/**
 * 去掉 query 中的 DSL 后缀，只保留选择器部分
 * 注意: 第一个 @ 之前才是选择器
 */
export function stripQuery(query) {
	if (!query) return query;
	const atIndex = query.indexOf('@');
	return atIndex > 0 ? query.substring(0, atIndex) : query;
}

/**
 * 执行 JS 代码片段（select 的 @js: 部分）
 * 复刻 JsCaller.call: function func(r) { code; return r; }
 */
export function runJs(code, input) {
	try {
		// 沙箱内不可访问 window/document 的敏感操作，但规则来自受控的内置规则集
		const func = new Function('r', `${code};
return r;`);
		const result = func(input);
		return result == null ? '' : String(result);
	} catch (e) {
		console.warn('[dsl] JS step failed:', code.slice(0, 60), e.message);
		return input == null ? '' : String(input);
	}
}

/**
 * 执行 Java 步骤（@java: 部分）
 * 复刻 JavaExecutor.java 支持的两个操作
 */
export function runJava(code, input) {
	const src = input == null ? '' : String(input);

	// base64.decode(): 按行切分 -> 过滤空行 -> Base64 解码 -> 拼接
	if (code === 'base64.decode()') {
		try {
			const parts = src
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter((l) => l.length > 0)
				.map((l) => decodeBase64ToUtf8(l));
			return parts.join('');
		} catch {
			return src;
		}
	}

	// string.replace('a','b'): 全局替换（Java 里是 replaceAll）
	const m = code.match(/^string\.replace\('([^']*)','([^']*)'\)$/);
	if (m) {
		const [, s1, s2] = m;
		try {
			return src.replace(new RegExp(s1, 'g'), s2);
		} catch {
			return src.split(s1).join(s2);
		}
	}

	return src;
}

/** Base64 -> UTF-8 字符串（正确处理中文） */
function decodeBase64ToUtf8(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 执行完整 DSL（有 initialContext 时忽略 init，直接串行 steps）
 * 复刻 StepEngine.run
 */
export function executeDsl(dsl, initialContext) {
	const { init, steps } = parseDsl(dsl);

	let result =
		initialContext != null ? initialContext : init.trim();

	for (const step of steps) {
		if (step.lang === 'js') result = runJs(step.code, result);
		else if (step.lang === 'java') result = runJava(step.code, result);
	}

	return result;
}
