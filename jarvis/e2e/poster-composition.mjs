/** 真实工具/工作区/中英文字体/浏览器像素/LibreOffice；合成底图不是外部GPT图像验收，也不是安卓或Windows真机。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { createPosterTool } from '../src/agent/posterTool.js';
import { composePosterLayout } from '../src/agent/posterComposition.js';
import { renderPoster } from '../server/posterRaster.mjs';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';
import { backgroundSvg, samples, fixtureHtml, inspectImage } from './fixtures/poster-composition.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || '/tmp/weiyang-poster-composition');
const revisionOnly = process.argv.includes('--revision-only');
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-poster-store-'));
await fs.mkdir(output, { recursive: true });
await fs.rm(path.join(output, 'failure.json'), { force: true });
useBackend(createFileStore(store));
const checks = [], products = [];
const check = (label, predicate, detail) => {
  checks.push({ label, pass: Boolean(predicate), ...(detail === undefined ? {} : { detail }) });
  console.log(`${predicate ? '✓' : '✗'} ${label}`);
  assert.ok(predicate, `${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
};
const dataUrl = (bytes, mime) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const saveJson = (file, value) => fs.writeFile(path.join(output, file), JSON.stringify(value, null, 2));
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'poster-e2e-fixture', configureServer(vite) {
    vite.middlewares.use('/__poster.html', (_req, res) => {
      res.setHeader('Content-Type', 'text/html;charset=utf-8');
      res.end(fixtureHtml);
    });
  } }]
});
let browser;

async function screenshot(page, imageUrl, filename, description) {
  await page.evaluate(async ({ imageUrl, description }) => {
    const img = document.querySelector('#preview');
    img.src = imageUrl;
    await img.decode();
    document.querySelector('#description').textContent = description;
  }, { imageUrl, description });
  await page.screenshot({ path: path.join(output, filename), fullPage: true });
}

function verifyPixels(label, result, sample, layout) {
  check(`${label}：PNG解码尺寸精确`, result.width === sample.width && result.height === sample.height);
  check(`${label}：与实际SVG渲染像素吻合`, result.differentRatio < 0.025, result.differentRatio);
  check(`${label}：每行中文在成品中有真实字形`, result.rowPixels.every(row => row.ink > 40 && row.ink > row.referenceInk * 0.65 && row.mismatch < 0.4), result.rowPixels);
  check(`${label}：全文未删字`, result.textBounds.map(row => row.text).join('') === layout.blocks.flatMap(block => block.rows.map(row => row.text)).join(''));
  // getBBox包含字体行框的上升/下降留白；安全区须核对真正着色的像素边界。
  const inSafeArea = box => box.x >= layout.inner.x - 1 && box.y >= layout.inner.y - 1 && box.x + box.width <= layout.inner.x + layout.inner.w + 1 && box.y + box.height <= layout.inner.y + layout.inner.h + 1;
  check(`${label}：实际字形在安全文字区域内`, inSafeArea(result.paintedBounds) && result.rowPixels.every(row => inSafeArea(row.bounds)), result.paintedBounds);
}

async function makeNodeProduct(page, sample) {
  const changed = [], checkpoints = [];
  const tool = createPosterTool({ renderPoster, onFileChanged: file => changed.push(file) });
  const input = { ...sample, background_path: '底图/原创秋日汤碗.png', path: `海报/${sample.id}.png` };
  delete input.id;
  const receipt = JSON.parse(await tool.run(input, { checkpoint: item => checkpoints.push(item) }));
  await saveJson(`${sample.id}.json`, { input, receipt, checkpoints });
  check(`${sample.id}：真实Node工具完整交付`, receipt.status === 'complete' && receipt.files.length === 3 && receipt.fontCheck === 'passed', receipt);
  check(`${sample.id}：读回通过但视觉状态仍未虚报`, receipt.visual === 'not_checked' && receipt.files.every(file => file.readback === 'passed') && changed.length === 4 && changed.includes(receipt.designPath));
  const design = JSON.parse(await ws.readText(receipt.designPath));
  await saveJson(`${sample.id}.poster.json`, design);
  check(`${sample.id}：小型设计文件保留底图指纹和准确尺寸`, design.kind === 'poster-design' && design.options.width === sample.width && design.options.height === sample.height && design.backgroundHash && JSON.stringify(design).length < 40000);
  const files = {};
  for (const file of receipt.files) {
    files[file.format] = await ws.readBlob(file.path);
    await fs.writeFile(path.join(output, `${sample.id}.${file.format}`), new Uint8Array(await files[file.format].arrayBuffer()));
  }
  const svg = await files.svg.text();
  const layout = composePosterLayout(input);
  if (sample.id === 'portrait-bottom-sans') check('1024×1536文字区严格位于下方三分之一', layout.panel.x === 0 && layout.panel.y === 1024 && layout.panel.w === 1024 && layout.panel.h === 512);
  if (sample.id === 'landscape-left-sans') check('横版文字区位于左栏', layout.panel.x === 0 && layout.panel.y === 0 && Math.abs(layout.panel.w - 614.4) < 0.001 && layout.panel.h === 1024);
  const rows = layout.blocks.flatMap(block => block.rows);
  const imageUrl = dataUrl(await files.png.arrayBuffer(), 'image/png');
  const pixels = await page.evaluate(inspectImage, { imageUrl, svg, rows, width: sample.width, height: sample.height });
  await saveJson(`${sample.id}-pixels.json`, pixels);
  await screenshot(page, imageUrl, `${sample.id}-screen.png`, `${sample.title}｜${sample.width}×${sample.height}｜真实Node成品，合成底图`);
  verifyPixels(sample.id, pixels, sample, layout);
  const zip = await JSZip.loadAsync(await files.pptx.arrayBuffer());
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  check(`${sample.id}：PPTX文字可编辑`, /<a:t>/.test(slide) && slide.includes(sample.font_family === 'serif' ? 'Noto Serif CJK SC' : 'Noto Sans CJK SC'));
  const product = { sample, layout, svg, files, pixels, receipt, design };
  products.push(product);
  return product;
}

async function verifyRevision(page, original) {
  const digest = async file => createHash('sha256').update(new Uint8Array(await (await ws.readBlob(file)).arrayBuffer())).digest('hex');
  const paths = [...original.receipt.files.map(file => file.path), original.receipt.designPath, original.design.options.background_path];
  const before = Object.fromEntries(await Promise.all(paths.map(async file => [file, await digest(file)])));
  let modelCalls = 0;
  const tool = createPosterTool({ renderPoster, imageGen: async () => { modelCalls++; throw new Error('改标题不应调用图片模型'); } });
  const receipt = JSON.parse(await tool.run({ source_path: original.receipt.designPath, title: '冬日暖心汤' }));
  await saveJson('revision.json', receipt);
  check('改标题仍完整交付原画幅', receipt.status === 'complete' && receipt.width === 1024 && receipt.height === 1536, receipt);
  check('改标题另存，旧三格式和设计文件不覆盖', receipt.files.every(file => !paths.includes(file.path)) && !paths.includes(receipt.designPath));
  const design = JSON.parse(await ws.readText(receipt.designPath));
  await saveJson('revision.poster.json', design);
  check('改标题复用相同无字底图和排版参数', design.backgroundHash === original.design.backgroundHash && design.options.background_path === original.design.options.background_path && design.options.text_position === 'bottom' && design.options.text_fraction === 1 / 3 && design.options.font_family === 'sans');
  const files = {};
  for (const file of receipt.files) {
    files[file.format] = await ws.readBlob(file.path);
    await fs.writeFile(path.join(output, `revision.${file.format}`), new Uint8Array(await files[file.format].arrayBuffer()));
  }
  const svg = await files.svg.text(), layout = composePosterLayout(design.options);
  check('改稿保留全文，只换指定主标题', svg.includes('冬日暖心汤') && !svg.includes('秋季养生汤') && design.options.subtitle === original.sample.subtitle && JSON.stringify(design.options.lines) === JSON.stringify(original.sample.lines) && design.options.footer === original.sample.footer);
  const imageUrl = dataUrl(await files.png.arrayBuffer(), 'image/png');
  const pixels = await page.evaluate(inspectImage, { imageUrl, svg, rows: layout.blocks.flatMap(block => block.rows), width: 1024, height: 1536 });
  await saveJson('revision-pixels.json', pixels);
  verifyPixels('改标题实际PNG', pixels, { width: 1024, height: 1536 }, layout);
  await screenshot(page, imageUrl, 'revision-screen.png', '冬日暖心汤｜只修改标题，复用原无字底图；没有再次调用图片模型');
  const unchanged = await page.evaluate(async ({ previous, current }) => {
    const decode = async url => {
      const img = new Image(); img.src = url; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1536;
      const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
      return context.getImageData(0, 0, 1024, 1536).data;
    };
    const left = await decode(previous), right = await decode(current);
    let backgroundDifferences = 0, titleDifferences = 0;
    for (let at = 0; at < left.length; at++) if (left[at] !== right[at]) {
      if (at < 1024 * 1024 * 4) backgroundDifferences++; else titleDifferences++;
    }
    return { backgroundDifferences, titleDifferences };
  }, { previous: dataUrl(await original.files.png.arrayBuffer(), 'image/png'), current: imageUrl });
  check('改稿PNG上方底图实际像素完全未变、标题像素确实改变', unchanged.backgroundDifferences === 0 && unchanged.titleDifferences > 1000, unchanged);
  for (const file of paths) check(`旧文件SHA256保持：${file}`, await digest(file) === before[file]);
  check('改标题未调用图片模型', modelCalls === 0);
  await saveJson('revision-integrity.json', { before, modelCalls, pixels: unchanged });
}

async function verifyBrowserProduct(base, sample, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage(), pageErrors = [], external = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route(/^https?:\/\//, route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  try {
    await page.goto(`${base}/__poster.html`);
    const product = products.find(item => item.sample.id === sample.id);
    const input = { ...sample, background_path: '底图/原创秋日汤碗.png', path: `浏览器/${sample.id}.png` };
    delete input.id;
    const background = await fs.readFile(path.join(output, 'synthetic-background.png'));
    const result = await page.evaluate(async ({ input, background }) => {
      const { createPosterTool } = await import('/src/agent/posterTool.js');
      const workspace = await import('/src/agent/workspace.js');
      await workspace.write(input.background_path, new Blob([Uint8Array.from(atob(background), char => char.charCodeAt(0))], { type: 'image/png' }));
      const receipt = JSON.parse(await createPosterTool().run(input));
      const file = receipt.files.find(item => item.format === 'png');
      if (!file) return { receipt };
      const bytes = new Uint8Array(await (await workspace.readBlob(file.path)).arrayBuffer());
      let binary = '';
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      return { receipt, png: btoa(binary) };
    }, { input, background: background.toString('base64') });
    const label = viewport.width < 600 ? 'mobile' : 'web';
    await saveJson(`${label}-receipt.json`, result.receipt);
    check(`${label}：浏览器专用渲染和字体检查通过`, result.receipt.status === 'complete' && result.receipt.fontCheck === 'passed', result.receipt);
    await fs.writeFile(path.join(output, `${label}.png`), Buffer.from(result.png, 'base64'));
    const imageUrl = `data:image/png;base64,${result.png}`;
    const pixels = await page.evaluate(inspectImage, { imageUrl, svg: product.svg, rows: product.layout.blocks.flatMap(block => block.rows), width: sample.width, height: sample.height });
    verifyPixels(label, pixels, sample, product.layout);
    await screenshot(page, imageUrl, `${label}-screen.png`, `${sample.title}｜${viewport.width}px视口｜浏览器专用渲染，非真机`);
    check(`${label}：页面没有横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    check(`${label}：没有外部请求或页面异常`, !external.length && !pageErrors.length, { external, pageErrors });
    const failures = await page.evaluate(async svg => {
      const { renderPoster } = await import('/src/agent/posterRaster.js');
      const errorCode = async (source, options) => { try { await renderPoster(source, options); return 'unexpected_success'; } catch (error) { return error.name === 'AbortError' ? error.name : error.code || error.name; } };
      const controller = new AbortController();
      controller.abort();
      return {
        external: await errorCode(svg.replace(/href="[^"]+"/, 'href="https://example.invalid/private.png"')),
        missingGlyph: await errorCode(svg.replace(/(<text\b[^>]*>)[\s\S]*?(<\/text>)/, `$1${String.fromCodePoint(0x10ffff)}$2`)),
        aborted: await errorCode(svg, { signal: controller.signal })
      };
    }, product.svg);
    await saveJson(`${label}-failures.json`, failures);
    check(`${label}：外部图片引用拒绝`, failures.external === 'POSTER_UNSAFE', failures);
    check(`${label}：真实缺字拒绝`, failures.missingGlyph === 'POSTER_FONT_GLYPHS_MISSING', failures);
    check(`${label}：取消不转成成品`, failures.aborted === 'AbortError');
    check(`${label}：拒绝外部引用时没有发起请求`, external.length === 0, external);
  } finally { await context.close(); }
}

async function verifyOffice(page, product) {
  check('LibreOffice真实渲染可用', await officeRenderAvailable());
  const rendered = await renderOffice(product.files.pptx, 'pptx');
  check('PPTX实际转换PDF成功', rendered.available && rendered.blob?.size > 1000);
  const bytes = new Uint8Array(await rendered.blob.arrayBuffer());
  await fs.writeFile(path.join(output, 'office-portrait.pdf'), bytes);
  const result = await page.evaluate(async ({ bytes, width }) => {
    const pdfjs = await import('/node_modules/pdfjs-dist/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';
    const documentPdf = await pdfjs.getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false }).promise;
    try {
      const pdfPage = await documentPdf.getPage(1);
      const natural = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: width / natural.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const content = await pdfPage.getTextContent();
      return { pages: documentPdf.numPages, width: canvas.width, height: canvas.height, points: { width: natural.width, height: natural.height }, text: content.items.map(item => item.str).join(''), png: canvas.toDataURL('image/png') };
    } finally { await documentPdf.destroy(); }
  }, { bytes: [...bytes], width: product.sample.width });
  await fs.writeFile(path.join(output, 'office-portrait.png'), Buffer.from(result.png.split(',')[1], 'base64'));
  await saveJson('office-portrait.json', { ...result, png: undefined });
  await screenshot(page, result.png, 'office-portrait-screen.png', '真实LibreOffice：PPTX → PDF → 浏览器渲染；尺寸和全文逐项核对');
  check('Office为单页原画幅', result.pages === 1 && result.width === 1024 && result.height === 1536, result.points);
  for (const text of [product.sample.title, product.sample.subtitle, ...product.sample.lines, product.sample.footer])
    check(`Office全文保留：${text}`, result.text.replace(/\s/g, '').includes(text.replace(/\s/g, '')));
  const pixels = await page.evaluate(inspectImage, { imageUrl: result.png, svg: product.svg, rows: product.layout.blocks.flatMap(block => block.rows), width: product.sample.width, height: product.sample.height });
  await saveJson('office-portrait-pixels.json', pixels);
  check('Office与PNG的底图裁切、面板位置和字形整体一致', pixels.differentRatio < 0.035, pixels.differentRatio);
  check('Office每行均实际显示，位置无大幅偏移', pixels.rowPixels.every((row, index) => row.ink > 40 && row.ink > row.referenceInk * 0.65 && Math.abs(row.bounds.y - product.pixels.rowPixels[index].bounds.y) <= 12), pixels.rowPixels);
}

async function verifyServerFailures(svg) {
  await assert.rejects(renderPoster(svg.replace(/href="[^"]+"/, 'href="https://example.invalid/private.png"')), { code: 'POSTER_UNSAFE' });
  check('服务器拒绝外部href', true);
  await assert.rejects(renderPoster(svg.replace(/(<text\b[^>]*>)[\s\S]*?(<\/text>)/, `$1${String.fromCodePoint(0x10ffff)}$2`)), { code: 'POSTER_FONT_GLYPHS_MISSING' });
  check('服务器真实字体检测拒绝缺字', true);
  const receipt = JSON.parse(await createPosterTool({ renderPoster: async () => { throw Object.assign(new Error('private renderer detail'), { code: 'POSTER_RENDER_UNAVAILABLE' }); } }).run({ title: '失败保留源文件', width: 1024, height: 1536, path: '故障/保留源文件.png' }));
  await saveJson('render-failure.json', receipt);
  check('渲染失败明确partial，无成品PNG，保留两种源文件', receipt.status === 'partial' && receipt.files.length === 2 && !receipt.files.some(file => file.format === 'png') && receipt.errors[0].code === 'POSTER_RENDER_UNAVAILABLE' && !JSON.stringify(receipt).includes('private renderer detail'), receipt);
  await assert.rejects(createPosterTool({ renderPoster }).run({ title: '完整保留不截字'.repeat(100), width: 256, height: 256, text_fraction: 0.15, path: '故障/文字溢出.png' }), { code: 'POSTER_TEXT_OVERFLOW' });
  check('放不下的全文明确失败，不截字', true);
}

try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  await page.goto(`${base}/__poster.html`);
  const fixture = await page.evaluate(async svg => {
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${btoa(svg)}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }, backgroundSvg);
  const background = Buffer.from(fixture, 'base64');
  await fs.writeFile(path.join(output, 'synthetic-background.png'), background);
  await ws.write('底图/原创秋日汤碗.png', new Blob([background], { type: 'image/png' }));
  for (const sample of revisionOnly ? samples.slice(0, 1) : samples) await makeNodeProduct(page, sample);
  await verifyRevision(page, products[0]);
  if (!revisionOnly) {
    await verifyServerFailures(products[0].svg);
    await verifyBrowserProduct(base, samples[0], { width: 1280, height: 960 });
    await verifyBrowserProduct(base, samples[2], { width: 390, height: 844 });
    await verifyOffice(page, products[0]);
  }
  check('底图原件字节保持', Buffer.from(await (await ws.readBlob('底图/原创秋日汤碗.png')).arrayBuffer()).equals(background));
  console.log(`中文海报 ${checks.length}/${checks.length} 通过；底图为原创合成夹具，未调用真实GPT图片模型；用户服务器、安卓和Windows真机未测。产物：${output}`);
} catch (error) {
  await saveJson('failure.json', { message: error.message, stack: error.stack });
  console.error(error);
  process.exitCode = 1;
} finally {
  await saveJson('checks.json', { checks, passed: checks.filter(item => item.pass).length, total: checks.length, modelCalls: 0, syntheticBackground: true, realDevice: false, scope: revisionOnly ? 'revision-only' : 'full' });
  await browser?.close();
  await server.close();
  useBackend(null);
  await fs.rm(store, { recursive: true, force: true });
}
