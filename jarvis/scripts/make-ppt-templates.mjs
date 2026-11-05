/**
 * 生成 PPT 模板库的配图和缩略图（改了 src/agent/pptTemplates.js 或排版引擎后重跑，产物提交进仓库）：
 *   1. src/agent/pptTemplateArt.js 的原创插画按模板配色画成 PNG（只用于生成样张；App 里用同一份代码在设备上现画，不打包图片）
 *   2. 用未央自己的排版引擎按样例内容生成 PPTX → LibreOffice 转 PDF → 前 3 页转 JPG → src/assets/ppt-templates/<模板>-<页>.jpg（打包进三端）
 * 需要 Playwright 自带的 Chromium、soffice、pdftoppm。用法：node scripts/make-ppt-templates.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PPT_TEMPLATES } from '../src/agent/pptTemplates.js';
import { THEMES, REPORT_THEMES } from '../src/agent/themes.js';
import { makePptx } from '../src/agent/pptxWriter.js';
import { artSvg } from '../src/agent/pptTemplateArt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/assets/ppt-templates');
const tmp = path.join(os.tmpdir(), 'weiyang-ppt-templates');
await mkdir(out, { recursive: true });
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
let problems = 0;
try {
  for (const tpl of PPT_TEMPLATES) {
    const theme = THEMES[tpl.theme] || REPORT_THEMES[tpl.theme];
    if (!theme) throw new Error(`${tpl.id}：没有配色 ${tpl.theme}`);
    const images = {};
    for (const [name, motif] of tpl.art) {
      await page.setContent(`<html><body style="margin:0">${artSvg(motif, theme.colors).replace(/width="1600" height="900"/, 'width="1200" height="675"')}</body></html>`);
      const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 675 } });
      images[`art/${name}`] = new Uint8Array(png);
    }
    const { blob, info } = await makePptx({ title: tpl.name, content: tpl.sample, theme, style: tpl.style, author: '未央 · 模板样例', date: '2026年11月', loadImage: async (src) => images[src] || null });
    const errors = info.layoutIssues.filter((x) => x.level === 'error');
    if (errors.length || info.missingImages.length) { problems++; console.log(`✗ ${tpl.id} 排版错误 ${errors.length}、缺图 ${info.missingImages.length}`, errors.slice(0, 2)); }
    const pptx = path.join(tmp, `${tpl.id}.pptx`);
    await writeFile(pptx, Buffer.from(await blob.arrayBuffer()));
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tmp, pptx], { stdio: 'ignore', timeout: 120000 });
    execFileSync('pdftoppm', ['-jpeg', '-jpegopt', 'quality=78', '-r', '48', '-f', '1', '-l', '3', path.join(tmp, `${tpl.id}.pdf`), path.join(tmp, tpl.id)], { timeout: 60000 });
    for (let n = 1; n <= 3; n++) {
      const from = [`${tpl.id}-${n}.jpg`, `${tpl.id}-0${n}.jpg`].map((f) => path.join(tmp, f));
      const src = await Promise.any(from.map(async (f) => (await readFile(f), f))).catch(() => null);
      if (!src) { problems++; console.log(`✗ ${tpl.id} 第${n}页没转出来`); continue; }
      await rename(src, path.join(out, `${tpl.id}-${n}.jpg`));
    }
    console.log(`✓ ${tpl.id} ${tpl.name}：${info.slides}页 ${info.layouts.join('/')}`);
  }
} finally {
  await browser.close();
}
process.exit(problems ? 1 : 0);
