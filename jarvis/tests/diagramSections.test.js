import { it, expect } from 'vitest';
import { platformSpec } from '../e2e/fixtures/diagram-platform.mjs';
import { layoutDiagram, validateDiagramLayout } from '../src/agent/diagramModel.js';
import { diagramScene, validateScene, sceneElements } from '../src/agent/diagramScene.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';
import { diagramRoutes } from '../src/agent/diagramRoutes.js';
import { validateSvg } from '../src/agent/svgPreview.js';
import { planDiagramContent } from '../src/agent/diagramPlanning.js';
const copy = () => structuredClone(platformSpec);
const draw = (spec) => diagramScene(layoutDiagram(spec), spec.design);
const titles = (scene) =>
  sceneElements(scene)
    .filter((item) => item.type === 'text')
    .flatMap((item) => item.lines.map((line) => line.text))
    .join('');
it('完整8层组合保留31节点和三平台子层，节点无重叠、安全子集通过', () => {
  const model = layoutDiagram(platformSpec);
  expect(model.layers).toHaveLength(8);
  expect(model.nodes).toHaveLength(31);
  expect(model.width).toBe(1440);
  expect(validateDiagramLayout(model)).toBe(true);
  expect(model.layers.filter((layer) => layer.group)).toHaveLength(3);
  const scene = validateScene(draw(platformSpec));
  const svg = sceneSvg(scene);
  expect(() => validateSvg(svg)).not.toThrow();
  for (const layer of platformSpec.layers)
    for (const node of layer.nodes) {
      expect(titles(scene)).toContain(node.title);
      if (node.subtitle) expect(titles(scene)).toContain(node.subtitle);
    }
  expect(scene.elements[0].fill).toBe('#eff8ff');
  expect(svg).not.toMatch(/<image|<script|href=/);
});
it('18模块自动6列3行，不丢标题；超上限/含说明要报错', () => {
  const spec = {
    title: '模块示范',
    layers: [{ kind: 'grid', title: '模块层', nodes: Array.from({ length: 18 }, (_, index) => ({ id: String(index), title: '功能模块' + index })) }]
  };
  const model = layoutDiagram(spec);
  expect(model.layers[0].rows).toBe(3);
  expect(new Set(model.nodes.map((node) => node.x)).size).toBe(6);
  expect(draw(spec).design.theme).toBe('gov-blue');
  expect(titles(draw(spec))).toContain('功能模块17');
  expect(() => layoutDiagram({ ...spec, layers: [{ ...spec.layers[0], nodes: spec.layers[0].nodes.slice(0, 7) }] })).toThrow(/8～18/);
  spec.layers[0].nodes[0].detail = '不能静默丢弃';
  expect(() => layoutDiagram(spec)).toThrow(/只展示标题/);
});
it('通栏必须一个节点，分栏2～4栏；不悄悄忽略要点或副标题', () => {
  for (const layer of [
    {
      kind: 'band',
      title: '错误',
      nodes: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' }
      ]
    },
    { kind: 'columns', title: '错误', nodes: [{ id: 'a', title: 'A' }] },
    { kind: 'cards', title: '错误', nodes: [{ id: 'a', title: 'A', subtitle: '必须展示' }] },
    {
      kind: 'columns',
      title: '错误',
      nodes: [
        { id: 'a', title: 'A', bullets: [{ text: '要点一' }, { text: '要点二' }] },
        { id: 'b', title: 'B' }
      ]
    }
  ])
    expect(() => layoutDiagram({ title: '验收', layers: [layer] })).toThrow();
});
it('平台分组必须连续；共同标题只画一次，不能多画出重复平台', () => {
  const scene = draw(platformSpec);
  expect(titles(scene).split('示范园区智慧协同管理平台')).toHaveLength(2);
  const spec = copy();
  spec.layers[4].group = undefined;
  expect(() => layoutDiagram(spec)).toThrow(/连续/);
});
it('跨层线路走外侧，不横穿平台标题；新组合层无边时不编造支撑关系', () => {
  const spec = copy();
  spec.edges = [{ from: 'terminal', to: 'ai' }];
  const model = layoutDiagram(spec);
  expect(model.width).toBe(1520);
  const route = diagramRoutes(model)[0];
  expect(route.points.some((point) => point.x > 1404)).toBe(true);
  expect(() => validateScene(draw(spec))).not.toThrow();
  spec.edges = [];
  expect(sceneElements(draw(spec)).filter((item) => item.type === 'path' && item.arrow)).toHaveLength(0);
});
it('密集网格和分栏不能套带字流程，旧三主题卡片默认布局不变', () => {
  const spec = copy();
  spec.edges = [{ from: 'service', to: 'data', label: '不适合' }];
  expect(() => layoutDiagram(spec)).toThrow(/仅用于cards/);
  for (const theme of ['navy', 'jade', 'charcoal']) {
    const old = {
      title: '旧设计',
      design: { theme },
      layers: [{ title: '原层', nodes: Array.from({ length: 4 }, (_, index) => ({ id: String(index), title: '原节点' })) }]
    };
    expect(layoutDiagram(old).structured).toBe(false);
    expect(layoutDiagram(old).nodes[0].x).toBe(240);
    expect(draw(old).design.theme).toBe(theme);
  }
});
it('43字蓝主题标题实际需两行，口号和首层不与第二行撞在一起', () => {
  const spec = copy();
  spec.title = '标'.repeat(43);
  const scene = draw(spec);
  const header = scene.elements.filter((item) => item.type === 'text');
  const lastTitleY = Math.max(...header.filter((item) => item.fontSize === 32).flatMap((item) => item.lines.map((line) => line.y)));
  const firstMessageY = Math.min(...header.filter((item) => item.fontSize === 16).flatMap((item) => item.lines.map((line) => line.y)));
  expect(firstMessageY - lastTitleY).toBeGreaterThan(20);
  expect(layoutDiagram(spec).layers[0].y).toBe(160);
});
it('来源覆盖包含分栏副标题和平台标题，不把未展示的audience当已入图', () => {
  const spec = copy();
  spec.contentPlan = { facts: [{ text: '示范园区智慧协同管理平台', source: 'user', excerpt: '示范园区智慧协同管理平台' }] };
  expect(planDiagramContent(spec, [], '示范园区智慧协同管理平台').coverage).toBe('declared_facts_matched');
  spec.contentPlan.facts[0] = { text: '政企项目方案沟通', source: 'user', excerpt: '政企项目方案沟通' };
  expect(() => planDiagramContent(spec, [], '政企项目方案沟通')).toThrow(/未进入/);
});

it('新组合默认从展示到基础设施，显式反向仍有效；不改变旧层默认方向', () => {
  const spec = copy();
  delete spec.direction;
  expect(layoutDiagram(spec).layers[0].title).toBe('界面展示层');
  expect(layoutDiagram({ ...spec, direction: 'bottom-up' }).layers[0].title).toBe('安全保障');
  const old = {
    title: '旧图',
    layers: [
      { title: '第一层', nodes: [{ id: 'a', title: 'A' }] },
      { title: '第二层', nodes: [{ id: 'b', title: 'B' }] }
    ]
  };
  expect(layoutDiagram(old).layers[0].title).toBe('第二层');
});

it('分组内的通栏仍有实色背景，两行网格保留完整文字', () => {
  const spec = { title: '小样', layers: [{ title: '反馈', kind: 'band', group: '共同平台', nodes: [{ id: 'a', title: '结果归档与状态反馈' }] }] };
  const scene = draw(spec);
  const band = scene.elements.find((item) => item.type === 'group' && item.layer === '反馈');
  expect(band.children.some((item) => item.type === 'rect' && item.fill === '#087fca')).toBe(true);
  const grid = copy();
  grid.layers[3].nodes[0].title = '跨部门事件协同与全过程处理管理';
  const group = sceneElements(draw(grid)).find((item) => item.type === 'group' && item.nodeId === 'module-0');
  const contents = group.children.filter((item) => item.type === 'text').flatMap((item) => item.lines);
  expect(contents).toHaveLength(2);
  expect(contents.map((line) => line.text).join('')).toBe(grid.layers[3].nodes[0].title);
});

it('分栏强调色确实渲染，原文登记可以来自实际展示的副标题', () => {
  const spec = copy();
  spec.layers[4].nodes[0].accent = 'orange';
  spec.contentPlan = { facts: [{ text: 'GIS / 事件 / 流程 / 检索', source: 'user', excerpt: 'GIS / 事件 / 流程 / 检索' }] };
  expect(planDiagramContent(spec, [], 'GIS / 事件 / 流程 / 检索').coverage).toBe('declared_facts_matched');
  const group = sceneElements(draw(spec)).find((item) => item.nodeId === 'service');
  expect(group.children.some((item) => item.type === 'rect' && item.fill === '#bd6200')).toBe(true);
});
