import { it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { wantsIllustratedPoster, posterContent } from '../src/agent/posterContent.js';
import { normalizeLayerDesign } from '../src/agent/layeredDesignInput.js';
import { composeLayeredSvg, chartLabelNodes } from '../src/agent/layeredDesignSvg.js';
import { composeLayeredPptx } from '../src/agent/layeredDesignPptx.js';
import { barChartGeometry } from '../src/agent/posterBarChart.js';
import { checkLayerCopy, reviewLayeredDesign } from '../src/agent/layeredDesignQuality.js';
import { posterAnswerIssues } from '../src/agent/posterRouting.js';
import { loadLayerDesign } from '../src/agent/layeredDesignSource.js';
import * as ws from '../src/agent/workspace.js';
import { posterFollowupRequirement } from '../src/agent/posterFollowup.js';

const title = { id: 'title', type: 'text', text: '指数涨跌幅', x: 60, y: 60, w: 940, h: 140, fontSize: 68 };
const bar = { id: 'comparison', type: 'chart', chartType: 'bar', unit: '%', x: 60, y: 300, w: 940, h: 700,
  points: [{ label: '道琼斯', value: 0.1 }, { label: '标普500', value: -0.4 }, { label: '纳斯达克', value: -0.91 }] };
const design = layers => normalizeLayerDesign({ title: '对比', width: 1080, height: 1920, layers: [title, ...layers] });
const png = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGxoAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' });
it('真实大图/图表和装饰数字卡区分，完全遮挡及微型配图不能充数', () => {
  expect(wantsIllustratedPoster('做成图文并茂的海报')).toBe(true);
  expect(wantsIllustratedPoster('文字海报')).toBe(false);
  expect(wantsIllustratedPoster(posterFollowupRequirement('换结构，不动颜色', [{ role: 'user', content: '做新闻海报' }]))).toBe(false);
  expect(wantsIllustratedPoster(posterFollowupRequirement('换结构，图文并茂', [{ role: 'user', content: '做新闻海报' }]))).toBe(true);
  expect(posterContent(design([{ id: 'card', type: 'shape', x: 50, y: 300, w: 950, h: 600 }])).status).toBe('failed');
  expect(posterContent(design([bar]))).toMatchObject({ status: 'passed', semantic: 'not_checked' });
  expect(posterContent(design([bar, { id: 'cover', type: 'shape', x: 0, y: 200, w: 1080, h: 1000 }])).status).toBe('failed');
  expect(posterContent(design([{ id: 'tiny', type: 'image', asset: 'hero', x: 20, y: 300, w: 50, h: 50 }])).status).toBe('failed');
  expect(posterContent(design([{ id: 'hero', type: 'image', asset: 'hero', x: 50, y: 300, w: 900, h: 800 }])).status).toBe('passed');
});
it('分类正负对比从零轴出发，SVG/PPTX完整保留每个标签和原始精度，不生成连线走势', async () => {
  const d = design([bar]), node = d.layers[1], g = barChartGeometry(node), svg = composeLayeredSvg(d);
  expect(g.bars[0].x).toBe(g.zero);
  expect(g.bars[1].x + g.bars[1].w).toBeCloseTo(g.zero);
  expect(chartLabelNodes(node).map(n => n.text)).toEqual(['道琼斯', '0.1%', '标普500', '-0.4%', '纳斯达克', '-0.91%']);
  expect(checkLayerCopy(d, svg).status).toBe('passed');
  expect(svg).not.toContain('<circle');
  const zip = await JSZip.loadAsync(await composeLayeredPptx(d, new Map()));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  for (const label of chartLabelNodes(node)) { expect(svg).toContain(label.text); expect(xml).toContain(label.text); }
  expect(xml).toContain('comparison-zero');
  const precise = design([{ ...bar, points: [{ label: '甲', value: -0.123456789 }, { label: '乙', value: 0.987654321 }] }]);
  expect(composeLayeredSvg(precise)).toContain('-0.123456789%');
  expect(() => design([{ ...bar, chartType: 'invented' }])).toThrow();
});
it('原有折线稿保持原行为，不因新增分类图改变旧源稿', () => {
  const d = design([{ ...bar, chartType: undefined }]);
  expect(composeLayeredSvg(d)).toContain('<circle');
  expect(d.layers[1]).not.toHaveProperty('chartType');
  expect(normalizeLayerDesign({ ...d, illustrated: true }).illustrated).toBe(true);
  expect(d).not.toHaveProperty('illustrated');
});
it('图文要求随源稿保存，改字和重新构图均不能静默降为纯文字稿', async () => {
  const d = { ...design([bar]), illustrated: true };
  await ws.write('图文要求.design.json', JSON.stringify(d));
  expect((await loadLayerDesign({ source_path: '图文要求.design.json', changes: [{ id: 'title', text: '新标题' }] })).design.illustrated).toBe(true);
  expect((await loadLayerDesign({ source_path: '图文要求.design.json', design: { layout: 'free', layers: d.layers } })).design.illustrated).toBe(true);
});
it('同一次有界视觉核验必须返回图文证据；旧三项通过不能冒充图文通过，无视觉不多调模型', async () => {
  const d = design([bar]), consume = vi.fn();
  const basic = { copyMatches: true, readable: true, noOverlap: true, issues: [] };
  const visionLlm = vi.fn(async () => JSON.stringify(basic));
  expect((await reviewLayeredDesign({ visionLlm }, d, png, { requiresRichVisual: true, retrieval: { consume } })).status).toBe('not_checked');
  expect(consume).toHaveBeenCalledTimes(1);
  expect(visionLlm).toHaveBeenCalledTimes(1);
  expect(visionLlm.mock.calls[0][0]).toMatchObject({ allowWebSearch: false, maxTransientRetries: 0, maxPartialRetries: 0 });
  const yes = { ...basic, visualsPresent: true, relatedToTopic: true, integrated: true };
  expect((await reviewLayeredDesign({ visionLlm: async () => JSON.stringify(yes) }, d, png, { requiresRichVisual: true })).status).toBe('passed');
  expect((await reviewLayeredDesign({ visionLlm: async () => JSON.stringify({ ...yes, relatedToTopic: false }) }, d, png, { requiresRichVisual: true })).status).toBe('failed');
  expect((await reviewLayeredDesign({}, d, png, { requiresRichVisual: true })).status).toBe('not_checked');
  expect(posterAnswerIssues('全项检查通过，图文并茂已经完成', { kind: 'poster', contentCheck: { status: 'passed', semantic: 'not_checked' } }).length).toBeGreaterThan(0);
});
