import { beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createPosterDeliveryTool } from '../src/agent/posterDeliveryTool.js';
import { templateDesignInput } from '../src/agent/posterTemplates.js';
import { templateWithArt } from '../src/agent/posterTemplateArt.js';
import { planLayerDesign } from '../src/agent/layeredDesignLayout.js';
import { checkLayerOverlap, reviewLayeredDesign } from '../src/agent/layeredDesignQuality.js';
import { checkDesignPresentation } from '../src/agent/layeredDesignPresentation.js';
import { posterContent, designThinkingIssues } from '../src/agent/posterContent.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { collection, useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';

const path = '素材/城市.jpg';
const chart = { title: '两馆周末开放时长', unit: '小时', source: '示例馆讯', points: [{ label: '北馆', value: 8 }, { label: '南馆', value: 6.5 }] };
const template = { id: 'news_brief', content: {
  headline: '城市周报', date: '示例刊', lead: 3, items: [
    { title: '两馆延长周末开放', topic: '文化', chart },
    { title: '河岸步道开放', topic: '生活', detail: '沿河慢行线路增设夜间照明。' },
    { title: '新展走进城市街区', topic: '文化', detail: '把展厅延伸到街角，让居民在步行途中遇见作品。', image: path, image_credit: '版式测试配图', source: '示例展讯' },
    { title: '旧剧场开启导览', topic: '文化' }, { title: '公园增加休息区', topic: '生活', image: path, image_credit: '示例素材' },
    { title: '街区调整公交站位', topic: '出行' }, { title: '新增单车停放点', topic: '出行' }
  ]
} };

beforeEach(async () => {
  useBackend(null);
  for (const name of ['files', 'kv', 'sessions']) await collection(name).clear();
});
it('七条原文各出现一次；头条可选第三条，配图、来源、图表随所属报道', () => {
  const d = planLayerDesign(templateDesignInput({ template }));
  const text = d.layers.filter(n => n.type === 'text');
  for (const item of template.content.items) expect(text.filter(n => n.text === item.title)).toHaveLength(1);
  const lead = text.find(n => n.id === 'news-lead');
  expect(lead).toMatchObject({ text: template.content.items[2].title, group: 'story-3' });
  expect(lead.y).toBeLessThan(text.find(n => n.id === 'story-1-title').y);
  expect(text.find(n => n.id === 'story-4-title').y).toBeLessThan(text.find(n => n.id === 'story-2-title').y);
  expect(d.layers.filter(n => n.type === 'image').map(n => n.group)).toEqual(['story-3', 'story-5']);
  expect(d.assets).toHaveLength(1);
  expect(d.layers.find(n => n.type === 'chart')).toMatchObject({ group: 'story-1', points: chart.points });
  expect(checkLayerOverlap(d).status).toBe('passed');
  expect(checkDesignPresentation(d).status).toBe('passed');
});
it('不同口径新闻各有一个百分比时不会要求捏造一张对比图', () => {
  const items = ['客流增长 8%', '图书借阅增长 3%', '降雨概率 20%'].map(title => ({ title }));
  const design = planLayerDesign(templateDesignInput({ template: { id: 'news_brief', content: { headline: '快讯', lead: 2, items } } }));
  expect(designThinkingIssues(design)).toEqual([]);
});
it('缺少图片出处、图表来源、原值或头条越界时给出具体原因', () => {
  const build = (item, lead = 1) => templateDesignInput({ template: { id: 'news_brief', content: { headline: '周报', lead, items: [item, { title: '其他报道' }] } } });
  expect(() => build({ title: '条目', image: path })).toThrow(/出处/);
  expect(() => build({ title: '条目', chart: { ...chart, source: '' } })).toThrow(/来源/);
  expect(() => build({ title: '条目', chart: { ...chart, points: [{ label: '北馆', value: null }, chart.points[1]] } })).toThrow(/数值/);
  expect(() => build({ title: '条目' }, 3)).toThrow(/lead/);
});
it('仅给缺图头条生成一次横向示意插画，已有图片优先', async () => {
  const blob = new Blob([await readFile(new URL('../src/assets/ppt-sources/source-cobalt-3.jpg', import.meta.url))], { type: 'image/jpeg' });
  const imageGen = vi.fn(async () => ({ blob }));
  const spec = structuredClone(template);
  spec.image_prompt = '街区艺术展';
  await templateWithArt({ template: spec }, { imageGen });
  expect(imageGen).not.toHaveBeenCalled();
  delete spec.content.items[2].image;
  const { input, art } = await templateWithArt({ template: spec }, { imageGen });
  expect(imageGen.mock.calls[0][0]).toMatchObject({ size: '1536x1024' });
  expect(art.status).toBe('generated');
  expect(input.design.layers.find(n => n.text === 'AI 示意插画').group).toBe('story-3');
});
it('半透明遮罩后的配图仍然可见，实色遮挡不算插图', () => {
  const photo = { type: 'image', x: 0, y: 0, w: 400, h: 300 };
  const cover = { ...photo, type: 'shape' };
  const check = fade => posterContent({ width: 400, height: 300, layers: [photo, { ...cover, fade }] }).status;
  expect(check({ stops: [[0, 0.1], [1, 0.95]] })).toBe('passed');
  expect(check({ stops: [[0, 1], [1, 1]] })).toBe('failed');
  expect(check()).toBe('failed');
});
it('手机预览缺失或与主图合计超过预算，不将新闻海报记为视觉通过', async () => {
  const d = planLayerDesign(templateDesignInput({ template }));
  const visionLlm = vi.fn();
  for (const previewPng of [null, { size: 12e6 }]) {
    expect((await reviewLayeredDesign({ visionLlm }, d, { size: 100 }, { previewPng })).status).toBe('not_checked');
  }
  expect(visionLlm).not.toHaveBeenCalled();
});
it('正常工具入口实际生成成品、390像素手机图和可编辑文件，两张图片一起送审', async () => {
  const jpeg = await readFile(new URL('../src/assets/ppt-sources/source-cobalt-3.jpg', import.meta.url));
  await ws.write(path, new Blob([jpeg], { type: 'image/jpeg' }));
  const visionLlm = vi.fn(async () => JSON.stringify({ copyMatches: true, readable: true, noOverlap: true, leadClear: true, relatedToTopic: true, visualsPresent: true, integrated: true, issues: [] }));
  const tool = createPosterDeliveryTool({ renderVisualScene, visionLlm });
  const r = JSON.parse(await tool.run({ template }, { executionScope: {}, rawRequestText: '把七条新闻做成图文并茂的海报' }));
  expect(r.errors).toEqual([]);
  expect(r.status).toBe('complete');
  expect(r.phonePreview).toMatchObject({ width: 390, readback: 'passed' });
  expect(r.files.map(f => f.format)).toEqual(['png', 'svg', 'pptx']);
  expect(r.visualReport.checks.leadClear).toBe(true);
  expect(visionLlm.mock.calls[0][0].images).toHaveLength(2);
  const png = new DataView(await (await ws.readBlob(r.phonePreview.path)).arrayBuffer());
  expect(png.getUint32(16)).toBe(390);
  const incomplete = createPosterDeliveryTool({ renderVisualScene, visionLlm: async () => JSON.stringify({
    copyMatches: true, readable: true, noOverlap: true, visualsPresent: true, relatedToTopic: true, integrated: true, issues: []
  }) });
  const candidate = JSON.parse(await incomplete.run({ template }, { executionScope: {}, rawRequestText: '再做一张图文并茂的海报' }));
  expect(candidate.visual).toBe('not_checked');
  expect(candidate.contentCheck.semantic).toBe('not_checked');
  expect(candidate.status).toBe('partial');
}, 120000);
