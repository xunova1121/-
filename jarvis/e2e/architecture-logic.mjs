import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { architectureSpec, architectureLayout } from './fixtures/architecture-plan.mjs';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import * as workspace from '../src/agent/workspace.js';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { sceneElements } from '../src/agent/diagramScene.js';
import { renderSvg } from '../server/svgRender.mjs';
const output = path.resolve(process.argv[2] || '/tmp/architecture-logic');
await fs.mkdir(output, { recursive: true });
const native = process.env.ARCHITECTURE_NATIVE === '1';
const ctx = { renderSvg, ...(native && { compareDiagramPpt }), llm: async () => JSON.stringify({ passed: true, issues: [] }) };
const request = '建设示范业务闭环，统一权限与审计';
const view = process.env.ARCHITECTURE_VIEW || 'overview';
const plan = JSON.parse(await createArchitecturePlanTool(ctx).run(architectureSpec, { rawRequestText: request }));
assert.equal(plan.semantic, 'passed');
const response = await createDiagramTool(ctx, { requireArchitecture: true }).run(
  {
    ...structuredClone(architectureLayout),
    view,
    architecturePath: plan.architecturePath,
    path: '示范逻辑.svg',
    formats: native ? ['svg', 'png', 'pdf', 'pptx'] : ['svg', 'png']
  },
  { rawRequestText: '制作架构图' }
);
const receipt = JSON.parse(response.split('\n')[1]);
assert.equal(receipt.preview.render, 'passed');
assert.equal(receipt.architecture.semantic, 'passed');
const scene = JSON.parse(await workspace.readText(receipt.designPath));
const drawn = sceneElements(scene)
  .filter((item) => item.type === 'text')
  .flatMap((item) => item.lines.map((line) => line.text))
  .join('');
if (view === 'overview')
  for (const entity of architectureSpec.entities.filter((item) => item.kind !== 'system')) {
    assert.ok(drawn.includes(entity.title), '不得漏画节点标题：' + entity.id);
    assert.ok(drawn.includes(entity.responsibility), '不得漏画节点职责：' + entity.id);
  }
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(await workspace.readText(receipt.sourcePath));
  await page.evaluate(() => document.fonts.ready);
  const invalid = await page.evaluate(() => {
    const root = document.querySelector('svg'),
      frame = root.viewBox.baseVal;
    return [...root.querySelectorAll('text')]
      .filter((item) => {
        const b = item.getBBox();
        return b.x < 0 || b.y < 0 || b.x + b.width > frame.width || b.y + b.height > frame.height;
      })
      .map((item) => item.textContent);
  });
  assert.deepEqual(invalid, [], '真实字体下不能有文字越出画布');
  const empty = await page.evaluate(() => [...document.querySelectorAll('g[id^=node-]')].filter((item) => !item.querySelector('text')).map((item) => item.id));
  assert.deepEqual(empty, [], '节点不能只剩空分组');
  const boxes = sceneElements(scene)
    .filter((item) => item.type === 'group' && item.nodeId && item.bounds)
    .map((item) => ({ id: item.nodeId, ...item.bounds }));
  const overflow = await page.evaluate(
    (boxes) =>
      boxes.flatMap((box) =>
        [...document.getElementById('node-' + box.id).querySelectorAll('text')]
          .filter((item) => {
            const b = item.getBBox();
            return b.x < box.x || b.y < box.y || b.x + b.width > box.x + box.width || b.y + b.height > box.y + box.height;
          })
          .map((item) => box.id + ':' + item.textContent)
      ),
    boxes
  );
  assert.deepEqual(overflow, [], '真实字形下节点正文不能溢出卡片');
} finally {
  await browser.close();
}
assert.equal(scene.architecture.planHash, JSON.parse(await workspace.readText(plan.reviewPath)).planHash);
for (const item of receipt.artifacts)
  await fs.writeFile(path.join(output, path.basename(item.path)), new Uint8Array(await (await workspace.readBlob(item.path)).arrayBuffer()));
for (const file of [receipt.designPath, plan.architecturePath, plan.reviewPath, plan.relationTablePath])
  await fs.writeFile(path.join(output, path.basename(file)), new Uint8Array(await (await workspace.readBlob(file)).arrayBuffer()));
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
if (native) {
  assert.equal(receipt.editable?.passed, true, JSON.stringify(receipt.editable));
  assert.ok(receipt.editable.structure.nodeGroups >= 3);
  assert.ok(receipt.editable.structure.anchoredEnds >= 4);
}
console.log('业务底稿→关系审查→分层投影→真实SVG/PNG及摘要绑定：5/5；语义模型为假接口，非客户验收');
