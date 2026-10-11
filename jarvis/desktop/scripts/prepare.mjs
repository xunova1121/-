/**
 * 打包前准备：构建网页（如有改动），把 dist / server / shared 复制到 desktop/bundle/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const app = path.join(desktop, 'bundle');

execSync('node scripts/ensure-build.mjs', { cwd: root, stdio: 'inherit' });
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
for (const dir of ['dist', 'server', 'shared']) fs.cpSync(path.join(root, dir), path.join(app, dir), { recursive: true });
// shared/*.js 是 ES 模块
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
console.log('桌面版资源已就绪：', app);
