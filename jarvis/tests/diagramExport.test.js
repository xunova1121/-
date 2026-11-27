import { it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { deflateSync, inflateSync } from 'node:zlib';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene, validateScene, sceneElements } from '../src/agent/diagramScene.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';
import { makeDiagramPptx } from '../src/agent/diagramPptx.js';
import { makeDiagramPdf } from '../src/agent/diagramPdf.js';
import { pngPixels, comparePng } from '../src/agent/diagramPng.js';
import { deliverDiagram, createExportDiagramTool, diagramDigest } from '../src/agent/diagramExport.js';
import { createDocumentTools } from '../src/agent/documentTools.js';
import * as workspace from '../src/agent/workspace.js';

// 固定RGB像素，只测协议与同稿导出，不联网、不调用真实模型。
function fixture(red = 18) {
  const chunk = (type, content) => {
    const result = Buffer.alloc(content.length + 12);
    result.writeUInt32BE(content.length);
    result.write(type, 4);
    content.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return new Blob(
    [
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.from([0, red, 34, 56, 255, 255, 255]))),
      chunk('IEND', Buffer.alloc(0))
    ],
    { type: 'image/png' }
  );
}
const spec = {
  title: '同稿验收',
  layers: [
    { title: '数据层', nodes: [{ id: 'a', title: '采集', detail: '原文来源' }] },
    { title: '应用层', nodes: [{ id: 'b', title: '监管' }] }
  ],
  edges: [{ from: 'a', to: 'b' }]
};
const scene = () => diagramScene(layoutDiagram(spec));
const renderSvg = () => vi.fn(async () => fixture());
const resultJson = (text) => JSON.parse(text.slice(text.indexOf('\n') + 1));

it('展示PPT只有一页且原样嵌入共享PNG，原生版复用文字和坐标不加封面', async () => {
  const model = scene();
  const png = fixture();
  const display = await JSZip.loadAsync(await (await makeDiagramPptx(model, { png })).arrayBuffer());
  expect(Object.keys(display.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))).toHaveLength(1);
  const media = Object.keys(display.files).find((path) => /^ppt\/media\//.test(path) && !display.files[path].dir);
  expect(await display.file(media).async('uint8array')).toEqual(new Uint8Array(await png.arrayBuffer()));
  const editable = await JSZip.loadAsync(await (await makeDiagramPptx(model, { editable: true })).arrayBuffer());
  const slide = await editable.file('ppt/slides/slide1.xml').async('string');
  expect(slide).not.toContain('<p:pic>');
  expect(slide).toContain('wrap="none"');
  for (const item of sceneElements(model).filter((item) => item.type === 'text'))
    for (const line of item.lines) {
      expect(slide).toContain(line.text);
      expect(sceneSvg(model)).toContain(`x="${line.x}" y="${line.y}"`);
    }
  expect(slide).toContain(`x="${Math.round(((240 * 13.333333) / model.width) * 914400)}"`);
});

it('PDF一页以原RGB像素嵌图，不再次替换字体或产生额外封面', async () => {
  const png = fixture();
  const pdf = Buffer.from(await (await makeDiagramPdf(scene(), png)).arrayBuffer());
  const text = pdf.toString('latin1');
  expect(text).toContain('/Count 1');
  expect(text).toContain('/Width 2 /Height 1');
  const start = pdf.indexOf(Buffer.from('stream\n')) + 7;
  const end = pdf.indexOf(Buffer.from('\nendstream'), start);
  expect(new Uint8Array(inflateSync(pdf.subarray(start, end)))).toEqual((await pngPixels(png)).rgb);
  expect(text).toContain('/Interpolate false');
});

it('各格式绑定同一设计摘要；重新导出复用PNG且不重复渲染与视觉请求', async () => {
  const renderer = renderSvg();
  const visionLlm = vi.fn(async () => '{"passed":true,"issues":[]}');
  const first = await deliverDiagram({ renderSvg: renderer, visionLlm }, { scene: scene(), path: '统一导出.svg', formats: ['svg', 'png', 'pptx', 'pdf'] });
  expect(first.errors).toEqual([]);
  expect(first.artifacts.map((item) => item.format)).toEqual(['svg', 'png', 'pptx', 'pdf']);
  expect(new Set(first.artifacts.map((item) => item.designHash)).size).toBe(1);
  const second = resultJson(await createExportDiagramTool({ renderSvg: renderer, visionLlm }).run({ sourcePath: first.designPath, formats: ['pptx'] }));
  expect(second.previewHash).toBe(first.previewHash);
  expect(renderer).toHaveBeenCalledTimes(1);
  expect(visionLlm).toHaveBeenCalledTimes(1);
  const modified = JSON.parse(await workspace.readText(first.designPath));
  modified.elements[1].lines[0].text = '修改后的标题';
  await workspace.write(first.designPath, JSON.stringify(modified));
  await createExportDiagramTool({ renderSvg: renderer, visionLlm }).run({ sourcePath: first.designPath, formats: ['png'] });
  expect(renderer).toHaveBeenCalledTimes(2);
  expect(visionLlm).toHaveBeenCalledTimes(2);
});

it('视觉失败保留源稿和预览，禁止继续派生PPT/PDF', async () => {
  const result = await deliverDiagram(
    { renderSvg: renderSvg(), visionLlm: async () => '{"passed":false,"issues":["遮挡"]}' },
    { scene: scene(), path: '不通过.svg', formats: ['pdf', 'pptx'] }
  );
  expect(result.errors).toHaveLength(1);
  expect(await workspace.exists(result.designPath)).toBe(true);
  expect(await workspace.exists(result.preview.previewPath)).toBe(true);
  expect(await workspace.exists('不通过.pptx')).toBe(false);
  expect(await workspace.exists('不通过.pdf')).toBe(false);
});

it.each(['missing', 'mismatch', 'passed'])('可编辑PPT真实对照门禁：%s', async (condition) => {
  const compare = vi.fn(async () => ({ passed: condition === 'passed', state: condition }));
  const result = await deliverDiagram(
    { renderSvg: renderSvg(), ...(condition !== 'missing' ? { compareDiagramPpt: compare } : {}) },
    { scene: scene(), path: '原生-' + condition + '.svg', formats: ['pptx'], pptxMode: 'editable' }
  );
  expect(result.artifacts.some((item) => item.path.endsWith('-可编辑.pptx'))).toBe(condition === 'passed');
  expect(result.artifacts.some((item) => item.consistency === 'shared_render' && item.format === 'pptx')).toBe(true);
  expect(result.errors.length).toBe(condition === 'passed' ? 0 : 1);
});

it('停止和预算信号不被导出异常捕获吞掉', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(deliverDiagram({}, { scene: scene(), path: '导出前停止.svg', formats: [], signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(await workspace.exists('导出前停止.svg')).toBe(false);
  const budget = Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' });
  await expect(
    deliverDiagram(
      { renderSvg: renderSvg(), visionLlm: vi.fn() },
      {
        scene: scene(),
        path: '导出预算.svg',
        formats: ['pptx'],
        retrieval: {
          consume() {
            throw budget;
          }
        }
      }
    )
  ).rejects.toBe(budget);
});

it('旧SVG可以导出展示PPT，缺少设计稿不能冒充原生编辑版', async () => {
  const svg = sceneSvg(scene());
  await workspace.write('旧稿.svg', svg);
  const result = resultJson(await createExportDiagramTool({ renderSvg: renderSvg() }).run({ sourcePath: '旧稿.svg', formats: ['pptx'], pptxMode: 'editable' }));
  expect(result.artifacts.some((item) => item.format === 'pptx')).toBe(true);
  expect(result.errors[0].code).toBe('DIAGRAM_EDITABLE_SOURCE');
});

it('非法设计稿、外链填色、负尺寸、递归与非正交线不能进入渲染器', () => {
  const base = scene();
  for (const invalid of [
    { ...base, fontFamily: 'url(https://invalid.example)' },
    { ...base, elements: [{ ...base.elements[0], width: -1 }] },
    { ...base, elements: [{ ...base.elements[0], fill: 'url(https://invalid.example)' }] },
    {
      ...base,
      elements: [
        {
          type: 'path',
          points: [
            { x: 1, y: 1 },
            { x: 2, y: 2 }
          ],
          stroke: '#ffffff',
          strokeWidth: 1
        }
      ]
    }
  ])
    expect(() => validateScene(invalid)).toThrow();
  let nested = { type: 'group', children: [] };
  for (let level = 0; level < 18; level++) nested = { type: 'group', children: [nested] };
  expect(() => validateScene({ ...base, elements: [nested] })).toThrow(/16层/);
});

it('像素比较识别实际变更且PNG解码拒绝伪数据', async () => {
  expect(await comparePng(fixture(), fixture())).toMatchObject({ passed: true, meanChannelError: 0 });
  expect(await comparePng(fixture(), fixture(255))).toMatchObject({ passed: false });
  await expect(pngPixels(new Blob(['fake']))).rejects.toMatchObject({ code: 'DIAGRAM_PNG' });
  expect(await diagramDigest(fixture())).not.toBe(await diagramDigest(fixture(255)));
});

it('普通文档入口不能为独立架构PPT另画一版', async () => {
  const tools = createDocumentTools({});
  const tool = tools.find((item) => item.name === 'create_document');
  await expect(tool.run({ path: '另画.pptx', format: 'pptx', requirements: '用PPT制作架构图' })).rejects.toMatchObject({ code: 'USE_CANONICAL_DIAGRAM' });
});
