/** 2026-11-17 用户：海报像硬拼的，需要图文融合。自由稿出图前：大图下沿加渐变过渡、同列段落统一间距 */
import { it, expect } from 'vitest';
import { fuseLayerDesign } from '../src/agent/layeredDesignFusion.js';
import { prepareFreeLayerDesign } from '../src/agent/layeredDesignPreflight.js';
import { planLayerDesign } from '../src/agent/layeredDesignLayout.js';
import { composeLayeredSvg } from '../src/agent/layeredDesignSvg.js';
import { composeLayeredPptx } from '../src/agent/layeredDesignPptx.js';
import { normalizeLayerDesign } from '../src/agent/layeredDesignInput.js';
import JSZip from 'jszip';

const T = (id, text, y, h, fontSize = 34, extra = {}) => ({ id, type: 'text', text, x: 72, y, w: 936, h, fontSize, color: '#1F2D36', ...extra });
const poster = () => ({
  width: 1080, height: 2880, title: '产科医生怎么选？',
  design: { layout: 'free', assets: [{ id: 'hero', path: 'hero.png' }], layers: [
    { id: 'panel', type: 'shape', x: 0, y: 0, w: 1080, h: 2880, fill: '#EAF6F7' },
    { id: 'hero', type: 'image', asset: 'hero', x: 0, y: 0, w: 1080, h: 818 },
    T('title', '产科医生怎么选？', 789, 90, 64, { weight: 700, role: 'heading' }), // 骑在图片下沿上
    T('subtitle', '二胎剖宫产｜重点看疤痕子宫经验', 936, 58),
    T('p1', '首选方向：甲主任医师。公开资料列出疤痕子宫、复杂产科手术。', 1063, 288),
    T('p2', '高危情况：咨询乙主任医师团队。公开诊疗组信息提到危重孕产妇救治。', 1416, 302),
    T('p3', '备选咨询：丙主任医师。可作为备选咨询对象。', 1783, 245),
    T('p4', '面诊时一定问：挂到专家号，不等于本人主刀。', 2042, 331),
    T('footer', '来源：公开专家信息｜仅供就诊参考', 2808, 40, 22, { role: 'caption' })
  ] }
});

it('大图在画面中间结束：下沿加“透明→下方底色”渐变带，骑在接缝上的标题落在已加深的部分', () => {
  const { design, preflight } = prepareFreeLayerDesign(poster(), [1080, 2880]);
  const fade = design.layers.find((n) => n.id === 'fuse-hero');
  expect(fade).toMatchObject({ type: 'shape', decorative: true, fill: '#EAF6F7' });
  expect(fade.y + fade.h).toBeCloseTo(818, 0);
  const title = design.layers.find((n) => n.id === 'title');
  expect(fade.y).toBeLessThan(title.y);
  const [, mid, end] = fade.fade.stops;
  expect(mid[1]).toBeGreaterThanOrEqual(0.85);
  expect(end).toEqual([1, 1]);
  expect(design.layers.indexOf(fade)).toBe(design.layers.findIndex((n) => n.id === 'hero') + 1); // 在图片之上、文字之下
  expect(preflight.fusion.map((n) => n.kind)).toEqual(expect.arrayContaining(['image_fade', 'text_rhythm']));
});

it('同列段落：框收紧到文字实际高度，段落间距一致，标题与副标题更紧；标题和脚注不动、原文和字号不变', () => {
  const { design } = prepareFreeLayerDesign(poster(), [1080, 2880]);
  const byId = (id) => design.layers.find((n) => n.id === id);
  const body = ['subtitle', 'p1', 'p2', 'p3', 'p4'].map(byId);
  const gaps = body.slice(1).map((n, i) => Math.round(n.y - (body[i].y + body[i].h)));
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  const titleGap = byId('subtitle').y - (byId('title').y + byId('title').h);
  expect(titleGap).toBeLessThan(gaps[0]);
  expect(byId('title').y).toBe(789);
  expect(byId('footer').y).toBe(2808);
  for (const n of body) expect(n.h).toBeLessThan(poster().design.layers.find((x) => x.id === n.id).h);
  expect(byId('p1').text).toBe('首选方向：甲主任医师。公开资料列出疤痕子宫、复杂产科手术。');
  expect(byId('p1').fontSize).toBe(34);
});

it('列里夹着卡片/图标：不重排；strict模式完全不动', () => {
  const card = poster();
  card.design.layers.push({ id: 'card', type: 'shape', x: 60, y: 1400, w: 500, h: 200, fill: '#FFFFFF' });
  const notes = fuseLayerDesign(normalizeLayerDesign({ ...planLayerDesign(card, [1080, 2880]) }));
  expect(notes.some((n) => n.kind === 'text_rhythm')).toBe(false);
  const strict = poster();
  strict.design.text_fit = 'strict';
  const { design, preflight } = prepareFreeLayerDesign(strict, [1080, 2880]);
  expect(preflight).toBeNull();
  expect(design.layers.some((n) => n.id === 'fuse-hero')).toBe(false);
});

it('渐变带在SVG里是线性渐变、在PPTX里是可编辑的半透明色带；重新载入设计稿时保留', async () => {
  const { design } = prepareFreeLayerDesign(poster(), [1080, 2880]);
  const assets = new Map([['hero', { data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', width: 1, height: 1 }]]);
  const svg = composeLayeredSvg(design, assets);
  expect(svg).toContain('<linearGradient id="fade-fuse-hero"');
  expect(svg).toContain('fill="url(#fade-fuse-hero)"');
  const zip = await JSZip.loadAsync(await (await composeLayeredPptx(design, assets)).arrayBuffer());
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  expect((slide.match(/layer-fuse-hero-band-/g) || []).length).toBeGreaterThan(10);
  expect(normalizeLayerDesign(JSON.parse(JSON.stringify(design))).layers.find((n) => n.id === 'fuse-hero').fade.stops.length).toBe(3);
});
