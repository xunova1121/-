/** 完整总体架构真实工具流程、图标文字避让、Office/PDF同稿验收；虚构素材，不调用模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { platformSpec } from './fixtures/diagram-platform.mjs';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import * as workspace from '../src/agent/workspace.js';
import { renderSvg } from '../server/svgRender.mjs';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { makeDiagramPptx } from '../src/agent/diagramPptx.js';
import { comparePng, pngPixels } from '../src/agent/diagramPng.js';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-diagram-platform');
await fs.mkdir(output, { recursive: true });
const result = await createDiagramTool({ renderSvg, compareDiagramPpt }).run(
  {
    ...platformSpec,
    path: '示范总体架构.svg',
    formats: ['svg', 'png', 'pptx', 'pdf'],
    contentPlan: { facts: [{ text: '8套示范传感设备', source: 'user', excerpt: '接入8套示范传感设备' }], recommendations: [] }
  },
  { rawRequestText: '接入8套示范传感设备，请画示范总体架构' }
);
const receipt = JSON.parse(result.split('\n')[1]);
const svg = await workspace.readText(receipt.sourcePath);
const design = JSON.parse(await workspace.readText(receipt.designPath));
await fs.writeFile(path.join(output, path.basename(receipt.designPath)), JSON.stringify(design, null, 2));
await fs.writeFile(path.join(output, path.basename(receipt.manifestPath)), await workspace.readText(receipt.manifestPath));
assert.equal(receipt.preview.visual, 'not_checked');
assert.equal(receipt.contentPlan.coverage, 'declared_facts_matched');
assert.equal(new Set(receipt.artifacts.map((item) => item.designHash)).size, 1);
for (const item of receipt.artifacts) {
  const blob = await workspace.readBlob(item.path);
  await fs.writeFile(path.join(output, path.basename(item.path)), new Uint8Array(await blob.arrayBuffer()));
}
await fs.writeFile(path.join(output, '总体架构验收清单.json'), JSON.stringify(receipt, null, 2));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><body style="margin:0;background:#fff">' + svg);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: design.width, height: design.height } });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate(() => document.fonts.ready);
  const checks = await page.evaluate(
    (input) => {
      const nodes = [...document.querySelectorAll('g[id^="node-"]')];
      const layout = input.nodes;
      const inBounds = nodes.every((node) => {
        const box = layout.find((item) => 'node-' + item.id === node.id);
        return [...node.querySelectorAll('text')].every((text) => {
          const bounds = text.getBoundingClientRect();
          return bounds.x >= box.x - 0.5 && bounds.y >= box.y - 0.5 && bounds.right <= box.x + box.width + 0.5 && bounds.bottom <= box.y + box.height + 0.5;
        });
      });
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const noTextIconCollision = nodes.every((node) => {
        const icons = [...node.querySelectorAll('g[transform]')].map((item) => item.getBoundingClientRect());
        return [...node.querySelectorAll('text')].every((text) => !icons.some((icon) => intersects(text.getBoundingClientRect(), icon)));
      });
      const labels = [...document.querySelectorAll('svg > text')].filter((text) => /结构化线索|任务工单/.test(text.textContent));
      const labelsOutside = labels.every(
        (label) =>
          !layout.some((box) => intersects(label.getBoundingClientRect(), { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height }))
      );
      const platformTitle = [...document.querySelectorAll('text')].filter((text) => text.textContent === '示范园区智慧协同管理平台').length;
      return {
        fullStructure: nodes.length === 31 && document.querySelectorAll('g[data-layer]').length === 8 && platformTitle === 1,
        inBounds,
        noTextIconCollision,
        labelsOutside: labels.length === 2 && labelsOutside,
        icons: document.querySelectorAll('g[transform]').length === 29,
        noExternal: !document.querySelector('image,script,foreignObject,[href]')
      };
    },
    { nodes: layoutDiagram(platformSpec).nodes }
  );
  for (const [label, passed] of Object.entries(checks)) {
    assert.equal(passed, true, label);
    console.log('✓ ' + label);
  }
  await page.locator('svg').screenshot({ path: path.join(output, '总体架构-浏览器.png') });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
const pngArtifact = receipt.artifacts.find((item) => item.format === 'png');
const pptArtifact = receipt.artifacts.find((item) => item.format === 'pptx');
const pdfArtifact = receipt.artifacts.find((item) => item.format === 'pdf');
assert.ok(pngArtifact && pptArtifact && pdfArtifact, '四种格式必须实际生成');
const png = await workspace.readBlob(pngArtifact.path);
const pptCompared = await compareDiagramPpt(await workspace.readBlob(pptArtifact.path), png);
assert.equal(pptCompared.passed, true, JSON.stringify(pptCompared));
console.log('✓ 同稿展示PPT实际对照：' + JSON.stringify(pptCompared));
const dimensions = await pngPixels(png);
const run = promisify(execFile);
await run(
  'pdftoppm',
  ['-singlefile', '-scale-to', String(Math.max(dimensions.width, dimensions.height)), '-png', path.basename(pdfArtifact.path), 'PDF实际渲染'],
  { cwd: output, timeout: 20000 }
);
const pdfCompared = await comparePng(png, new Blob([await fs.readFile(path.join(output, 'PDF实际渲染.png'))]));
assert.equal(pdfCompared.passed, true, JSON.stringify(pdfCompared));
console.log('✓ 同稿PDF实际对照：' + JSON.stringify(pdfCompared));
const native = await makeDiagramPptx(design, { editable: true });
const nativeCompared = await compareDiagramPpt(native, png);
assert.ok(['mismatch', 'render_compared'].includes(nativeCompared.state));
assert.equal(nativeCompared.passed, nativeCompared.state === 'render_compared');
await fs.writeFile(path.join(output, '原生PPT-需对照验收.pptx'), new Uint8Array(await native.arrayBuffer()));
console.log('✓ 原生PPT如实对照：' + JSON.stringify(nativeCompared));
console.log('总体架构9/9通过：' + output);
