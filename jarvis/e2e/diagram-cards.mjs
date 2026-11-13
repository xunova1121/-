/** 新卡片真实工具流程、浏览器文字边界、Office/PDF同稿验收；虚构素材，不调用模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { cardSpec } from './fixtures/diagram-cards.mjs';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import * as workspace from '../src/agent/workspace.js';
import { renderSvg } from '../server/svgRender.mjs';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { makeDiagramPptx } from '../src/agent/diagramPptx.js';
import { comparePng, pngPixels } from '../src/agent/diagramPng.js';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-diagram-cards');
await fs.mkdir(output, { recursive: true });
const result = await createDiagramTool({ renderSvg, compareDiagramPpt }).run(
  {
    ...cardSpec,
    path: '示范协同卡片.svg',
    formats: ['svg', 'png', 'pptx', 'pdf'],
    contentPlan: { facts: [{ text: '8套示范传感设备', source: 'user', excerpt: '接入8套示范传感设备' }], recommendations: [] }
  },
  { rawRequestText: '接入8套示范传感设备，请画示范协同卡片' }
);
const receipt = JSON.parse(result.split('\n')[1]);
const svg = await workspace.readText(receipt.sourcePath);
const design = JSON.parse(await workspace.readText(receipt.designPath));
assert.equal(receipt.preview.visual, 'not_checked');
assert.equal(receipt.contentPlan.coverage, 'declared_facts_matched');
assert.equal(new Set(receipt.artifacts.map((item) => item.designHash)).size, 1);
for (const item of receipt.artifacts) {
  const blob = await workspace.readBlob(item.path);
  await fs.writeFile(path.join(output, path.basename(item.path)), new Uint8Array(await blob.arrayBuffer()));
}
await fs.writeFile(path.join(output, '卡片验收清单.json'), JSON.stringify(receipt, null, 2));
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
  const checks = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('g[id^="node-"]')];
    const inBounds = cards.every((card) => {
      const box = card.querySelector('rect').getBBox();
      return [...card.querySelectorAll('text')].every((text) => {
        const bounds = text.getBBox();
        return bounds.x >= box.x && bounds.y >= box.y && bounds.x + bounds.width <= box.x + box.width && bounds.y + bounds.height <= box.y + box.height;
      });
    });
    const labels = [...document.querySelectorAll('svg > text')].filter((text) => /结构化线索|任务工单/.test(text.textContent));
    const labelsOutside = labels.every((label) => {
      const a = label.getBBox();
      return cards.every((card) => {
        const b = card.querySelector('rect').getBBox();
        return a.x + a.width <= b.x || a.x >= b.x + b.width || a.y + a.height <= b.y || a.y >= b.y + b.height;
      });
    });
    return {
      threeCards: cards.length === 3,
      inBounds,
      labelsOutside: labels.length === 2 && labelsOutside,
      icons: document.querySelectorAll('g[transform]').length === 15,
      noExternal: !document.querySelector('image,script,foreignObject,[href]')
    };
  });
  for (const [label, passed] of Object.entries(checks)) {
    assert.equal(passed, true, label);
    console.log('✓ ' + label);
  }
  await page.locator('svg').screenshot({ path: path.join(output, '卡片与流程-浏览器.png') });
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
console.log('卡片与流程8/8通过：' + output);
