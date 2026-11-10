/**
 * 用已确认形象首格生成logo.svg及各端图标：node scripts/make-icons.mjs
 * CI以 --check 只读核对源素材和实际图标像素，防止换了头像却漏发安装图标。
 *   desktop/build/icon.png                     电脑版安装包和窗口图标（1024×1024，白色圆角底）
 *   android/.../mipmap-*\/ic_launcher*.png     安卓桌面图标（普通、圆形、自适应前景）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from '../node_modules/playwright/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checking = process.argv.includes('--check');
const source = fs.readFileSync(path.join(root, 'src/ui/mascot-approved.webp'));
const sourceHash = createHash('sha256').update(source).digest('hex');
let logo;
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
try {
  // 与mascot.css的4×3动作表一致；只裁首格，不拉伸、重绘或重新生成角色。
  const frame = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = img.naturalWidth / 4, height = img.naturalHeight / 3;
    if (!Number.isInteger(width) || width !== height) throw new Error('已确认角色必须是4×3正方形图集');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height, 0, 0, width, height);
    return { size: width, png: canvas.toDataURL('image/png') };
  }, `data:image/webp;base64,${source.toString('base64')}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${frame.size} ${frame.size}" data-source-sha256="${sourceHash}"><title>未央</title><desc>mascot-approved.webp 首格；由 scripts/make-icons.mjs 生成</desc><image width="${frame.size}" height="${frame.size}" xlink:href="${frame.png}"/></svg>\n`;
  const svgFile = path.join(root, 'src/ui/logo.svg');
  logo = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  if (checking) {
    const saved = fs.readFileSync(svgFile, 'utf8');
    if (!saved.includes(`data-source-sha256="${sourceHash}"`)) throw new Error('logo.svg源素材已过期，请运行node scripts/make-icons.mjs');
    await checkPixels(svgFile, Buffer.from(svg), 'image/svg+xml');
  } else fs.writeFileSync(svgFile, svg);
  for (const [file, w, h, opt] of jobs) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<html><body style="margin:0;background:transparent">${icon(w, h, opt)}</body></html>`);
    await page.locator('img').evaluate((img) => img.decode());
    const png = await page.locator('body > div').screenshot({ omitBackground: true });
    if (checking) await checkPixels(file, png, 'image/png');
    else fs.writeFileSync(file, png);
  }
} finally {
  await browser.close();
}
console.log(`${checking ? '已核对' : '已生成'} logo.svg 和 ${jobs.length} 张图标（已确认形象 ${sourceHash.slice(0, 12)}）`);

async function checkPixels(file, expected, mime) {
  const actual = fs.readFileSync(file);
  if (actual.equals(expected)) return;
  // PNG压缩可以随运行平台变化，按解码后的RGBA逐像素比较，不放宽视觉一致性。
  const equal = await page.evaluate(async ({ images }) => {
    const decoded = await Promise.all(images.map(async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    }));
    const [a, b] = decoded;
    return a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);
  }, { images: [actual, expected].map((bytes) => `data:${mime};base64,${bytes.toString('base64')}`) });
  if (!equal) throw new Error(`${path.relative(root, file)}与当前形象不一致，请运行node scripts/make-icons.mjs`);
}
