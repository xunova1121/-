/** 真浏览器与真服务器渲染同一SVG；视觉模型只用假接口，检查PNG字节和实际像素。 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { renderSvg } from '../server/svgRender.mjs';
const root = process.cwd();
const output = process.argv[2] || '/tmp/weiyang-diagram-render';
await fs.mkdir(output, { recursive: true });
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="200" height="200" fill="#ff0000"/><rect x="200" width="200" height="200" fill="#0000ff"/></svg>';
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><title>图形渲染验收</title>');
    }
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) throw Error('outside');
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/octet-stream');
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  const checks = await page.evaluate(async (svg) => {
    const { renderSvg } = await import('/src/agent/svgPreview.js');
    const { imageFormat } = await import('/src/agent/imageFormat.js');
    const { prepareImage } = await import('/src/agent/images.js');
    const { createRenderDiagramTool } = await import('/src/agent/diagramReview.js');
    const workspace = await import('/src/agent/workspace.js');
    const png = await renderSvg(svg);
    const prepared = await prepareImage(new Blob([svg], { type: 'image/jpeg' }));
    const bitmap = await createImageBitmap(png);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const painter = canvas.getContext('2d');
    painter.drawImage(bitmap, 0, 0);
    const left = painter.getImageData(100, 100, 1, 1).data;
    const right = painter.getImageData(500, 100, 1, 1).data;
    bitmap.close();
    await workspace.write('原图误标.jpg', svg);
    await workspace.write('新版.svg', svg.replace('#ff0000', '#ffffff'));
    let reviewed = false;
    const receipt = await createRenderDiagramTool({
      visionLlm: async ({ images }) => {
        reviewed = images[0].mime === 'image/png' && images[0].data.startsWith('iVBOR');
        return '{"passed":true,"issues":[]}';
      }
    }).run({ path: '原图误标.jpg' });
    let blocked = false;
    try {
      await renderSvg(svg.replace('</svg>', '<image href="https://example.com/remote"/></svg>'));
    } catch (error) {
      blocked = error.code === 'SVG_UNSAFE';
    }
    const controller = new AbortController();
    controller.abort();
    let stopped = false;
    try {
      await renderSvg(svg, { signal: controller.signal });
    } catch (error) {
      stopped = error.name === 'AbortError';
    }
    return {
      truePng: (await imageFormat(png))?.ext === 'png',
      misnamedAttachment: prepared.mime === 'image/jpeg' && prepared.width === 600 && prepared.height === 300,
      dimensions: canvas.width === 600 && canvas.height === 300,
      pixels: left[0] === 255 && left[2] === 0 && right[0] === 0 && right[2] === 255,
      exactSource: receipt.includes('原图误标.jpg') && !receipt.includes('新版.svg'),
      previewSaved: (await imageFormat(await workspace.readBlob('原图误标-预览.png')))?.ext === 'png',
      sourcePreserved: (await workspace.readText('原图误标.jpg')) === svg,
      visionSawRealPng: reviewed,
      unsafeBlocked: blocked,
      stopped
    };
  }, svg);
  const serverPng = await renderSvg(svg);
  assert.equal(Buffer.from(await serverPng.slice(0, 8).arrayBuffer()).toString('hex'), '89504e470d0a1a0a');
  await fs.writeFile(path.join(output, 'server-svg-preview.png'), new Uint8Array(await serverPng.arrayBuffer()));
  checks.serverTruePng = true;
  for (const [label, passed] of Object.entries(checks)) {
    console.log((passed ? '✓ ' : '✗ ') + label);
    assert(passed, label);
  }
  console.log('图形实际渲染' + Object.keys(checks).length + '/' + Object.keys(checks).length + '通过');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
