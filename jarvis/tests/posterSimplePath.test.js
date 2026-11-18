/** 2026-11-18 用户实测：一张图文融合海报画了 6 张配图、4 张约 2MB 原样嵌入导致 SVG 11.7MB 渲染失败；
 *  对比别家“一张底图+加字”：默认走最简单的路，能搜图就别画，过大的配图缩小再嵌入。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { neededScale, shrinkDesignAssets, ASSET_SHRINK } from '../src/agent/layeredDesignAssetSize.js';
import { normalizePosterBackground } from '../src/agent/posterCompositionInput.js';
import { POSTER_TOOLS, POSTER_GUIDANCE } from '../src/agent/posterRouting.js';
import { stockImageTool } from '../src/agent/stockImageTool.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { createPosterDeliveryTool } from '../src/agent/posterDeliveryTool.js';
import { collection, useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';

beforeEach(async () => { useBackend(null); for (const name of ['files', 'kv', 'sessions']) await collection(name).clear(); });

/** 噪点大图：PNG 压不小，模拟画图模型回的 2MB 级照片 */
function noisyPng(w, h, part = 1) {
  const c = createCanvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h);
  let seed = 7;
  for (let i = 0; i < img.data.length; i += 4) {
    if (i >= img.data.length * part) { img.data[i + 3] = 255; continue; } seed = (seed * 1103515245 + 12345) & 0x7fffffff; img.data[i] = seed & 255; img.data[i + 1] = (seed >> 8) & 255; img.data[i + 2] = (seed >> 16) & 255; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  return c.toBuffer('image/png');
}

describe('海报默认走最简单的路', () => {
  it('海报任务能用图库搜图，指引先搜后画、默认一张底图', () => {
    expect(POSTER_TOOLS).toContain('search_stock_images');
    expect(POSTER_TOOLS.indexOf('search_stock_images')).toBeLessThan(POSTER_TOOLS.indexOf('generate_image'));
    expect(POSTER_GUIDANCE).toContain('一张底图+程序排字');
    expect(POSTER_GUIDANCE).toContain('search_stock_images');
    expect(POSTER_GUIDANCE).toContain('不要为一张海报生成或拼接多张配图');
    expect(stockImageTool({}).description).toContain('球场');
  });
  it('缩放比例按实际显示尺寸×1.5，铺满的大图不缩', () => {
    const image = { width: 2000, height: 3000 };
    expect(neededScale({ layers: [{ type: 'image', asset: 'a', w: 400, h: 300, fit: 'cover' }] }, 'a', image)).toBeCloseTo(0.3, 3);
    expect(neededScale({ layers: [{ type: 'image', asset: 'a', w: 1080, h: 1920, fit: 'cover' }] }, 'a', image)).toBeGreaterThan(ASSET_SHRINK.maxScale);
    expect(neededScale({ layers: [] }, 'a', image)).toBe(1);
  });
  it('过大的小图缩小后再嵌入：只换渲染数据，原图字节不变', async () => {
    const bytes = new Uint8Array(noisyPng(1000, 1000));
    expect(bytes.length).toBeGreaterThan(ASSET_SHRINK.minBytes);
    const info = normalizePosterBackground({ bytes, mime: 'image/png' });
    const assets = new Map([['a', { ...info, bytes, mime: 'image/png' }]]);
    const shrunk = await shrinkDesignAssets({ layers: [{ type: 'image', asset: 'a', w: 300, h: 300, fit: 'cover' }] }, assets, { raster: renderVisualScene });
    expect(shrunk).toHaveLength(1);
    expect(shrunk[0].to).toBeLessThan(shrunk[0].from);
    expect(assets.get('a').bytes).toBe(bytes);
    expect(assets.get('a').data.length).toBeLessThan(info.data.length / 3);
  }, 60000);
  it('四张大配图的海报能出成品，回执说明已缩小', async () => {
    for (let i = 1; i <= 4; i++) await ws.write(`images/p${i}.png`, new Blob([noisyPng(1024, 1536, 0.3)], { type: 'image/png' }));
    const layers = [
      { id: 'title', type: 'text', text: '今日要闻', x: 72, y: 80, w: 936, h: 120, fontSize: 84, weight: 700, color: '#111111', role: 'heading' },
      ...[1, 2, 3, 4].map(i => ({ id: `img${i}`, type: 'image', asset: `p${i}`, x: i % 2 ? 72 : 552, y: i < 3 ? 260 : 760, w: 456, h: 456, fit: 'cover', detail: `配图${i}` })),
      { id: 'body', type: 'text', text: 'APEC深圳峰会今日开幕，多国领导人抵达。', x: 72, y: 1280, w: 936, h: 120, fontSize: 40, color: '#222222', role: 'body' }
    ];
    const tool = createPosterDeliveryTool({ renderVisualScene });
    const r = JSON.parse(await tool.run({ title: '今日要闻', width: 1080, height: 1920, design: { layout: 'free', concept: { idea: '四图新闻拼版', relation: 'grid', focus: '标题', mood: '新闻' }, palette: { background: '#FFFFFF', ink: '#111111', muted: '#555555', accent: '#C62828', card: '#F4F4F4' }, assets: [1, 2, 3, 4].map(i => ({ id: `p${i}`, path: `images/p${i}.png` })), layers } }, { executionScope: {}, rawRequestText: '做一张新闻海报' }));
    if (!r.files?.some(f => f.format === 'png')) console.log('RECEIPT', JSON.stringify(r).slice(0, 1500));
    expect(r.files.some(f => f.format === 'png')).toBe(true);
    expect(r.shrunkAssets).toHaveLength(4);
    expect(r.notes.join('')).toContain('已按实际显示尺寸缩小');
  }, 120000);
});

import { overlayTexts, protectOverlayText } from '../src/agent/layeredDesignScrim.js';
import { composeLayeredSvg } from '../src/agent/layeredDesignSvg.js';
describe('压图文字的遮罩不盖住别的字', () => {
  const base = (extra = []) => ({ width: 1080, height: 1600, palette: { background: '#0B2A1C', ink: '#FFFFFF', muted: '#CCCCCC', accent: '#2E9E5B', card: '#0B2A1C' }, fontFamily: 'sans',
    layers: [{ id: 'hero', type: 'image', asset: 'hero', x: 0, y: 0, w: 1080, h: 1600, fit: 'cover' }, ...extra] });
  const text = (id, y, color = '#FFFFFF') => ({ id, type: 'text', text: '中国球队对阵韩国球队', x: 72, y, w: 936, h: 60, fontSize: 40, minFontSize: 40, weight: 700, color, align: 'left', lineHeight: 1.4 });
  it('不透明按钮上的字不算压图文字（交给换色处理）', () => {
    const d = base([{ id: 'btn', type: 'shape', x: 60, y: 400, w: 960, h: 100, fill: '#E0631A', radius: 50 }, text('cta', 420)]);
    expect(overlayTexts(d).map(c => c.node.id)).toEqual([]);
    const glass = base([{ id: 'card', type: 'shape', x: 60, y: 400, w: 960, h: 100, fill: '#0B2A1C', radius: 0, fade: { stops: [[0, 0.74], [1, 0.74]] } }, text('row', 420)]);
    expect(overlayTexts(glass).map(c => c.node.id)).toEqual(['row']);
  });
  it('遮罩插在它覆盖到的所有文字下面', async () => {
    // 浅色底图上：上面一行白字（先画），下面一行白字（后画）；都需要遮罩，遮罩不能压在任何一行字上面
    const c = createCanvas(1080, 1600), g = c.getContext('2d'); g.fillStyle = '#DDE8DD'; g.fillRect(0, 0, 1080, 1600);
    const bytes = new Uint8Array(c.toBuffer('image/png'));
    const assets = new Map([['hero', { ...normalizePosterBackground({ bytes, mime: 'image/png' }), bytes, mime: 'image/png' }]]);
    const d = base([text('a', 700), text('b', 900)]);
    const r = await protectOverlayText(d, { compose: x => composeLayeredSvg(x, assets), raster: renderVisualScene });
    expect(r.scrims.length).toBeGreaterThan(0);
    const ids = d.layers.map(n => n.id), firstText = Math.min(ids.indexOf('a'), ids.indexOf('b'));
    for (const s of r.scrims) expect(ids.indexOf(s.id)).toBeLessThan(firstText);
  }, 60000);
});
