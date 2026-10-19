/**
 * 用 src/ui/logo.svg 生成各端图标（改了 logo 后运行一次：node scripts/make-icons.mjs）
 *   desktop/build/icon.png                     电脑版安装包和窗口图标（1024×1024，白色圆角底）
 *   android/.../mipmap-*\/ic_launcher*.png     安卓桌面图标（普通、圆形、自适应前景）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../node_modules/playwright/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logo = `data:image/svg+xml;base64,${fs.readFileSync(path.join(root, 'src/ui/logo.svg')).toString('base64')}`;
const res = path.join(root, 'android/app/src/main/res');

/** 一张图：size 宽高，shape 底的形状（square 圆角方 / circle 圆 / none 透明），scale logo 占宽度的比例 */
const icon = (w, h, { shape = 'square', scale = 0.72, title = false } = {}) => `
<div style="width:${w}px;height:${h}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(Math.min(w, h) * 0.04)}px;
  background:${shape === 'none' ? 'transparent' : '#fff'};border-radius:${shape === 'circle' ? '50%' : shape === 'square' ? '22%' : '0'};
  ${shape === 'square' || shape === 'circle' ? `box-shadow:inset 0 0 0 ${Math.max(1, w / 256)}px #e3eef2;` : ''}">
  <img src="${logo}" style="width:${Math.round(Math.min(w, h) * scale)}px">
  ${title ? `<div style="font:700 ${Math.round(Math.min(w, h) * 0.11)}px 'Noto Sans CJK SC','Microsoft YaHei',sans-serif;color:#0b4f73;letter-spacing:.08em">未央</div>
  <div style="font:600 ${Math.round(Math.min(w, h) * 0.045)}px 'Segoe UI',sans-serif;color:#22b8b0;letter-spacing:.12em">WEIYANG AI</div>` : ''}
</div>`;

const jobs = [[path.join(root, 'desktop/build/icon.png'), 1024, 1024, { scale: 0.74 }]];
const dpi = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(dpi)) {
  const dir = path.join(res, `mipmap-${d}`);
  jobs.push([path.join(dir, 'ic_launcher.png'), 48 * k, 48 * k, { scale: 0.76 }]);
  jobs.push([path.join(dir, 'ic_launcher_round.png'), 48 * k, 48 * k, { shape: 'circle', scale: 0.7 }]);
  jobs.push([path.join(dir, 'ic_launcher_foreground.png'), 108 * k, 108 * k, { shape: 'none', scale: 0.56 }]); // 自适应图标只保证中间 66/108 可见
}

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage();
for (const [file, w, h, opt] of jobs) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:transparent">${icon(w, h, opt)}</body></html>`);
  await page.locator('body > div').screenshot({ path: file, omitBackground: true });
}
await browser.close();
console.log(`已生成 ${jobs.length} 张图标`);
