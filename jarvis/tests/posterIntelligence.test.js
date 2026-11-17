import { beforeEach, it, expect, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { collection, useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { createPosterTool } from '../src/agent/posterTool.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { designFollowup, recallDesignTask, designTaskRequirement } from '../src/agent/designTaskMemory.js';
import { planLayerDesign, planReadableLayerDesign } from '../src/agent/layeredDesignLayout.js';
import { wrapParagraphs } from '../src/agent/posterComposition.js';
import { verifyDeliveryAccess } from '../src/agent/deliveryAccess.js';
import { compactPosterModelReceipt } from '../src/agent/posterModelReceipt.js';
import { posterCompositionIssues } from '../src/agent/posterContent.js';

beforeEach(async () => {
  useBackend(null);
  for (const name of ['files', 'kv', 'sessions']) await collection(name).clear();
});
// 2026-11-17 起新自由稿须写构思（design.concept），夹具补上；断言不变
const input = (title = '新闻海报') => ({ title, width: 512, height: 768, design: { layout: 'free', concept: { idea: '大字标题直给要点', relation: 'type-led' }, layers: [
  { id: 'title', type: 'text', text: title, x: 40, y: 40, w: 430, h: 160, fontSize: 40, color: '#111111', role: 'heading' }
] } });
// 真实PNG容器，文字与视觉仍为协议夹具；实际字体/成品由独立E2E验证。
const raster = vi.fn(async svg => {
  const width = Number(svg.match(/width="(\d+)"/)[1]), height = Number(svg.match(/height="(\d+)"/)[1]);
  const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, width, height);
  return { blob: new Blob([canvas.toBuffer('image/png')], { type: 'image/png' }), fontCheck: { status: 'passed' } };
});
it('正式工具三次参数失败后仍能出图，参数修正不占实际试排', async () => {
  const tool = createPosterTool({ renderVisualScene: raster }), options = { executionScope: {}, rawRequestText: '做新闻海报' };
  for (const invalid of [{}, { ...input(), width: 1 }, { ...input(), design: { layout: 'free', layers: [{ ...input().design.layers[0], x: 510 }] } }]) {
    const result = JSON.parse(await tool.run(invalid, options));
    expect(result.delivery.attempts).toBe(0);
    expect(result.delivery.retryAllowed).toBe(true);
  }
  const result = JSON.parse(await tool.run(input(), options));
  expect(result.delivery).toMatchObject({ attempts: 1, corrections: 3, retryAllowed: true });
  expect(result.deliveryAccess.status).toBe('ready');
  expect(result.delivery.primaryPath).toBeTruthy();
});
it('参数修正有独立上限，不能无限换参数，已有原图不变', async () => {
  const options = { executionScope: {} }, tool = createPosterTool({ renderVisualScene: raster });
  for (let n = 0; n < 4; n++) await tool.run({ title: '坏稿' + n, design: { layout: 'free', layers: [] } }, options);
  const result = JSON.parse(await tool.run(input(), options));
  expect(result.retryAllowed).toBe(false);
  expect(result.files).toEqual([]);
  expect(result.notice).toContain('参数纠正');
});
it('海报改用Demo仍继承图文要求和参数预算，不能以纯文本稿冒充完成', async () => {
  const options = { executionScope: {}, rawRequestText: '做图文并茂海报' }, ctx = { renderVisualScene: raster };
  const first = JSON.parse(await createPosterTool(ctx).run(input(), options));
  expect(first.contentCheck.status).toBe('failed');
  const demo = JSON.parse(await createVisualDemoTool(ctx).run(input(), { ...options, rawRequestText: '换个方式给我Demo' }));
  expect(demo.status).toBe('partial');
  expect(demo.contentCheck.status).toBe('failed');
  expect(demo.delivery.id).toBe(first.delivery.id);
  expect(demo.delivery.corrections).toBe(2);
  expect(demo.delivery.attempts).toBe(0);
});
it('真实源稿与约束可跨任务实例恢复，当前新问题和失效路径不恢复', async () => {
  const sessionId = 'design-memory';
  await collection('sessions').put({ id: sessionId, messages: [] });
  const result = JSON.parse(await createPosterTool({ renderVisualScene: raster }).run(input(), { executionScope: {}, sessionId, rawRequestText: '制作新闻海报' }));
  const saved = await recallDesignTask(sessionId, '只改标题为每日观察');
  expect(saved.sourcePath).toBe(result.designPath);
  expect(await designTaskRequirement('只改标题', { sessionId })).toContain(result.designPath);
  expect(await recallDesignTask(sessionId, '查一下今天股票')).toBeNull();
  expect(await recallDesignTask(sessionId, '继续', { history: [{ role: 'user', content: '查今天股票' }] })).toBeNull();
  expect(await recallDesignTask('another-session', '只改标题')).toBeNull();
  await ws.removeVirtual(result.designPath);
  expect(await recallDesignTask(sessionId, '只改标题')).toBeNull();
});
it.each(['为什么失败', '先不做，分析布局', '如何做海报', '查股价', '计划怎么做'])('解释/新问题不自动执行旧任务：%s', text => expect(designFollowup(text)).toBe(false));
it('另做新海报并补Demo不能误续旧作品；明确补Demo可以续接', () => {
  expect(designFollowup('再做一张海报并补同稿Demo')).toBe(false);
  expect(designFollowup('给我补一个Demo')).toBe(true);
});
it('杂志式栏目配图关联自己的图层分组，不占用一整块空头图', () => {
  const d = planLayerDesign({ title: '每日观察', width: 1080, height: 2600, design: { layout: 'magazine', assets: [
    { id: 'port', path: '港口.png' }, { id: 'rain', path: '降水.png' }
  ], sections: [ { title: '港口运输', body: '运输情况摘要', asset: 'port' }, { title: '降水变化', body: '降水情况摘要', asset: 'rain' }, { title: '科技动态', body: '科技摘要' } ] } });
  const images = d.layers.filter(n => n.type === 'image');
  expect(images.map(n => n.asset)).toEqual(['port', 'rain']);
  for (const n of images) expect(d.layers.some(t => t.type === 'text' && t.group === n.group)).toBe(true);
  expect(images[0].x).toBeGreaterThan(images[1].x);
  expect(d.layers.filter(n => n.type === 'text').map(n => n.text).join('')).toContain('科技摘要');
});
it('自动高度只在未指定尺寸的新稿启用；明确画幅仍报溢出而不丢字', () => {
  const draft = { title: '新闻', design: { layout: 'magazine', sections: Array.from({ length: 7 }, (_, i) => ({ title: '新闻标题' + i, body: '保留全部正文和日期单位。'.repeat(2) })) } };
  const design = planReadableLayerDesign(draft, [1080, 1920], true);
  expect(design.height).toBeGreaterThan(1920);
  expect(() => planReadableLayerDesign(draft, [1080, 1920], false)).toThrow();
  expect(design.layers.filter(n => /-body$/.test(n.id))).toHaveLength(7);
});
it.each(['通道占全球约1/5原油海运。', '更新时间2026年11月16日。', '风速6.8m/s，降水28.4mm。'])('数字单位完整保留且标点不单独成行：%s', text => {
  const rows = wrapParagraphs(text, 28, 240);
  expect(rows.join('')).toBe(text);
  expect(rows.every(row => !/^[，。！？；：、）】》]/.test(row))).toBe(true);
  if (text.includes('1/5')) expect(rows.some(row => row.includes('1/5'))).toBe(true);
});
it('交付检查拒绝缺失文件和伪PNG，并返回真实像素', async () => {
  await ws.write('假.png', new Blob(['not png']));
  const bytes = createCanvas(300, 500).toBuffer('image/png');
  await ws.write('真.png', new Blob([bytes]));
  const result = await verifyDeliveryAccess(['缺失.png', '假.png', '真.png']);
  expect(result.status).toBe('partial');
  expect(result.files.map(f => f.readback)).toEqual(['failed', 'failed', 'passed']);
  expect(result.files[2]).toMatchObject({ width: 300, height: 500 });
});
it('Demo长回执也保留有效有界JSON和HTML入口，不能退回半截摘要', () => {
  const output = compactPosterModelReceipt({ name: 'create_visual_demo', content: JSON.stringify({ kind: 'visual_demo', status: 'partial', textRendering: 'program', files: [
    { format: 'png', path: '最终.png', readback: 'passed', structure: 'passed', render: 'passed' },
    { format: 'html', path: '演示.html', readback: 'passed', structure: 'passed' }
  ], notes: ['x'.repeat(12000)], errors: [{ code: 'DESIGN_VISUAL_NEEDS_REVIEW' }] }) });
  expect(output.length).toBeLessThanOrEqual(2000);
  expect(JSON.parse(output)).toMatchObject({ kind: 'visual_demo', status: 'partial', errorCount: 1 });
  expect(JSON.parse(output).files.some(f => f.path === '演示.html')).toBe(true);
});
it('大头图加四个同宽卡片不能冒充融合图文，独立横向大屏不误拦', () => {
  const d = { width: 1080, height: 1920, layers: [
    { id: 'hero', type: 'image', x: 0, y: 0, w: 1080, h: 720, group: 'hero' },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `section-${i + 1}-card`, type: 'shape', x: 60, y: 740 + 250 * i, w: 960, h: 220, group: `section-${i + 1}` }))
  ] };
  expect(posterCompositionIssues(d)[0].code).toBe('DESIGN_DETACHED_ILLUSTRATION');
  expect(posterCompositionIssues({ ...d, width: 3840, height: 2160 })).toEqual([]);
});
it('中文标题不会把协同拆成一个孤字，长脚注在可读字号下自动留足高度', () => {
  const rows = wrapParagraphs('港口运行 · 智慧协同', 44, 497.2);
  expect(rows).toEqual(['港口运行 · 智慧协同']);
  const d = planLayerDesign({ title: '城市观察', footer: '保留真实来源和完整日期，不能丢掉脚注。'.repeat(8), width: 1080, height: 2600,
    design: { layout: 'editorial', sections: [{ title: '栏目内容', body: '全部正文保留' }] } });
  const footer = d.layers.find(n => n.id === 'footer');
  expect(footer.h).toBeGreaterThan(55);
  expect(footer.minFontSize * 390 / d.width).toBeGreaterThanOrEqual(12);
});
