/**
 * 服务器安装包真装真启动（2026-11-01：1.0.355～1.0.359 安装包少列依赖，服务器更新后启动即崩，用户看到 502）。
 *   node e2e/server-package.mjs release-server/jarvis-server-<版本>.tar.gz
 * 照 deploy/install.sh 的方式解压、只按包里的 package.json 装依赖（不带开发依赖和可选依赖），再启动，
 * 确认 /api/health 能回、网页能打开、能登录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const pkg = path.resolve(process.argv[2] || '');
if (!fs.existsSync(pkg)) { console.error('用法：node e2e/server-package.mjs <jarvis-server-*.tar.gz>'); process.exit(1); }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pkg-'));
const app = path.join(work, 'app'), data = path.join(work, 'data');
fs.mkdirSync(app); fs.mkdirSync(data);
execFileSync('tar', ['-xzf', pkg, '-C', app, '--strip-components=1']);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, stdio: 'inherit' });

const PORT = 8823, PASS = 'pkg-check-123456';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`); };
const gw = spawn(process.execPath, ['server/server.mjs'], { cwd: app, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', JARVIS_DATA: data, JARVIS_PASSWORD: PASS, NODE_OPTIONS: '--max-old-space-size=512' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', exited = null;
gw.stdout.on('data', (d) => { log += d; });
gw.stderr.on('data', (d) => { log += d; });
gw.on('exit', (code) => { exited = code; });
const get = async (p, init) => { try { return await fetch(`http://127.0.0.1:${PORT}${p}`, init); } catch { return null; } };
let health = null;
for (let i = 0; i < 60 && exited === null && !health?.ok; i++) { await new Promise((r) => setTimeout(r, 500)); health = await get('/api/health'); }
try {
  check('安装包装完依赖后服务器能启动', exited === null && !!health?.ok, exited !== null ? `进程退出（${exited}）：${log.slice(-600)}` : log.slice(-300));
  const page = await get('/');
  check('网页能打开', !!page?.ok && /<html/i.test(await page.text()));
  const login = await get('/api/server/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
  check('能登录', !!login?.ok, login ? login.status : '无响应');
} finally {
  gw.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
const passed = results.filter(Boolean).length;
console.log(`\n服务器安装包 ${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
