/**
 * 生成 PPT 用的图标（src/agent/pptIcons.js）：把 Lucide 图标（ISC 许可）画成白色线条的透明 PNG，存成 Base64。
 * PPT 里先画一个彩色圆，再把白色图标叠在上面；PNG 在电脑、手机、测试里都能直接用，不用运行时再转换。
 *
 * 用法（只在要增减图标时运行一次，生成的文件提交进仓库）：
 *   npm pack lucide-static@0.577.0 && tar xzf lucide-static-0.577.0.tgz
 *   node scripts/make-ppt-icons.mjs ./package
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PPT_ICON_CATALOG } from '../src/agent/pptIconCatalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = process.argv[2];
if (!pkg) { console.error('用法：node scripts/make-ppt-icons.mjs <lucide-static 包目录>'); process.exit(1); }

export const ICONS = Object.keys(PPT_ICON_CATALOG);
const SIZE = 96;

const browser = await chromium.launch();
const page = await browser.newPage();
const out = {};
const darkOut = {};
for (const name of ICONS) {
  const svg = readFileSync(join(pkg, 'icons', `${name}.svg`), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/stroke="currentColor"/, 'stroke="#FFFFFF"')
    .replace(/width="24"/, `width="${SIZE}"`).replace(/height="24"/, `height="${SIZE}"`);
  for (const [color, result] of [['#FFFFFF', out], ['#183153', darkOut]]) {
  result[name] = await page.evaluate(async ([s, size]) => {
    const img = new Image();
    await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`; });
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, 0, 0, size, size);
    return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  }, [svg.replace('#FFFFFF', color), SIZE]);
  }
}
await browser.close();

const body = Object.entries(out).map(([k, v]) => `  '${k}': '${v}'`).join(',\n');
const darkBody = Object.entries(darkOut).map(([k, v]) => `  '${k}': '${v}'`).join(',\n');
writeFileSync(join(ROOT, 'src/agent/pptIcons.js'), `/**
 * PPT 图标：白色线条、透明底的 PNG（${SIZE}×${SIZE}），叠在彩色圆上用。由 scripts/make-ppt-icons.mjs 生成，不要手改。
 * 图标来自 Lucide 0.577.0（https://lucide.dev），ISC 许可；部分源自 Feather（MIT）。许可原文见 jarvis/licenses/lucide-LICENSE.txt。
 */
export const ICON_PNG = {
${body}
};
export const ICON_DARK_PNG = {
${darkBody}
};
`);
copyFileSync(join(pkg, 'LICENSE'), join(ROOT, 'licenses/lucide-LICENSE.txt'));
console.log(`生成 ${ICONS.length} 个图标`);
