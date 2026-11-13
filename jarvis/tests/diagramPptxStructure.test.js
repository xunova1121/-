import { it, expect } from 'vitest';
import JSZip from 'jszip';
import { cardSpec } from '../e2e/fixtures/diagram-cards.mjs';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene, sceneElements, validateScene } from '../src/agent/diagramScene.js';
import { makeDiagramPptx } from '../src/agent/diagramPptx.js';
import { inspectNativeDiagram } from '../src/agent/diagramPptxStructure.js';
import { spaceDiagram } from '../src/agent/diagramCandidates.js';
const scene = () => diagramScene(layoutDiagram(cardSpec), cardSpec.design);
it('原生PPT是真文本、独立节点分组和双端连接线，不是整张图铺底', async () => {
  const source = scene();
  const blob = await makeDiagramPptx(source, { editable: true });
  const info = await inspectNativeDiagram(blob);
  expect(info.nodeGroups).toBe(3);
  expect(info.connectors).toBe(2);
  expect(info.anchoredEnds).toBe(4);
  const icons = sceneElements(source).filter((item) => item.type === 'icon').length;
  expect(info.smallImages).toBe(icons);
  expect(info.textBoxes).toBe(
    sceneElements(source)
      .filter((item) => item.type === 'text')
      .reduce((sum, item) => sum + item.lines.length, 0)
  );
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  expect(xml).toContain('name="节点 notice"');
  expect(xml).toContain('<p:cNvCxnSpPr>');
  expect(xml).toContain('<a:stCxn');
});
it('文字可以直接修改，节点组有独立变换，连接端点引用真实组内形状', async () => {
  const blob = await makeDiagramPptx(scene(), { editable: true });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const file = 'ppt/slides/slide1.xml';
  let xml = await zip.file(file).async('string');
  xml = xml.replace('预警研判端', '人工复核端');
  zip.file(file, xml);
  const edited = new Blob([await zip.generateAsync({ type: 'arraybuffer' })]);
  const info = await inspectNativeDiagram(edited);
  expect(info.anchoredEnds).toBe(4);
  expect(await zip.file(file).async('string')).toContain('人工复核端');
  expect(xml).toMatch(/<p:grpSpPr><a:xfrm><a:off x="\d+" y="\d+"\/>/);
});
it('间距候选必须同步节点边界，不能用旧边界给PPT错误锚定', () => {
  const source = scene();
  const original = sceneElements(source).find((item) => item.nodeId === 'notice').bounds;
  const spaced = spaceDiagram(source);
  const next = sceneElements(spaced).find((item) => item.nodeId === 'notice').bounds;
  expect(next.y).toBeCloseTo(original.y * 1.12);
  expect(next.height).toBeCloseTo(original.height * 1.12);
  expect(validateScene(spaced)).toBe(spaced);
});
it('非法分组边界和过长容器标识必须拒绝，旧无边界scene仍可读', () => {
  const value = scene();
  const node = sceneElements(value).find((item) => item.nodeId === 'notice');
  delete node.bounds;
  expect(validateScene(value)).toBe(value);
  node.bounds = { x: -1, y: 0, width: 100, height: 100 };
  expect(() => validateScene(value)).toThrow(/分组边界/);
});
