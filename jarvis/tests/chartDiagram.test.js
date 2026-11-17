/** 2026-11-17 用户：他的50种图“全部做，统一发版”。每种图用中文样例真实排版、渲染、导出可编辑PPT */
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { CHART_TYPES, CHART_SHAPES, CHART_DESCRIPTION, createChartTool } from '../src/agent/chartDiagramTool.js';
import { composeSceneSvg, composeScenePptx, themeOf } from '../src/agent/chartScene.js';
import { CHART_SAMPLES } from './fixtures/chartSamples.js';
import { FLOW_KIND_SAMPLES } from './fixtures/flowKindSamples.js';
import { normalizeFlowchart, layoutFlowchart, composeFlowchartSvg, checkFlowchart } from '../src/agent/flowchart.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { decodePngRgba } from '../src/agent/posterContrast.js';
import { collection, useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';

beforeEach(async () => { useBackend(null); for (const name of ['files', 'kv', 'sessions']) await collection(name).clear(); });
const build = (type, sample = CHART_SAMPLES[type]) => {
  const theme = themeOf('blue'), laid = CHART_TYPES[type]({ ...sample.data, title: sample.title, subtitle: sample.subtitle || '' }, theme);
  return { ...laid, title: sample.title, background: theme.background };
};
const texts = scene => scene.items.filter(i => i.t === 'text').flatMap(i => i.rows).join('|');

describe('26种图表/图示', () => {
  it('每种类型都有样例、说明里写了字段', () => {
    expect(Object.keys(CHART_SAMPLES).sort()).toEqual(Object.keys(CHART_TYPES).sort());
    expect(Object.keys(CHART_SHAPES).sort()).toEqual(Object.keys(CHART_TYPES).sort());
    for (const type of Object.keys(CHART_TYPES)) expect(CHART_DESCRIPTION).toContain(type + '=');
  });
  it.each(Object.keys(CHART_SAMPLES))('%s：所有图元在画布内，文字原样出现，SVG通过白名单', type => {
    const scene = build(type);
    for (const item of scene.items) {
      const xs = item.t === 'rect' ? [item.x, item.x + item.w] : item.t === 'ellipse' ? [item.cx - item.rx, item.cx + item.rx] : item.t === 'line' ? [item.x1, item.x2] : item.points ? item.points.map(p => p[0]) : [item.x];
      const ys = item.t === 'rect' ? [item.y, item.y + item.h] : item.t === 'ellipse' ? [item.cy - item.ry, item.cy + item.ry] : item.t === 'line' ? [item.y1, item.y2] : item.points ? item.points.map(p => p[1]) : [item.y, item.y + (item.h || 0)];
      for (const x of xs) { expect(x).toBeGreaterThanOrEqual(-1); expect(x).toBeLessThanOrEqual(scene.width + 1); }
      for (const y of ys) { expect(y).toBeGreaterThanOrEqual(-1); expect(y).toBeLessThanOrEqual(scene.height + 1); }
    }
    expect(texts(scene)).toContain(CHART_SAMPLES[type].title);
    expect(composeSceneSvg(scene)).toContain('<svg');
  });
  it.each(['bar', 'gantt', 'sequence', 'er', 'fishbone', 'sankey', 'journey', 'quadrant'])('%s：真实渲染PNG尺寸正确、字体核验通过；PPTX里文字可编辑', async type => {
    const scene = build(type), svg = composeSceneSvg(scene), out = await renderVisualScene(svg, {});
    const png = await decodePngRgba(new Uint8Array(await out.blob.arrayBuffer()));
    expect(png.width).toBe(Number(/width="(\d+)"/.exec(svg)[1]));
    expect(out.fontCheck.status).toBe('passed');
    const slide = await (await JSZip.loadAsync(await (await composeScenePptx(scene)).arrayBuffer())).file('ppt/slides/slide1.xml').async('string');
    expect(slide).toContain(CHART_SAMPLES[type].title);
  }, 60000);
  it('数字原样标注：柱状图每个值、瀑布图期末合计都在图上', () => {
    const bar = texts(build('bar'));
    for (const v of [820, 960, 1180, 1390]) expect(bar).toContain(String(v));
    expect(texts(build('waterfall'))).toContain('550');
  });
  it('不合规数据直接报错，不截字、不猜', () => {
    expect(() => build('bar', { title: 't', data: { categories: ['a', 'b'], series: [{ name: 's', values: [1] }] } })).toThrow(/values/);
    expect(() => build('pie', { title: 't', data: { items: [{ label: 'a', value: -1 }, { label: 'b', value: 2 }] } })).toThrow(/负/);
    expect(() => build('gantt', { title: 't', data: { tasks: [{ label: '任务', start: '下周', end: '2026-01-01' }] } })).toThrow(/日期/);
    expect(() => build('quadrant', { title: 't', data: { ...CHART_SAMPLES.quadrant.data, items: [{ label: 'x', x: 2, y: 0.5 }] } })).toThrow(/0到1/);
    expect(() => build('sequence', { title: 't', data: { participants: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], messages: [{ from: 'a', to: 'z', text: 'hi' }] } })).toThrow(/已有参与方/);
    expect(() => build('timeline', { title: 't', data: { events: [{ date: '2020', label: '事'.repeat(25) }, { date: '2021', label: '好' }] } })).toThrow(/精简/);
  });
  it('甘特图：分组单独一行，里程碑和今天线都在；服务蓝图有可见线', () => {
    const g = build('gantt'), t = texts(g);
    for (const w of ['筹备', '建设', '开业', '今天']) expect(t).toContain(w);
    expect(g.items.some(i => i.t === 'polygon')).toBe(true);
    expect(texts(build('blueprint'))).toContain('可见线');
  });
});

describe('create_chart 工具', () => {
  it('交付PNG/SVG/PPTX/源稿；用源稿改数据另存不覆盖原稿', async () => {
    const tool = createChartTool({ renderVisualScene });
    const first = JSON.parse(await tool.run({ type: 'bar', ...CHART_SAMPLES.bar, path: '图表/营收' }));
    expect(first).toMatchObject({ kind: 'chart', type: 'bar', status: 'complete', sourcePath: '图表/营收.chart.json', visual: 'not_checked' });
    expect(first.files.map(f => f.format)).toEqual(['json', 'svg', 'png', 'pptx']);
    const revised = JSON.parse(await tool.run({ source_path: first.sourcePath, title: '2026年各季度营收（修订）' }));
    expect(revised.sourcePath).not.toBe(first.sourcePath);
    expect(JSON.parse(await ws.readText(first.sourcePath)).title).toBe('2026年各季度营收');
    await expect(tool.run({ type: 'nope', title: 't', data: {} })).rejects.toThrow(/图表类型/);
  }, 60000);
});

describe('流程图引擎新增：树形、组织架构、状态、步骤、循环', () => {
  it.each(Object.keys(FLOW_KIND_SAMPLES))('%s：能排版、无结构问题、SVG通过白名单', kind => {
    const flow = normalizeFlowchart(FLOW_KIND_SAMPLES[kind]), layout = layoutFlowchart(flow);
    expect(flow.flowKind).toBe(kind);
    expect(checkFlowchart(flow, layout).issues).toEqual([]);
    expect(composeFlowchartSvg(flow, layout)).toContain(FLOW_KIND_SAMPLES[kind].title);
  });
  it('步骤图、循环图不给连线自动按顺序连；循环首尾相接；组织架构不画箭头；树形从上级正中出主干', () => {
    const steps = normalizeFlowchart(FLOW_KIND_SAMPLES.steps), loop = normalizeFlowchart(FLOW_KIND_SAMPLES.loop);
    expect(steps.edges).toHaveLength(4);
    expect(loop.edges.at(-1)).toEqual({ from: 'e', to: 'a' });
    expect(composeFlowchartSvg(steps)).toMatch(/>1<\/text>/);
    const org = normalizeFlowchart(FLOW_KIND_SAMPLES.org), orgSvg = composeFlowchartSvg(org);
    expect(orgSvg.match(/<polygon/g)).toBeNull();
    const tree = normalizeFlowchart(FLOW_KIND_SAMPLES.tree), layout = layoutFlowchart(tree);
    const starts = layout.edges.filter(e => e.from === 'g').map(e => e.points[0][0]);
    expect(new Set(starts).size).toBe(1);
  });
});

describe('画图请求调对工具', () => {
  it('甘特图/时序图/鱼骨图/柱状图等调出create_chart', async () => {
    const { taskToolCore } = await import('../src/agent/taskToolProfile.js');
    for (const text of ['做个项目甘特图', '画一个时序图', '画个鱼骨图分析原因', '做一张柱状图', '画个用户旅程图', '画数据库ER图']) expect(taskToolCore({}, text).has('create_chart')).toBe(true);
    const ppt = taskToolCore({}, '做个汇报PPT，里面放一张季度营收柱状图');
    expect(ppt.has('create_chart')).toBe(true);
    expect(ppt.has('create_document')).toBe(true);
  });
});
