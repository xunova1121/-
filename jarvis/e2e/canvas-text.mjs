/** 原图填字全链路：受控像素样张、真实Canvas/字体/PNG/PPTX及浏览器编辑；不冒充用户照片或真实GPT验收。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { serverCanvasRenderer } from '../server/canvasImageText.mjs';
import { createPosterTool } from '../src/agent/posterTool.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { canvasFixture, canvasCopy } from './fixtures/canvas-text.mjs';
import { normalizeCanvasDesign } from '../src/agent/imageTextInput.js';
import { imageInfo } from '../src/agent/imageInfo.js';
import { runAgent } from '../src/agent/agent.js';
import { createTools } from '../src/agent/tools.js';
import { htmlPreviewSandbox } from '../src/ui/htmlPreviewSandbox.js';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-canvas-text');
await fs.mkdir(out, { recursive: true });
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-canvas-store-'));
useBackend(createFileStore(store));
const checks = [],
  receipts = [],
  hash = (value) => createHash('sha256').update(value).digest('hex');
const check = (label, pass, details) => {
  checks.push({ label, pass: Boolean(pass) });
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  assert.ok(pass, label + (details ? ': ' + JSON.stringify(details) : ''));
};
const ctx = {
  canvasRenderer: serverCanvasRenderer,
  renderPoster: () => {
    throw new Error('Canvas路线不得调用SVG渲染');
  },
  renderVisualScene: () => {
    throw new Error('不得用旧SVG路线');
  },
  imageGen: () => {
    throw new Error('不得重新生图');
  }
};
const poster = createPosterTool(ctx),
  demo = createVisualDemoTool(ctx);
let browser;
async function saveArtifacts(name, input, tool = poster) {
  const receipt = JSON.parse(await tool.run({ ...input, path: `Canvas验收/${name}.png` }));
  receipts.push({ name, receipt });
  check(
    name + '：实际PNG/PPTX/HTML/ZIP均读回通过',
    receipt.status === 'complete' && receipt.files.length === 4 && receipt.errors.length === 0,
    receipt
  );
  check(
    name + '：文字框外与保护区零像素改动',
    receipt.backgroundCheck.status === 'passed' &&
      receipt.backgroundCheck.changedOutsideText === 0 &&
      receipt.backgroundCheck.changedInProtected === 0,
    receipt.backgroundCheck
  );
  check(
    name + '：全文按390px整图宽至少12px，不截字',
    receipt.layout.status === 'passed' && receipt.layout.minimumBodyPixels >= 12 && receipt.phonePreview.width === 390
  );
  check(
    name + '：未配置视觉模型不冒称视觉/交互验收',
    receipt.visual === 'not_checked' && receipt.interaction === 'not_checked'
  );
  for (const file of receipt.files)
    await fs.writeFile(
      path.join(out, `${name}.${file.format}`),
      Buffer.from(await (await ws.readBlob(file.path)).arrayBuffer())
    );
  await fs.writeFile(
    path.join(out, `${name}.phone.png`),
    Buffer.from(await (await ws.readBlob(receipt.phonePreview.path)).arrayBuffer())
  );
  const design = JSON.parse(await ws.readText(receipt.designPath));
  await fs.writeFile(path.join(out, `${name}.canvas.json`), JSON.stringify(design, null, 2));
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(out, `${name}.pptx`))),
    xml = await zip.file('ppt/slides/slide1.xml').async('string');
  check(
    name + '：PPTX全标题可独立编辑，没有SVG图片',
    input.canvas?.entries
      ? input.canvas.entries.every((e) => xml.includes(e.title)) &&
          !Object.keys(zip.files).some((f) => /\.svg$/i.test(f))
      : !Object.keys(zip.files).some((f) => /\.svg$/i.test(f))
  );
  return { receipt, design, name };
}
async function editorCheck(item, bundle) {
  const data = await fs.readFile(path.join(out, 'original.png')),
    dataUri = 'data:image/png;base64,' + data.toString('base64');
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // 用压缩后的实际生产函数生成离线HTML，拦住toString闭包在打包后失效的问题。
  const html = await page.evaluate(
    async ({ code, design, dataUri }) => {
      const module = await import('data:text/javascript;base64,' + code);
      return module.createImageTextEditor(design, dataUri);
    },
    { code: Buffer.from(bundle).toString('base64'), design: item.design, dataUri }
  );
  await fs.writeFile(path.join(out, 'minified-editor.html'), html);
  await page.setContent(html);
  await page.waitForSelector('#status[data-state="passed"]');
  check('压缩后的离线编辑器可运行，真实字体与像素检查通过', errors.length === 0, errors);
  await page.screenshot({ path: path.join(out, 'editor-desktop.png'), fullPage: true });
  const original = await page.locator('#box').boundingBox();
  await page.mouse.move(original.x + original.width * 0.6, original.y + original.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(original.x + original.width * 0.6 + 9, original.y + original.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.waitForSelector('#status[data-state="passed"]');
  const moved = await page.locator('#box').boundingBox();
  check('鼠标拖动改变真实文字位置', Math.abs(moved.x - original.x - 9) < 2);
  await page.locator('#title').fill('拖动后仍保留原图');
  await page.waitForTimeout(150);
  await page.waitForSelector('#status[data-state="passed"]');
  const pending = page.waitForEvent('download');
  await page.locator('#source').click();
  const download = await pending;
  const sourceFile = path.join(out, 'editor-modified.canvas.json');
  await download.saveAs(sourceFile);
  const saved = normalizeCanvasDesign(JSON.parse(await fs.readFile(sourceFile, 'utf8')));
  check(
    '编辑保存源稿包含全文/新坐标，原图摘要未变',
    saved.entries[0].title === '拖动后仍保留原图' &&
      saved.regions[0].x > item.design.regions[0].x &&
      saved.image.hash === item.design.image.hash
  );
  const request = page.waitForEvent('download');
  await page.locator('#png').click();
  const result = await request;
  await result.saveAs(path.join(out, 'editor-modified.png'));
  const dimensions = imageInfo(await fs.readFile(path.join(out, 'editor-modified.png')));
  check('编辑器实际导出原尺寸PNG', dimensions.width === item.design.width && dimensions.height === item.design.height);
  await page.locator('#body').fill('超长正文必须完整保留'.repeat(120));
  await page.waitForSelector('#status[data-state="needs_layout"]');
  check('浏览器超长文案禁用最终导出，不缩字不加遮挡', await page.locator('#png').isDisabled());
  await page.locator('#body').fill(canvasCopy[0].body);
  await page.waitForTimeout(150);
  await page.waitForSelector('#status[data-state="passed"]');
  await page.locator('#body').fill('在对照原图时继续编辑');
  await page.locator('#original').check();
  await page.waitForTimeout(250);
  const preserved = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = data;
    await image.decode();
    const actual = document.getElementById('art'),
      expected = document.createElement('canvas');
    expected.width = actual.width;
    expected.height = actual.height;
    expected.getContext('2d').drawImage(image, 0, 0, actual.width, actual.height);
    const before = expected.getContext('2d').getImageData(0, 0, actual.width, actual.height).data;
    const after = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data;
    return before.every((v, i) => v === after[i]);
  }, dataUri);
  check('对照原图期间异步改字不会覆盖原图或误开放导出', preserved && (await page.locator('#png').isDisabled()));
  await page.locator('#body').fill(canvasCopy[0].body);
  await page.locator('#original').uncheck();
  await page.waitForTimeout(150);
  await page.waitForSelector('#status[data-state="passed"]');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#guides').uncheck();
  await page.screenshot({ path: path.join(out, 'editor-mobile.png'), fullPage: true });
  check(
    '手机预览保持原构图且无水平溢出',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
  );
  await page.close();
  const embedded = await browser.newPage();
  await embedded.setContent('<iframe style="width:100%;height:900px"></iframe>');
  await embedded.locator('iframe').evaluate(
    (frame, value) => {
      frame.setAttribute('sandbox', value.policy);
      frame.srcdoc = value.html;
    },
    { html, policy: htmlPreviewSandbox(html) }
  );
  const frame = embedded.frameLocator('iframe');
  await frame.locator('#status[data-state="passed"]').waitFor();
  const exporting = embedded.waitForEvent('download');
  await frame.locator('#png').click();
  const exported = await exporting;
  await exported.saveAs(path.join(out, 'app-preview-export.png'));
  check(
    '未央文件预览同款隔离iframe内也能点击导出PNG',
    (await fs.stat(path.join(out, 'app-preview-export.png'))).size > 1000 &&
      !htmlPreviewSandbox(html).includes('allow-same-origin')
  );
  check(
    '普通HTML预览不增加下载权限',
    htmlPreviewSandbox('<html>普通文件</html>') === 'allow-scripts allow-forms allow-modals'
  );
  await embedded.close();
  await ws.write('Canvas验收/editor-modified.canvas.json', JSON.stringify(saved));
  const noDetect = {
    ...ctx,
    canvasRenderer: {
      ...serverCanvasRenderer,
      inspect: () => {
        throw new Error('改字不重新定位');
      }
    }
  };
  const revised = await saveArtifacts(
    '编辑器源稿再导出',
    { source_path: 'Canvas验收/editor-modified.canvas.json' },
    createPosterTool(noDetect)
  );
  check(
    '编辑器源稿重新进入正式工具，坐标与原图绑定保持',
    revised.design.regions[0].x === saved.regions[0].x && revised.design.image.hash === saved.image.hash
  );
}
async function browserRaster(item, bundle) {
  const page = await browser.newPage(),
    bytes = await fs.readFile(path.join(out, 'original.png'));
  const result = await page.evaluate(
    async ({ code, data, design }) => {
      const module = await import('data:text/javascript;base64,' + code),
        blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: 'image/png' });
      const value = await module.renderCanvasImageText(blob, design);
      return {
        layout: value.layout.status,
        font: value.fontCheck.status,
        background: value.backgroundCheck,
        size: value.blob.size
      };
    },
    { code: Buffer.from(bundle).toString('base64'), data: bytes.toString('base64'), design: item.design }
  );
  check(
    '正式浏览器Canvas与服务端走同一排字引擎，通过真实字体与像素保护',
    result.layout === 'passed' &&
      result.font === 'passed' &&
      result.background.changedOutsideText === 0 &&
      result.background.changedInProtected === 0 &&
      result.size > 1000,
    result
  );
  await page.close();
}
async function callChain() {
  const tools = createTools(ctx);
  let calls = 0,
    delivered;
  const adapter = {
    async stream({ tools: active, messages, onText }) {
      calls++;
      check(
        '实际模型请求可见Canvas schema',
        active.some((t) => t.name === 'make_poster' && t.input_schema.properties.canvas.properties.entries)
      );
      if (calls === 1)
        return {
          text: '',
          toolCalls: [
            {
              id: 'canvas-real',
              name: 'make_poster',
              args: {
                title: '调用链',
                background_path: 'Canvas验收/base.png',
                canvas: { entries: canvasCopy },
                path: 'Canvas验收/调用链.png'
              }
            }
          ],
          stop: 'tool_use'
        };
      const result = messages.filter((m) => m.role === 'tool').at(-1);
      delivered = result?.name === 'make_poster' && JSON.parse(result.content);
      check(
        '真实执行层把Canvas完成回执带到下一次模型请求',
        delivered?.renderer === 'canvas' &&
          delivered.status === 'complete' &&
          delivered.backgroundCheck.changedOutsideText === 0,
        delivered
      );
      const text = '已生成Canvas PNG、可编辑PPTX、编辑HTML和源稿。视觉模型未配置，未做实际模型审美验收。';
      onText(text);
      return { text, toolCalls: [], stop: 'end_turn' };
    }
  };
  await runAgent({
    adapter,
    tools,
    model: 'fixture',
    userText: '把文字填入底图卡槽，保留全图，不用SVG',
    history: [],
    context: { dynamic: '' },
    emit() {},
    quiet: true
  });
  check('一次工具调用完成并有真实回执，无重画/重试循环', calls === 2 && delivered?.status === 'complete');
}
async function office(item) {
  const dir = path.join(out, 'office');
  await fs.mkdir(dir, { recursive: true });
  execFileSync(
    'soffice',
    [
      '-env:UserInstallation=file://' + path.join(out, 'office-profile'),
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      dir,
      path.join(out, item.name + '.pptx')
    ],
    { timeout: 60000, stdio: 'pipe' }
  );
  const pdf = path.join(dir, item.name + '.pdf'),
    text = execFileSync('pdftotext', ['-layout', pdf, '-'], { timeout: 15000, encoding: 'utf8' });
  check(
    '可编辑PPTX经真实Office转PDF，七条全文仍在',
    canvasCopy.every((e) => text.includes(e.title) && text.includes(e.body))
  );
  execFileSync('pdftoppm', ['-scale-to', '1600', '-singlefile', '-png', pdf, path.join(dir, 'native-text')], {
    timeout: 30000,
    stdio: 'pipe'
  });
}
try {
  const fixture = canvasFixture();
  await fs.writeFile(path.join(out, 'original.png'), fixture.bytes);
  await ws.write('Canvas验收/base.png', new Blob([fixture.bytes], { type: 'image/png' }));
  const first = await saveArtifacts('七卡槽直接填字', {
    title: '七卡槽原创验收样张',
    background_path: 'Canvas验收/base.png',
    canvas: { entries: canvasCopy, protected: fixture.protections }
  });
  check(
    '原图文件原字节未改',
    hash(Buffer.from(await (await ws.readBlob('Canvas验收/base.png')).arrayBuffer())) === hash(fixture.bytes)
  );
  const before = await ws.readText(first.receipt.designPath);
  const same = await saveArtifacts('同稿Demo', { source_path: first.receipt.designPath }, demo);
  check(
    '补同稿Demo保留坐标/原图并且原稿未覆盖',
    JSON.stringify(same.design.regions) === JSON.stringify(first.design.regions) &&
      (await ws.readText(first.receipt.designPath)) === before
  );
  const fourK = await saveArtifacts('4K同构图', { source_path: first.receipt.designPath, width: 2560, height: 3840 });
  check(
    '4K仅指真实画布，素材放大如实标注',
    fourK.receipt.width === 2560 && fourK.receipt.height === 3840 && fourK.receipt.image.upscaled === true
  );
  const six = canvasFixture({ count: 6, shift: -0.05, left: 0.23 });
  await ws.write('Canvas验收/six.png', new Blob([six.bytes], { type: 'image/png' }));
  const shifted = await saveArtifacts('六卡槽移位', {
    background_path: 'Canvas验收/six.png',
    canvas: { entries: canvasCopy.slice(0, 6), protected: six.protections }
  });
  check(
    '六卡槽真实移位检测，没有套七槽坐标',
    shifted.design.regions.length === 6 && shifted.design.regions[0].x > 0.22 && shifted.design.regions[0].y < 0.43
  );
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      lib: { entry: path.resolve('e2e/fixtures/canvas-browser.js'), formats: ['es'], fileName: 'canvas' },
      write: false,
      minify: 'esbuild'
    }
  });
  const outputs = Array.isArray(built) ? built.flatMap((item) => item.output) : built.output;
  const bundle = outputs.find((file) => file.type === 'chunk').code;
  await browserRaster(first, bundle);
  await editorCheck(first, bundle);
  await callChain();
  await office(first);
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(
      {
        status: 'passed',
        checks,
        receipts,
        limitations: ['受控原创像素样张，非用户原图', '未调用实际GPT/视觉服务，未测试用户服务器/Android真机/微信']
      },
      null,
      2
    )
  );
  console.log(`完成 ${checks.length} 项：${out}`);
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: String(error), checks }, null, 2));
  throw error;
} finally {
  await browser?.close();
}
