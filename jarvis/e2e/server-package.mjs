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
fs.chmodSync(work, 0o755); fs.chmodSync(app, 0o755); // 让后面“非属主服务账号”检查能进目录
execFileSync('tar', ['-xzf', pkg, '-C', app, '--strip-components=1']);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, stdio: 'inherit' });

const PORT = 8823, PASS = 'pkg-check-123456';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`); };

// 1.0.419 事故回归：包里文件曾是 0600/0700，root 安装后 jarvis 服务账号读不了。
// 直接看归档记录的权限：每一项都要所有人可读（目录还要可进），且组/其他人不可写。
const archive = execFileSync('tar', ['-tvzf', pkg], { encoding: 'utf8' }).trim().split('\n');
const badModes = archive.filter((line) => {
  const mode = line.trim().split(/\s+/)[0];
  if (!/^[-dl]/.test(mode)) return true;
  if (mode[0] === 'l') return false; // 符号链接权限无意义
  return mode[7] !== 'r' || mode[5] === 'w' || mode[8] === 'w' || (mode[0] === 'd' && !/[xt]/.test(mode[9]));
});
check('包内每个文件对所有账号可读（防再出 0600 打包）', archive.length > 0 && !badModes.length, badModes.slice(0, 3).join(' | '));
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
  gw.kill();

  // 1.0.419 事故回归：真实部署是 root 装、jarvis 账号跑，文件属主和服务账号不同。
  // 这里换成 nobody 账号（同样不是文件属主）再启动一次，仅 owner 能启动不算过。
  const sudo = (args) => execFileSync('sudo', ['-n', ...args], { encoding: 'utf8' });
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  let sudoOk = asRoot;
  if (!asRoot) { try { sudo(['true']); sudoOk = true; } catch { /* 本机没有免密 sudo：跳过并明确标记 */ } }
  if (process.platform !== 'linux' || !sudoOk) {
    console.log('- 非属主服务账号启动检查跳过（需要 Linux 且 root 或免密 sudo）；发版 CI 上必须执行');
  } else {
    const run = asRoot ? (args) => execFileSync(args[0], args.slice(1), { encoding: 'utf8' }) : sudo;
    const data2 = path.join(work, 'data2');
    fs.mkdirSync(data2);
    run(['chown', '-R', 'root:root', app]);
    run(['chown', '-R', 'nobody', data2]);
    const PORT2 = 8824;
    const envArgs = ['env', `PORT=${PORT2}`, 'HOST=127.0.0.1', `JARVIS_DATA=${data2}`, `JARVIS_PASSWORD=${PASS}`, `HOME=${data2}`, 'NODE_OPTIONS=--max-old-space-size=512', process.execPath, 'server/server.mjs'];
    const svc = asRoot
      ? spawn(envArgs[0], envArgs.slice(1), { cwd: app, uid: Number(execFileSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).trim()), gid: Number(execFileSync('id', ['-g', 'nobody'], { encoding: 'utf8' }).trim()), stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('sudo', ['-n', '-u', 'nobody', ...envArgs], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
    let log2 = '', exited2 = null;
    svc.stdout.on('data', (d) => { log2 += d; });
    svc.stderr.on('data', (d) => { log2 += d; });
    svc.on('exit', (code) => { exited2 = code; });
    const get2 = async (p, init) => { try { return await fetch(`http://127.0.0.1:${PORT2}${p}`, init); } catch { return null; } };
    try {
      let health2 = null;
      for (let i = 0; i < 60 && exited2 === null && !health2?.ok; i++) { await new Promise((r) => setTimeout(r, 500)); health2 = await get2('/api/health'); }
      check('root 安装、非属主账号(nobody)也能启动', exited2 === null && !!health2?.ok, exited2 !== null ? `进程退出（${exited2}）：${log2.slice(-500)}` : log2.slice(-200));
      const page2 = await get2('/');
      check('非属主账号下网页能打开', !!page2?.ok && /<html/i.test(await page2.text()));
      const login2 = await get2('/api/server/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
      check('非属主账号下能登录', !!login2?.ok, login2 ? login2.status : '无响应');
    } finally {
      if (asRoot) svc.kill(); else { try { sudo(['pkill', '-f', `PORT=${PORT2}`]); } catch { svc.kill(); } }
      try { run(['chown', '-R', `${process.getuid?.() ?? 0}`, work]); } catch { /* 清理失败不影响结论 */ }
    }
  }
} finally {
  try { gw.kill(); } catch { /* 已退出 */ }
  fs.rmSync(work, { recursive: true, force: true });
}
const passed = results.filter(Boolean).length;
console.log(`\n服务器安装包 ${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
