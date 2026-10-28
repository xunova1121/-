import { it, expect } from 'vitest';
import JSZip from 'jszip';
import { cardSpec } from '../e2e/fixtures/diagram-cards.mjs';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene, sceneElements } from '../src/agent/diagramScene.js';
import { makeDiagramPptx } from '../src/agent/diagramPptx.js';
import { inspectNativeDiagram } from '../src/agent/diagramPptxStructure.js';
it('有端点的折返线保留每段原生连接与透明折点，不生成会被Office拉直的自定义连接几何', async () => {
  const scene = diagramScene(layoutDiagram(cardSpec), cardSpec.design);
  const edge = sceneElements(scene).find(item => item.type === 'path' && item.from && item.to);
  const first = edge.points[0], last = edge.points.at(-1);
  edge.points = [first, { x: first.x, y: first.y - 20 }, { x: last.x, y: first.y - 20 }, last];
  const original = JSON.stringify(scene);
  const blob = await makeDiagramPptx(scene, { editable: true });
  const info = await inspectNativeDiagram(blob);
  expect(info.connectors).toBe(4); expect(info.anchoredEnds).toBe(8); expect(info.nodeGroups).toBe(3);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  expect(xml).toContain('name="折返连接 ');
  expect((xml.match(/name="折点 /g) || []).length).toBe(2);
  for (const connector of xml.matchAll(/<p:cxnSp>[\s\S]*?<\/p:cxnSp>/g)) {
    expect(connector[0]).toContain('prst="line"');
    expect(connector[0]).not.toContain('<a:custGeom>');
  }
  expect(JSON.stringify(scene)).toBe(original);
});

it('Noto原生文本使用固定左字面校正，仍保留真实文本而不改写字号/内容', async () => {
  const scene = diagramScene(layoutDiagram(cardSpec), cardSpec.design);
  scene.fontFace = 'Noto Sans CJK SC'; scene.fontFamily = 'Noto Sans CJK SC, Microsoft YaHei, sans-serif';
  const text = sceneElements(scene).find(item => item.type === 'text');
  const blob = await makeDiagramPptx(scene, { editable: true });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  const shape = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].find(match => match[0].includes('<a:t>' + text.lines[0].text + '</a:t>'))[0];
  const x = Number(/<a:off x="(\d+)"/.exec(shape)[1]);
  expect(x).toBeCloseTo((text.lines[0].x + 0.5) * 13.333333 / scene.width * 914400, 0);
  expect(shape).toContain('<a:t>' + text.lines[0].text + '</a:t>');
});
