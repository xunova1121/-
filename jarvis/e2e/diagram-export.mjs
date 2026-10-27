/** 真SVG→PNG→展示PPT/PDF，并经Office/Poppler再次渲染核对；无模型、无外网。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene } from '../src/agent/diagramScene.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';
import { renderSvg } from '../server/svgRender.mjs';
import { makeDiagramPptx } from '../src/agent/diagramPptx.js';
import { makeDiagramPdf } from '../src/agent/diagramPdf.js';
import { comparePng, pngPixels } from '../src/agent/diagramPng.js';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { inspectRenderedPdf } from '../src/agent/pdfQuality.js';
const run = promisify(execFile);
const output = path.resolve(process.argv[2] || '/tmp/weiyang-diagram-export');
await fs.mkdir(output, { recursive: true });
const scene = diagramScene(
  layoutDiagram({
    title: '同稿多格式真实验收',
    design: { message: '感知发现 · 数据研判 · 协同处置' },
    layers: [
      {
        title: '感知层',
        nodes: [
          { id: 'r', title: '雷达', detail: '持续发现目标' },
          { id: 'c', title: '摄像机', detail: '辅助现场核查' }
        ]
      },
      {
        title: '核心层 · 协同处置',
        emphasis: true,
        nodes: [
          { id: 'w', title: '预警研判', detail: '汇聚线索、辅助研判' },
          { id: 'a', title: '任务处置', detail: '派单与闭环记录' }
        ]
      },
      { title: '应用层', nodes: [{ id: 's', title: '大屏与移动端' }] }
    ],
    edges: [
      { from: 'r', to: 'w' },
      { from: 'w', to: 's' }
    ]
  }),
  { theme: 'jade', message: '感知发现 · 数据研判 · 协同处置' }
);
const svg = sceneSvg(scene);
const png = await renderSvg(svg);
const dimensions = await pngPixels(png);
const pptx = await makeDiagramPptx(scene, { png });
const pdf = await makeDiagramPdf(scene, png);
for (const [suffix, data] of [
  ['svg', svg],
  ['png', new Uint8Array(await png.arrayBuffer())],
  ['pptx', new Uint8Array(await pptx.arrayBuffer())],
  ['pdf', new Uint8Array(await pdf.arrayBuffer())]
])
  await fs.writeFile(path.join(output, '同稿.' + suffix), data);
const pptResult = await compareDiagramPpt(pptx, png);
assert.equal(pptResult.passed, true, JSON.stringify(pptResult));
console.log('✓ 展示PPT真实Office渲染与共享PNG一致：' + JSON.stringify(pptResult));
const inspected = await inspectRenderedPdf(pdf);
assert.equal(inspected.pages, 1);
await run('pdftoppm', ['-singlefile', '-scale-to', String(Math.max(dimensions.width, dimensions.height)), '-png', '同稿.pdf', '同稿-PDF实际渲染'], {
  cwd: output,
  timeout: 20000
});
const pdfPng = new Blob([await fs.readFile(path.join(output, '同稿-PDF实际渲染.png'))], { type: 'image/png' });
const pdfResult = await comparePng(png, pdfPng);
assert.equal(pdfResult.passed, true, JSON.stringify(pdfResult));
console.log('✓ PDF一页且实际渲染与共享PNG一致：' + JSON.stringify(pdfResult));
const native = await makeDiagramPptx(scene, { editable: true });
await fs.writeFile(path.join(output, '同稿-可编辑待验.pptx'), new Uint8Array(await native.arrayBuffer()));
const nativeResult = await compareDiagramPpt(native, png);
assert.ok(['render_compared', 'mismatch'].includes(nativeResult.state), '必须实际渲染，不可跳过');
assert.equal(nativeResult.passed, nativeResult.state === 'render_compared');
console.log('✓ 原生可编辑PPT实际对照，状态如实保留：' + JSON.stringify(nativeResult));
console.log('同稿真实导出3/3通过，样稿：' + output);
