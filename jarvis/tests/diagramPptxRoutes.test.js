import { it, expect } from 'vitest';
import JSZip from 'jszip';
import { cardSpec } from '../e2e/fixtures/diagram-cards.mjs';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene, sceneElements } from '../src/agent/diagramScene.js';
import { makeDiagramPptx } from '../src/agent/diagramPptx.js';
import { inspectNativeDiagram } from '../src/agent/diagramPptxStructure.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';
import { validateSvg } from '../src/agent/svgPreview.js';
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

it('Noto原生文本按同SVG视口和CSS物理单位定位，保留真实基线、字号、内容及原稿', async () => {
  const scene = diagramScene(layoutDiagram(cardSpec), cardSpec.design);
  scene.fontFace = 'Noto Sans CJK SC'; scene.fontFamily = 'Noto Sans CJK SC, Microsoft YaHei, sans-serif';
  const original = JSON.stringify(scene), viewport = validateSvg(sceneSvg(scene));
  const factor = Math.min(viewport.width / scene.width, viewport.height / scene.height);
  const dx = Math.max(0, viewport.width / factor - scene.width) / 2;
  const dy = Math.max(0, viewport.height / factor - scene.height) / 2;
  const text = sceneElements(scene).find(item => item.type === 'text');
  const blob = await makeDiagramPptx(scene, { editable: true });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  const shape = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].find(match => match[0].includes('<a:t>' + text.lines[0].text + '</a:t>'))[0];
  const [, x, y] = /<a:off x="(\d+)" y="(\d+)"/.exec(shape).map(Number);
  expect(x).toBeCloseTo((text.lines[0].x + dx) / 96 * 914400, 0);
  expect(y).toBeCloseTo((text.lines[0].y + dy - text.fontSize) / 96 * 914400, 0);
  expect(shape).toMatch(new RegExp('<a:rPr\\b[^>]*\\bsz="' + Math.round(text.fontSize * 72 / 96 * 100) + '"'));
  expect(shape).toContain('<a:t>' + text.lines[0].text + '</a:t>');
  expect(JSON.stringify(scene)).toBe(original);
});
