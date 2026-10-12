/**
 * 打包前准备：构建网页（如有改动），把 dist 复制到 desktop/bundle/，网关和它的依赖打成单文件放进 bundle/server/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const app = path.join(desktop, 'bundle');

execSync('node scripts/ensure-build.mjs', { cwd: root, stdio: 'inherit' });
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true });
// 网关打成单文件：把它用到的 Claude SDK、MCP SDK 等依赖一起打进去（原来 node_modules 有 6000 多个文件、41 MB）
const { build } = await import(pathToFileURL(path.join(root, 'node_modules/esbuild/lib/main.js')).href);
await build({
  entryPoints: { server: path.join(root, 'server/server.mjs'), mcp: path.join(root, 'server/mcp.mjs') },
  outdir: path.join(app, 'server'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  // 打进 ESM 的 CommonJS 依赖会 require 内置模块
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
});
// shared/*.js 是 ES 模块
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
console.log('桌面版资源已就绪：', app);
