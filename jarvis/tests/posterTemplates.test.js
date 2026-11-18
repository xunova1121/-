/** 2026-11-18 用户：海报还是不达标；一块做模板海报然后发版 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { templateDesignInput, TEMPLATE_IDS, TEMPLATE_GUIDE } from '../src/agent/posterTemplates.js';
import { planLayerDesign } from '../src/agent/layeredDesignLayout.js';
import { checkLayerOverlap } from '../src/agent/layeredDesignQuality.js';
import { checkDesignPresentation } from '../src/agent/layeredDesignPresentation.js';
import { createPosterDeliveryTool } from '../src/agent/posterDeliveryTool.js';
import { POSTER_GUIDANCE } from '../src/agent/posterRouting.js';
import { TEMPLATE_SAMPLES } from './fixtures/templateSamples.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { collection, useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';

beforeEach(async () => { useBackend(null); for (const name of ['files', 'kv', 'sessions']) await collection(name).clear(); });

describe('六套版式模板', () => {
  it('每个模板都有样例，说明里写了字段', () => {
    expect(Object.keys(TEMPLATE_SAMPLES).sort()).toEqual([...TEMPLATE_IDS].sort());
    for (const id of TEMPLATE_IDS) expect(TEMPLATE_GUIDE).toContain(id);
  });
  it.each(TEMPLATE_IDS)('%s：文字原样、互不重叠、整张缩到手机宽仍可读', id => {
    const input = templateDesignInput({ template: TEMPLATE_SAMPLES[id] }), d = planLayerDesign(input);
    expect(d.width).toBe(1080);
    expect(checkLayerOverlap(d)).toMatchObject({ status: 'passed' });
    expect(checkDesignPresentation(d).status).not.toBe('failed');
    const texts = d.layers.filter(n => n.type === 'text').map(n => n.text).join('|');
    expect(texts).toContain(TEMPLATE_SAMPLES[id].content.headline);
    expect(d.concept.idea).toContain(id);
  });
  it('文字多了画布自动加高，不缩字不截字；超出上限如实报错', () => {
    const many = { id: 'tips', content: { headline: '要点', items: Array.from({ length: 8 }, (_, i) => ({ title: `第${i + 1}条要点`, detail: '说明文字'.repeat(14) })) } };
    const d = planLayerDesign(templateDesignInput({ template: many }));
    expect(d.height).toBeGreaterThan(1920);
    expect(d.layers.filter(n => n.id.endsWith('-body')).every(n => n.fontSize === 34)).toBe(true);
    expect(() => templateDesignInput({ template: { id: 'news_brief', content: { headline: '标题', items: [{ title: '字'.repeat(31) }, { title: 'b' }] } } })).toThrow(/30字/);
    expect(() => templateDesignInput({ template: { id: 'nope', content: {} } })).toThrow(/模板id/);
  });
  it('配主视觉图：图铺满页头并压暗底部，标题压在暗部', () => {
    const d = planLayerDesign(templateDesignInput({ template: { ...TEMPLATE_SAMPLES.news_brief, image: '图/主视觉.png' } }));
    const ids = d.layers.map(n => n.id);
    expect(ids.indexOf('hero')).toBeLessThan(ids.indexOf('hero-shade'));
    expect(ids.indexOf('hero-shade')).toBeLessThan(ids.indexOf('title'));
    expect(d.layers.find(n => n.id === 'hero-shade').fade.stops.at(-1)[1]).toBeGreaterThan(0.9);
  });
  it('make_poster 走模板：一次交付PNG/SVG/PPTX成品，进入交付索引', async () => {
    const c = createCanvas(1200, 800), g = c.getContext('2d'); g.fillStyle = '#335577'; g.fillRect(0, 0, 1200, 800);
    await ws.write('图/主视觉.png', new Blob([c.toBuffer('image/png')], { type: 'image/png' }));
    const tool = createPosterDeliveryTool({ renderVisualScene });
    const r = JSON.parse(await tool.run({ template: { ...TEMPLATE_SAMPLES.person_event, image: '图/主视觉.png' } }, { executionScope: {}, rawRequestText: '把黄仁勋新闻做成海报' }));
    expect(r.errors).toEqual([]);
    expect(r.status).toBe('complete');
    expect(r.delivery.attempts).toBe(1);
    expect(r.files.map(f => f.format).sort()).toEqual(['png', 'pptx', 'svg']);
  }, 120000);
  it('海报指引：文字多的优先用模板', () => {
    expect(POSTER_GUIDANCE).toContain('template版式模板');
  });
});
