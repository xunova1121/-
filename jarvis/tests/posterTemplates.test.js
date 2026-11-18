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

/** 2026-11-18 用户：模板都是图文分开的，要图文融合 → 沉浸式（A）+ 先排版后生图（B） */
import { zonesOnImage, templateArtPrompt } from '../src/agent/posterTemplateArt.js';
/** 内容区开始的画布像素：content 留位的 y 是画面区比例 */
const zonesStart = (zones, d) => zones.find(z => z.id === 'content').y * Math.min(d.height, 1620);
describe('沉浸式模板与先排版后生图', () => {
  it.each(TEMPLATE_IDS)('%s 沉浸式：图铺满整张、由上到下压暗、卡片半透明、不重叠、手机可读', id => {
    const input = templateDesignInput({ template: { ...TEMPLATE_SAMPLES[id], layout: 'immersive', image: '图/主视觉.png' } });
    const { zones, ...rest } = input, d = planLayerDesign(rest);
    const ids = d.layers.map(n => n.id), hero = d.layers.find(n => n.id === 'hero');
    expect(ids).not.toContain('header-bg');
    // 画面按原比例放在上部（2:3 铺满宽约 1620 高），画布更矮时铺满整张
    expect(hero).toMatchObject({ x: 0, y: 0, w: 1080, h: Math.min(d.height, 1620) });
    expect(ids.indexOf('hero')).toBeLessThan(ids.indexOf('immersive-shade'));
    expect(ids.indexOf('immersive-shade')).toBeLessThan(ids.indexOf('title'));
    const shade = d.layers.find(n => n.id === 'immersive-shade').fade.stops;
    expect(shade[0][1]).toBeLessThan(0.2);
    // 2026-11-18 用户对比豆包样张：内容区之前画面基本露出（≤0.25），进入内容区后平滑压到≥0.9；原断言为底部≥0.85、卡片0.6–0.8
    expect(shade.at(-1)[1]).toBeGreaterThanOrEqual(0.9);
    expect(shade.length).toBeLessThanOrEqual(4);
    const before = shade.filter(([at]) => at * d.height <= zonesStart(zones, d));
    expect(before.length).toBeGreaterThan(1);
    expect(before.every(([, v]) => v <= 0.25)).toBe(true);
    // 卡片/行底若有，一律半透明（0.4–0.6）
    const glass = d.layers.filter(n => n.type === 'shape' && n.fade && n.fade.stops.every(s => s[1] > 0.4 && s[1] <= 0.6));
    if (id !== 'schedule') expect(glass.length).toBeGreaterThan(0);
    // 内容区的底块（卡片、行底）不能有实心深色挡住画面
    const solidPanels = d.layers.filter(n => n.type === 'shape' && !n.fade && n.fill === d.palette.background && n.w > 400 && n.h > 40 && !n.id.startsWith('immersive'));
    expect(solidPanels.map(n => n.id)).toEqual([]);
    expect(checkLayerOverlap(d)).toMatchObject({ status: 'passed' });
    expect(checkDesignPresentation(d).status).not.toBe('failed');
    expect(zones.map(z => z.id)).toEqual(['title', 'content']);
    expect(input.heroHeight).toBe(Math.min(d.height, 1620));
    expect(zones[1].y + zones[1].h).toBeCloseTo(1, 2);
    expect(d.concept.relation).toBe('overlay');
  });
  it('留白区换算到配图坐标：画布更高时左右裁、更矮时上下裁', () => {
    const z = [{ id: 'content', tone: 'dark', x: 0, y: 0.5, w: 1, h: 0.5 }];
    expect(zonesOnImage(z, 1080, 2160, 1024, 1536)[0]).toMatchObject({ x: 0.125, w: 0.75, y: 0.5, h: 0.5 });
    const short = zonesOnImage(z, 1080, 1350, 1024, 1536)[0];
    expect(short.x).toBe(0);
    // 画布 1.25 比 配图 1.5：可见 1.25/1.5 的高度，上下各裁掉一半余量
    expect(short.y).toBeCloseTo((1 - 1.25 / 1.5) / 2 + 0.5 * 1.25 / 1.5, 3);
    expect(short.h).toBeCloseTo(0.5 * 1.25 / 1.5, 3);
    const p = templateArtPrompt('秋天的山谷', [{ id: 't', tone: 'dark', x: 0, y: 0.4, w: 1, h: 0.6 }]);
    expect(p).toContain('版式留白');
    expect(p).toContain('不要任何文字');
  });
  const fakeArt = prompts => async ({ prompt }) => {
    prompts.push(prompt);
    const c = createCanvas(1024, 1536), g = c.getContext('2d');
    g.fillStyle = '#E8A05A'; g.fillRect(0, 0, 1024, 400); g.fillStyle = '#16161F'; g.fillRect(0, 400, 1024, 1136);
    return { blob: new Blob([c.toBuffer('image/png')], { type: 'image/png' }) };
  };
  it('make_poster 填 image_prompt：先排版、按文字位置生成满版配图，再交付成品', async () => {
    const prompts = [];
    const tool = createPosterDeliveryTool({ renderVisualScene, imageGen: fakeArt(prompts) });
    const r = JSON.parse(await tool.run({ template: { ...TEMPLATE_SAMPLES.event_promo, image_prompt: '秋日公园里的亲子集市，暖色黄昏' } }, { executionScope: {}, rawRequestText: '做一张亲子市集海报' }));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('版式留白');
    expect(prompts[0]).toContain('秋日公园');
    expect(r.errors).toEqual([]);
    expect(r.status).toBe('complete');
    expect(r.templateArt).toMatchObject({ status: 'generated' });
    expect(r.templateArt.clearAreas.areas.map(a => a.id)).toEqual(['title', 'content']);
    expect(await ws.exists(r.templateArt.path)).toBe(true);
    expect(r.notes.join('')).toContain('先排版后生图');
  }, 120000);
  it('配图生成失败：退回无图沉浸式版式照样出稿，并如实说明', async () => {
    const tool = createPosterDeliveryTool({ renderVisualScene, imageGen: async () => { throw new Error('额度用完'); } });
    const r = JSON.parse(await tool.run({ template: { ...TEMPLATE_SAMPLES.tips, image_prompt: '寒冬街头' } }, { executionScope: {}, rawRequestText: '做一张寒潮提醒海报' }));
    expect(r.status).toBe('complete');
    expect(r.templateArt).toMatchObject({ status: 'failed' });
    expect(r.notes.join('')).toContain('额度用完');
  }, 120000);
});
describe('沉浸式指引', () => {
  it('海报指引说明 image_prompt 先排版后生图', () => {
    expect(POSTER_GUIDANCE).toContain('template.image_prompt');
    expect(POSTER_GUIDANCE).toContain('immersive');
  });
});
describe('沉浸式不丢页头内容', () => {
  it.each(TEMPLATE_IDS)('%s：眉题/人名、日期仍在稿里', id => {
    const t = TEMPLATE_SAMPLES[id], d = planLayerDesign((({ zones, heroHeight, ...x }) => x)(templateDesignInput({ template: { ...t, layout: 'immersive' } })));
    const plain = planLayerDesign(templateDesignInput({ template: t }));
    const words = l => l.layers.filter(n => n.type === 'text').map(n => n.text).join('|');
    for (const n of plain.layers.filter(n => ['eyebrow', 'date'].includes(n.id))) expect(words(d)).toContain(n.text);
  });
});
