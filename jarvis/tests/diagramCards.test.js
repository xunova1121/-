import { it, expect } from 'vitest';
import JSZip from 'jszip';
import { cardSpec } from '../e2e/fixtures/diagram-cards.mjs';
import { layoutDiagram, validateDiagramLayout } from '../src/agent/diagramModel.js';
import { diagramScene, sceneElements, validateScene } from '../src/agent/diagramScene.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';
import { diagramRoutes } from '../src/agent/diagramRoutes.js';
import { makeDiagramPptx } from '../src/agent/diagramPptx.js';
import { validateSvg } from '../src/agent/svgPreview.js';
import { planDiagramContent } from '../src/agent/diagramPlanning.js';
import { DIAGRAM_ICONS } from '../src/agent/diagramCards.js';
import { DIAGRAM_ICON_ASSETS } from '../src/agent/diagramIconAssets.js';
import { ICON_PNG } from '../src/agent/pptIcons.js';
const copy = () => structuredClone(cardSpec);
const build = (input) => diagramScene(layoutDiagram(input), input.design);

it('三种强调卡片保留所有要点、标签与图标，布局和安全子集均通过', () => {
  const model = layoutDiagram(cardSpec);
  expect(validateDiagramLayout(model)).toBe(true);
  const scene = build(cardSpec);
  expect(validateScene(scene)).toBe(scene);
  const svg = sceneSvg(scene);
  expect(() => validateSvg(svg)).not.toThrow();
  for (const node of cardSpec.layers[0].nodes) {
    expect(svg).toContain(node.title);
    expect(svg).toContain(node.badge);
    for (const bullet of node.bullets) expect(svg).toContain(bullet.text);
  }
  expect(sceneElements(scene).filter((item) => item.type === 'icon')).toHaveLength(15);
  expect(svg).not.toMatch(/<image|<script|<foreignObject|href=/);
  expect(svg).toContain('fill="#bd6200"');
  expect(svg).toContain('fill="#007fc4"');
  expect(svg).toContain('fill="#00856b"');
});
it('箭头在相邻卡片之间水平连接，标签完整位于间隙，反向箭头也可用', () => {
  const model = layoutDiagram(cardSpec);
  for (const route of diagramRoutes(model)) {
    expect(route.points).toHaveLength(2);
    expect(route.points[0].y).toBe(route.points[1].y);
    const from = model.nodes.find((node) => node.id === route.from);
    const to = model.nodes.find((node) => node.id === route.to);
    expect(route.points[0].x).toBeGreaterThan(from.x + from.width);
    expect(route.points[1].x).toBeLessThan(to.x);
  }
  const reverse = copy();
  reverse.edges = [{ from: 'dispatch', to: 'notice', label: '补充核验' }];
  const points = diagramRoutes(layoutDiagram(reverse))[0].points;
  expect(points[0].x).toBeGreaterThan(points[1].x);
  expect(sceneSvg(build(reverse))).toContain('补充核验');
});
it('不允许非相邻/跨排/双向重叠的带字箭头，也不丢失超长标签', () => {
  for (const edges of [
    [{ from: 'notice', to: 'field', label: '跳过' }],
    [...cardSpec.edges, { from: 'dispatch', to: 'notice', label: '退回' }],
    [{ from: 'notice', to: 'dispatch', label: '超出十二个汉字标签内容不能静默截断' }]
  ])
    expect(() => layoutDiagram({ ...cardSpec, edges })).toThrow();
});
it('未知图标、自由颜色和不合规要点明确失败，不放任任意SVG/URL', () => {
  for (const patch of [
    { icon: 'https://evil.example/icon' },
    { accent: '#ff0000' },
    { bullets: [{ text: '只有一条' }] },
    { bullets: Array(6).fill({ text: '超限' }) },
    { badge: '字'.repeat(29) }
  ]) {
    const spec = copy();
    Object.assign(spec.layers[0].nodes[0], patch);
    expect(() => layoutDiagram(spec)).toThrow();
  }
  const scene = build(cardSpec);
  const icon = sceneElements(scene).find((item) => item.type === 'icon');
  icon.icon = '__proto__';
  expect(() => validateScene(scene)).toThrow();
});
it('图标白名单来自同版本既有PPT素材；设计稿不接受外部图标或无限图标', () => {
  expect(DIAGRAM_ICONS.sort()).toEqual(Object.keys(ICON_PNG).sort());
  for (const source of Object.values(DIAGRAM_ICON_ASSETS)) expect(source).not.toMatch(/href|script|style=|onload/);
  const scene = build(cardSpec);
  const icon = sceneElements(scene).find((item) => item.type === 'icon');
  scene.elements.push(...Array.from({ length: 49 }, () => ({ ...icon })));
  expect(() => validateScene(scene)).toThrow(/48/);
});
it('原生PPT保留可编辑文本、标签、彩色连线，并引用同一图标ID的既有素材', async () => {
  const scene = build(cardSpec);
  const pptx = await makeDiagramPptx(scene, { editable: true });
  const zip = await JSZip.loadAsync(await pptx.arrayBuffer());
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  expect(slide).toContain('结构化线索');
  expect(slide).toContain('接入8套示范传感设备');
  expect(slide).toContain('发现与研判');
  expect(slide).toContain('BD6200');
  const media = Object.values(zip.files).filter((item) => /ppt\/media\/.+\.png$/.test(item.name));
  expect(media.length).toBeGreaterThan(0);
  const bytes = await Promise.all(media.map((item) => item.async('base64')));
  expect(bytes).toContain(ICON_PNG['triangle-alert']);
});
it('要点和标签同样纳入来源覆盖；旧结构和旧scene仍可读回导出', () => {
  const contentPlan = { facts: [{ text: '8套示范传感设备', source: 'user', excerpt: '接入8套示范传感设备' }] };
  expect(planDiagramContent({ ...cardSpec, contentPlan }, [], '接入8套示范传感设备').coverage).toBe('declared_facts_matched');
  const old = { title: '旧设计', layers: [{ title: '业务层', nodes: [{ id: 'a', title: '原节点', detail: '原说明' }] }] };
  const scene = JSON.parse(JSON.stringify(build(old)));
  expect(validateScene(scene)).toBe(scene);
  expect(sceneElements(scene).some((item) => item.type === 'icon')).toBe(false);
  expect(sceneSvg(scene)).toContain('原说明');
});

it('重复带字边不能静默丢标签；同样的旧重复边仍可去重', () => {
  const base = {
    ...cardSpec,
    edges: [
      { from: 'notice', to: 'dispatch' },
      { from: 'notice', to: 'dispatch' }
    ]
  };
  expect(layoutDiagram(base).edges).toHaveLength(1);
  expect(() => layoutDiagram({ ...base, edges: [...base.edges, { from: 'notice', to: 'dispatch', label: '不能丢失' }] })).toThrow(/标签冲突/);
});

it('两行标题和要点保留完整文字，第二排卡片不重叠；过长正文明确报错', () => {
  const spec = copy();
  spec.edges = [];
  spec.layers[0].nodes[0].title = '跨部门协同预警研判服务端';
  spec.layers[0].nodes[0].bullets[0].text = '核验事件与现场采集信息，保存完整的处理记录';
  spec.layers[0].nodes.push({ ...spec.layers[0].nodes[0], id: 'extra' });
  const model = layoutDiagram(spec);
  expect(model.layers[0].rows).toBe(2);
  expect(validateDiagramLayout(model)).toBe(true);
  const scene = build(spec);
  const group = scene.elements.flatMap((item) => item.children || []).find((item) => item.nodeId === 'notice');
  const text = group.children.filter((item) => item.type === 'text');
  expect(text.some((item) => item.lines.length === 2)).toBe(true);
  for (const item of text) expect(item.lines.at(-1).y).toBeLessThan(model.nodes[0].y + model.nodes[0].height);
  spec.layers[0].nodes[0].bullets[0].text = '字'.repeat(80);
  expect(() => layoutDiagram(spec)).toThrow(/容量/);
});

it('设计稿锁定图标素材版本，不能用同名图标悄悄替换旧稿', () => {
  const scene = build(cardSpec);
  const icon = sceneElements(scene).find((item) => item.type === 'icon');
  expect(icon.assetVersion).toBe('lucide-0.577.0');
  icon.assetVersion = 'unknown-version';
  expect(() => validateScene(scene)).toThrow();
});
