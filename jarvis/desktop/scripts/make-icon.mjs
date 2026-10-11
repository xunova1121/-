/** 生成应用图标 build/icon.png（1024×1024）：深色圆角底 + 发光光核 + 一双眼睛 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../node_modules/playwright/index.mjs';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build/icon.png');
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#0d2236"/><stop offset="1" stop-color="#03070d"/></radialGradient>
    <radialGradient id="core" cx="45%" cy="38%" r="65%"><stop offset="0" stop-color="#bff3ff"/><stop offset=".35" stop-color="#38bdf8"/><stop offset=".8" stop-color="#0b5f8c"/><stop offset="1" stop-color="#062b44"/></radialGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset=".55" stop-color="#38bdf8" stop-opacity=".55"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="none" stroke="#38bdf8" stroke-opacity=".35" stroke-width="6"/>
  <circle cx="512" cy="500" r="330" fill="url(#glow)"/>
  <circle cx="512" cy="500" r="292" fill="none" stroke="#7dd3fc" stroke-opacity=".55" stroke-width="5" stroke-dasharray="40 22"/>
  <circle cx="512" cy="500" r="230" fill="url(#core)"/>
  <ellipse cx="452" cy="492" rx="30" ry="46" fill="#fff" filter="url(#blur)"/>
  <ellipse cx="572" cy="492" rx="30" ry="46" fill="#fff" filter="url(#blur)"/>
  <ellipse cx="452" cy="492" rx="24" ry="40" fill="#fff"/>
  <ellipse cx="572" cy="492" rx="24" ry="40" fill="#fff"/>
  <ellipse cx="512" cy="840" rx="210" ry="34" fill="none" stroke="#38bdf8" stroke-opacity=".8" stroke-width="10"/>
  <ellipse cx="512" cy="840" rx="290" ry="50" fill="none" stroke="#38bdf8" stroke-opacity=".35" stroke-width="5"/>
</svg>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
await p.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await p.locator('svg').screenshot({ path: out, omitBackground: true });
await b.close();
console.log('图标已生成：', out);
