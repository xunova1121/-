/** 2026-11-17 用户：希望未央有独立思考，自己排版，不按固定几种样式。构思 → 草图对比 → 出图后设计自审（最多两轮） */
import { describe, expect, it, vi } from 'vitest';
import { normalizeLayerDesign, normalizeConcept } from '../src/agent/layeredDesignInput.js';
import { planLayerDesign } from '../src/agent/layeredDesignLayout.js';
import { reviewLayeredDesign } from '../src/agent/layeredDesignQuality.js';
import { sketchPosters, sketchLayers } from '../src/agent/posterSketch.js';
import { createPosterDeliveryTool } from '../src/agent/posterDeliveryTool.js';
import { POSTER_GUIDANCE } from '../src/agent/posterRouting.js';
import { VISUAL_SCENE_GUIDANCE } from '../src/agent/visualSceneRouting.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import * as ws from '../src/agent/workspace.js';

const concept = { idea: '晨光里的产房窗，象征新生', relation: 'overlay', focus: '标题', mood: '温暖专业' };
const layers = [
  { id: 'hero', type: 'image', asset: 'hero', x: 0, y: 0, w: 1080, h: 1920, detail: '晨光中的产房窗户' },
  { id: 'title', type: 'text', text: '产科医生怎么选', x: 80, y: 1300, w: 920, h: 140, fontSize: 104, weight: 700, color: '#FFFFFF', role: 'heading' },
  { id: 'body', type: 'text', text: '看专业方向、看团队、问清主刀', x: 80, y: 1480, w: 920, h: 60, fontSize: 44, color: '#FFFFFF', role: 'body' }
];

describe('设计构思', () => {
  it('构思写进源稿并在重新归一化后保留；未知图文关系记为other，超长截断，不因此拒稿', () => {
    const d = planLayerDesign({ title: '产科医生怎么选', design: { layout: 'free', concept, layers: layers.slice(1) } });
    expect(d.concept).toEqual(concept);
    expect(normalizeLayerDesign(structuredClone(d)).concept).toEqual(concept);
    expect(normalizeConcept({ idea: '字'.repeat(300), relation: 'poster-template-7' })).toEqual({ idea: '字'.repeat(160), relation: 'other' });
    expect(() => normalizeConcept('上图下文')).toThrow(/构思/);
  });
  it('海报指引要求先构思、可草图比较、按版式生图、卡片底图先算位置', () => {
    for (const word of ['design.concept', 'sketches', '不套固定版式', 'purpose=poster_slots', 'designReview.suggestions']) expect(POSTER_GUIDANCE).toContain(word);
  });
  it('Demo指引写明分工：图表程序画、图片生图、交互网页，并统一字体/网格/配色', () => {
    for (const word of ['绝不让生图模型画图表', 'purpose=poster_art', '内置矢量图标', '离线网页', '一种字体', '主图主色', '手机卡片预览']) expect(VISUAL_SCENE_GUIDANCE).toContain(word);
  });
});

describe('草图对比', () => {
  it('图片层换成灰色占位和说明，不需要先生成配图', () => {
    const out = sketchLayers(layers);
    expect(out[0]).toMatchObject({ id: 'hero', type: 'shape', decorative: true });
    expect(out[1]).toMatchObject({ id: 'hero-label', type: 'text', text: '图：晨光中的产房窗户' });
    expect(out.slice(2)).toEqual(layers.slice(1));
  });
  it('2个草图真实渲染并保存为过程文件，一次看图比较给出选择和改法；排不下的草图如实报错', async () => {
    const visionLlm = vi.fn(async () => JSON.stringify({ choice: 1, reasons: ['满版大图压字，主次清楚'], suggestions: ['标题上移80像素'], scores: [{ index: 1, score: 8 }, { index: 9, score: 3 }] }));
    const result = await sketchPosters({ title: '产科医生怎么选', sketches: [
      { concept, layers },
      { concept: { idea: '上图下文', relation: 'top-image' }, layers: [{ id: 'title', type: 'text', text: '产科医生怎么选'.repeat(40), x: 80, y: 100, w: 300, h: 40, fontSize: 60 }] }
    ] }, { visionLlm, renderVisualScene }, { width: 1080, height: 1920 });
    expect(result.status).toBe('ready');
    expect(result.sketches[0].path).toMatch(/^\.workflows\/sketches\/[\w-]+\/sketch-1\.png$/);
    expect(await ws.exists(result.sketches[0].path)).toBe(true);
    expect(result.sketches[1].error).toBeTruthy();
    expect(result.sketches[1].path).toBeUndefined();
    expect(visionLlm).toHaveBeenCalledTimes(1);
    expect(visionLlm.mock.calls[0][0].images).toHaveLength(1);
    expect(result.review).toEqual({ status: 'checked', choice: 1, reasons: ['满版大图压字，主次清楚'], suggestions: ['标题上移80像素'], scores: [{ index: 1, score: 8 }] });
    expect(result.next).toContain('不算试排');
  }, 60000);
  it('看图模型选了不存在的草图：不采信', async () => {
    const result = await sketchPosters({ title: 't', sketches: [{ layers }] }, { visionLlm: async () => '{"choice":3}', renderVisualScene }, { width: 1080, height: 1920 });
    expect(result.review.status).toBe('not_checked');
  }, 60000);
  it('make_poster收到sketches只做草图，不出正式稿、不算试排', async () => {
    const tool = createPosterDeliveryTool({ renderVisualScene });
    const begin = vi.fn();
    const result = JSON.parse(await tool.run({ title: '产科医生怎么选', sketches: [{ concept, layers }] }, { executionScope: {}, beginPosterAttempt: begin }));
    expect(result.kind).toBe('poster_sketch');
    expect(result.review.status).toBe('not_checked');
    expect(begin).not.toHaveBeenCalled();
    expect((await ws.list()).filter(f => /海报|\.design\.json$/.test(f.path) && !f.path.startsWith('.workflows/'))).toEqual([]);
  }, 60000);
});

describe('出图后设计自审', () => {
  const design = planLayerDesign({ title: '产科医生怎么选', design: { layout: 'free', concept, layers: layers.slice(1) } });
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  it('同一次看图返回主次/融合/留白/构思和改法，提示里带上构思', async () => {
    const visionLlm = vi.fn(async () => JSON.stringify({ copyMatches: true, readable: true, noOverlap: true, issues: [],
      design: { hierarchy: true, cohesive: false, balanced: true, concept: null, suggestions: ['标题压到照片暗部', 7] } }));
    const report = await reviewLayeredDesign({ visionLlm }, design, png);
    expect(visionLlm).toHaveBeenCalledTimes(1);
    expect(visionLlm.mock.calls[0][0].prompt).toContain('晨光里的产房窗');
    expect(visionLlm.mock.calls[0][0].system).toContain('cohesive');
    expect(report.status).toBe('passed'); // 设计意见不改变原来的成品核验结论
    expect(report.design).toEqual({ hierarchy: true, cohesive: false, balanced: true, distinctive: null, concept: null, suggestions: ['标题压到照片暗部'] });
  });
  it('没返回design对象时不编造', async () => {
    const report = await reviewLayeredDesign({ visionLlm: async () => JSON.stringify({ copyMatches: true, readable: true, noOverlap: true, issues: [] }) }, design, png);
    expect(report.design).toBeUndefined();
  });
});

describe('设计自审轮数', () => {
  const input = { title: '产科医生怎么选', path: '自审/产科.png', design: { layout: 'free', concept, palette: { background: '#F4EFE6' }, layers: [
    { id: 'title', type: 'text', text: '产科医生怎么选', x: 80, y: 200, w: 920, h: 140, fontSize: 96, weight: 700, color: '#1D2430', role: 'heading' },
    { id: 'body', type: 'text', text: '看专业方向、看团队、问清主刀', x: 80, y: 400, w: 920, h: 60, fontSize: 44, color: '#1D2430', role: 'body' }] } };
  const visionLlm = async () => JSON.stringify({ copyMatches: true, readable: true, noOverlap: true, issues: [],
    design: { hierarchy: false, cohesive: true, balanced: false, concept: true, suggestions: ['标题放大并下移到视觉中心'] } });
  it('前两轮：主次/留白不达标要求整体再排，并带上改法', async () => {
    const receipt = JSON.parse(await createPosterDeliveryTool({ visionLlm, renderVisualScene }).run(input, { designReviewBlocking: () => true }));
    expect(receipt.status).toBe('partial');
    expect(receipt.errors).toContainEqual(expect.objectContaining({ code: 'DESIGN_LAYOUT_NEEDS_WORK', weak: ['hierarchy', 'balanced'], suggestions: ['标题放大并下移到视觉中心'] }));
    expect(receipt.concept).toEqual(concept);
  }, 90000);
  it('到上限后只提示不返工，成品照常交付', async () => {
    const receipt = JSON.parse(await createPosterDeliveryTool({ visionLlm, renderVisualScene }).run({ ...input, path: '自审/产科-终.png' }, { designReviewBlocking: () => false }));
    expect(receipt.errors.map(e => e.code)).not.toContain('DESIGN_LAYOUT_NEEDS_WORK');
    expect(receipt.notes.some(n => n.includes('设计自审仍有可改进处'))).toBe(true);
    expect(receipt.designReview.suggestions).toEqual(['标题放大并下移到视觉中心']);
  }, 90000);
});

describe('先想后做的硬要求（2026-11-17 美国新闻海报：没构思直接套上图下面板，指数涨跌没用图表）', () => {
  it('交付会话里新自由稿没写构思：出图前就退回，不算试排；写了构思正常出图', async () => {
    const { designThinkingIssues } = await import('../src/agent/posterContent.js');
    const d = planLayerDesign({ title: 't', design: { layout: 'free', layers: layers.slice(1) } });
    expect(designThinkingIssues(d, { requireConcept: true }).map(i => i.code)).toEqual(['DESIGN_CONCEPT_MISSING']);
    expect(designThinkingIssues(d)).toEqual([]);
    const tool = createPosterDeliveryTool({ renderVisualScene });
    const scope = {};
    const missing = JSON.parse(await tool.run({ title: '产科医生怎么选', path: '构思/无.png', design: { layout: 'free', palette: { background: '#F4EFE6' }, layers: [
      { id: 'title', type: 'text', text: '产科医生怎么选', x: 80, y: 200, w: 920, h: 140, fontSize: 96, weight: 700, color: '#1D2430', role: 'heading' }] } }, { executionScope: scope }));
    expect(missing.errors.map(e => e.code)).toContain('DESIGN_CONCEPT_MISSING');
    expect(missing.delivery.attempts).toBe(0);
    expect(missing.files.some(f => f.format === 'png')).toBe(false);
  }, 90000);
  it('正文有3个以上百分比却没有图表：要求用chart图层；有图表就不提', async () => {
    const { designThinkingIssues } = await import('../src/agent/posterContent.js');
    const text = { id: 'body', type: 'text', text: '道指跌1.41%、标普500跌1.92%、纳指跌2.49%', x: 80, y: 400, w: 920, h: 120, fontSize: 40, color: '#111111' };
    const plain = planLayerDesign({ title: 't', design: { layout: 'free', layers: [text] } });
    expect(designThinkingIssues(plain).map(i => i.code)).toEqual(['DESIGN_DATA_NEEDS_CHART']);
    const charted = planLayerDesign({ title: 't', design: { layout: 'free', layers: [text, { id: 'chart', type: 'chart', chartType: 'bar', unit: '%', x: 80, y: 600, w: 920, h: 400,
      points: [{ label: '道指', value: -1.41 }, { label: '标普500', value: -1.92 }, { label: '纳指', value: -2.49 }] }] } });
    expect(designThinkingIssues(charted)).toEqual([]);
  });
  it('设计自审要求判断是否模板化', async () => {
    const visionLlm = vi.fn(async () => JSON.stringify({ copyMatches: true, readable: true, noOverlap: true, issues: [], design: { distinctive: false, suggestions: ['去掉大面板，改图文穿插'] } }));
    const d = planLayerDesign({ title: '产科医生怎么选', design: { layout: 'free', concept, layers: layers.slice(1) } });
    const report = await reviewLayeredDesign({ visionLlm }, d, new Blob([new Uint8Array(4)], { type: 'image/png' }));
    expect(visionLlm.mock.calls[0][0].system).toContain('distinctive');
    expect(report.design.distinctive).toBe(false);
  });
});

describe('交付回答如实列文件（2026-11-17 美国新闻海报回答）', () => {
  it('链接文字写的文件名必须是实际指向的文件；格式按回执说', async () => {
    const { posterAnswerIssues, linkLabelIssues } = await import('../src/agent/posterRouting.js');
    expect(linkLabelIssues('[海报/美国新闻-1117.png](.workflows/posters/a/attempt-2/海报.png)')).toHaveLength(1);
    expect(linkLabelIssues('[海报.png](.workflows/posters/a/attempt-2/%E6%B5%B7%E6%8A%A5.png) [海报PNG](x/海报.png) [官网](https://a.com/b.png)')).toEqual([]);
    const media = { kind: 'poster', outputs: [{ format: 'png', readback: 'passed' }, { format: 'svg', readback: 'passed' }], visual: 'passed' };
    expect(posterAnswerIssues('做好了，PNG、SVG、PPTX 三份都在。', media).join('')).toContain('没有PPT');
    expect(posterAnswerIssues('做好了，PNG和SVG两份；这版没有PPTX。', media)).toEqual([]);
  });
});

describe('交付说法对不上时不整段吞掉回答（2026-11-17：做海报整轮只回“本轮未能生成符合当前要求的答复”）', () => {
  it('链接名、格式数量、海报验收措辞归为可放行的交付核对；链接名自动改成实际文件名', async () => {
    const { rewriteRule } = await import('../src/agent/agent.js');
    const { fixLinkLabels, posterAnswerIssues } = await import('../src/agent/posterRouting.js');
    expect(rewriteRule('链接文字写的是“a.png”，实际指向“b.png”')).toBe('delivery_claim');
    expect(rewriteRule('本次实际只生成了PNG、SVG，没有PPT；按回执如实列出文件')).toBe('delivery_claim');
    expect(rewriteRule('“请医生评估 / 以医生为准”这类提醒出现了3次')).toBe('care_deferral');
    expect(fixLinkLabels('见[海报/美国新闻.png](.workflows/posters/x/attempt-2/%E6%B5%B7%E6%8A%A5.png)和[官网](https://a.com/x.png)')).toBe('见[海报.png](.workflows/posters/x/attempt-2/%E6%B5%B7%E6%8A%A5.png)和[官网](https://a.com/x.png)');
    const media = { kind: 'poster', outputs: [{ format: 'png', readback: 'passed' }, { format: 'svg', readback: 'passed' }], visual: 'passed' };
    // 如实说没有/还没有 PPT 的不算错
    for (const ok of ['PNG和SVG已生成，PPTX还没生成', 'PPT这次没出', '可编辑的PPTX待修复后再给']) expect(posterAnswerIssues(ok, media)).toEqual([]);
    expect(posterAnswerIssues('PNG、SVG、PPTX都已生成', media).join('')).toContain('没有PPT');
  });
});
