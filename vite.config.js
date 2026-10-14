import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

/**
 * 书源请求代理（仅开发预览用）
 * 浏览器直接请求书源网站会被 CORS 拦截，这里做一个转发中间件
 * 打包成 App 后走 CapacitorHttp（原生请求），不需要这个
 */
function sourceProxy() {
	return {
		name: 'zj-source-proxy',
		configureServer(server) {
			server.middlewares.use('/__proxy', async (req, res) => {
				try {
					const reqUrl = new URL(req.url, 'http://localhost');
					const target = reqUrl.searchParams.get('url');
					if (!target) {
						res.statusCode = 400;
						res.end('missing url param');
						return;
					}

					// 读取请求体
					const chunks = [];
					for await (const c of req) chunks.push(c);
					const body = chunks.length ? Buffer.concat(chunks) : undefined;

					// 转发头（浏览器不能设 UA/Referer，客户端通过 x-zj-* 传递）
					const headers = {};
					if (req.headers['x-zj-ua']) headers['user-agent'] = req.headers['x-zj-ua'];
					else if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
					if (req.headers['x-zj-referer']) headers['referer'] = req.headers['x-zj-referer'];
					if (req.headers['x-zj-cookie']) headers['cookie'] = req.headers['x-zj-cookie'];
					if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

					const upstream = await fetch(target, {
						method: (req.method || 'GET').toUpperCase(),
						headers,
						body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
						redirect: 'follow'
					});

					res.statusCode = upstream.status;
					const ct = upstream.headers.get('content-type');
					if (ct) res.setHeader('Content-Type', ct);
					res.setHeader('X-Zj-Final-Url', upstream.url || target);
					res.setHeader('Access-Control-Allow-Origin', '*');
					const ab = await upstream.arrayBuffer();
					res.end(Buffer.from(ab));
				} catch (e) {
					res.statusCode = 502;
					res.end('proxy error: ' + (e && e.message ? e.message : String(e)));
				}
			});
		}
	};
}

export default defineConfig({
	define: {
		// 版本号注入（唯一来源: package.json）
		__APP_VERSION__: JSON.stringify(pkg.version)
	},
	plugins: [sourceProxy()],
	server: {
		host: true,
		port: 5173
	},
	build: {
		target: 'es2020'
	}
});
