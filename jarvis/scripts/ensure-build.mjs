/**
 * 启动脚本用：依赖缺失或 package-lock 更新过 → npm install；源码比构建产物新 → 重新构建。
 * 这样拉取新版本后双击 启动.bat / start.sh 就能直接用上新功能。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
function newest(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(0, ...fs.readdirSync(p).map((n) => newest(path.join(p, n))));
}
const run = (cmd, msg) => { console.log(msg); execSync(cmd, { cwd: root, stdio: 'inherit' }); };

const installed = mtime(path.join(root, 'node_modules/.package-lock.json'));
if (!installed || mtime(path.join(root, 'package-lock.json')) > installed) run('npm install --no-audit --no-fund', '正在安装 / 更新依赖……');

const built = mtime(path.join(root, 'dist/index.html'));
const source = Math.max(...['src', 'shared', 'index.html', 'vite.config.js', 'package.json'].map((p) => newest(path.join(root, p))));
if (!built || source > built) run('npm run build', '正在构建最新版本……');
