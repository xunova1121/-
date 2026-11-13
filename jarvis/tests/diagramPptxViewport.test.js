import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { deflateSync } from 'node:zlib';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene, sceneElements, validateScene } from '../src/agent/diagramScene.js';
import { diagramPptxViewport, diagramInchesPerPixel } from '../src/agent/diagramPptxViewport.js';
import { makeDiagramPptx } from '../src/agent/diagramPptx.js';
import { inspectNativeDiagram } from '../src/agent/diagramPptxStructure.js';
import { comparePng } from '../src/agent/diagramPng.js';

function scene() {
  const input = { title: '虚构单位与视口', semanticRouting: true, view: 'relations', design: { theme: 'gov-blue' },
    layers: [{ title: '业务应用', role: 'application', nodes: [{ id: 'a', title: '受理', detail: '登记事项' }, { id: 'b', title: '办理', detail: '办理事项' }] }],
    edges: [{ from: 'a', to: 'b', type: 'workflow', label: '派发事项' }] };
  const value = diagramScene(layoutDiagram(input), input.design);
  value.width = 1520; value.height = 2831.2;
  value.elements[0].width = value.width; value.elements[0].height = value.height;
  value.elements.push({ type: 'text', x: 100, y: 500, width: 200, fontSize: 13, fill: '#123b69', bold: false, lines: [{ text: '精确物理单位', x: 100, y: 500 }] });
  return validateScene(value);
}
function png(width, height) {
  const chunk = (name, bytes) => {
    const buffer = Buffer.alloc(bytes.length + 12); buffer.writeUInt32BE(bytes.length); buffer.write(name, 4); bytes.copy(buffer, 8);
    let crc = 0xffffffff;
    for (const byte of buffer.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    buffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, buffer.length - 4); return buffer;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return new Blob([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))], { type: 'image/png' });
}

it('按同SVG整数视口居中平移整稿，字、路径、边界及线宽保持同一坐标变换', () => {
  const source = scene(), original = structuredClone(source), frame = diagramPptxViewport(source);
  expect(frame.scale).toBe(1 / 96);
  expect(frame.viewport).toMatchObject({ width: 1100, height: 2048 });
  expect(frame.scene.width / frame.scene.height).toBeCloseTo(1100 / 2048, 12);
  expect(frame.viewport.dx).toBeGreaterThan(0);
  const before = sceneElements(source), after = sceneElements(frame.scene), { dx, dy, factor } = frame.viewport;
  expect(after).toHaveLength(before.length);
  for (const [index, item] of before.entries()) {
    const next = after[index];
    for (const key of ['width', 'height', 'fontSize', 'radius', 'strokeWidth', 'arrow', 'relationType']) expect(next[key]).toEqual(item[key]);
    if (Number.isFinite(item.x)) expect(next.x).toBeCloseTo(item.x + dx, 12);
    if (Number.isFinite(item.y)) expect(next.y).toBeCloseTo(item.y + dy, 12);
    if (item.bounds) expect(next.bounds).toEqual({ ...item.bounds, x: item.bounds.x + dx, y: item.bounds.y + dy });
    for (const key of ['lines', 'points']) if (item[key]) for (const [pointIndex, point] of item[key].entries()) {
      expect(next[key][pointIndex]).toEqual({ ...point, x: point.x + dx, y: point.y + dy });
      expect(next[key][pointIndex].x * factor).toBeCloseTo(point.x * factor + dx * factor, 12);
    }
  }
  expect(source).toEqual(original);
  expect(validateScene(frame.scene)).toBe(frame.scene);
});

it('96CSS像素对应一英寸：13像素是9.75pt，展示/原生同纸张，连接端点共享EMU尺度', async () => {
  const source = scene(), original = JSON.stringify(source), frame = diagramPptxViewport(source);
  const native = await makeDiagramPptx(source, { editable: true }), display = await makeDiagramPptx(source, { png: png(1, 1) });
  const a = await JSZip.loadAsync(await native.arrayBuffer()), b = await JSZip.loadAsync(await display.arrayBuffer());
  const page = xml => /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(xml)?.slice(1).map(Number);
  const nativePaper = page(await a.file('ppt/presentation.xml').async('string'));
  expect(nativePaper).toEqual(page(await b.file('ppt/presentation.xml').async('string')));
  expect(nativePaper).toEqual([Math.round(frame.scene.width / 96 * 914400), Math.round(frame.scene.height / 96 * 914400)]);
  const xml = await a.file('ppt/slides/slide1.xml').async('string');
  expect(xml).toMatch(/<a:rPr\b[^>]*\bsz="975"/);
  const metrics = await inspectNativeDiagram(native);
  expect(metrics).toMatchObject({ nodeGroups: 2, connectors: 1, anchoredEnds: 2 });
  expect(JSON.stringify(source)).toBe(original);
}, 15000);

it('旧Microsoft场景保留原单位及画布，现代超56英寸明确失败，不裁掉原设计', () => {
  const source = scene(); source.fontFace = 'Microsoft YaHei'; source.fontFamily = 'Microsoft YaHei, Noto Sans CJK SC, sans-serif';
  const original = structuredClone(source), old = diagramPptxViewport(source);
  expect(old.scene).toEqual(original);
  expect(diagramInchesPerPixel(source)).toBe(13.333333 / source.width);
  const modern = scene(); modern.height = 6000; modern.elements[0].height = 6000;
  const saved = structuredClone(modern);
  expect(() => diagramPptxViewport(modern)).toThrow('56英寸');
  expect(modern).toEqual(saved);
});

it('纸张比例错误仍按原门槛失败，不能用同色空白或新视口掩盖', async () => {
  const result = await comparePng(png(1, 1), png(2, 1));
  expect(result.meanChannelError).toBe(0);
  expect(result.aspectError).toBe(1);
  expect(result.passed).toBe(false);
});
