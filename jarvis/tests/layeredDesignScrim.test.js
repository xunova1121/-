/** 2026-11-17 用户：海报不能只是上图下文，有可能是叠加的。字压在照片上、按真实像素量看不清才加局部遮罩 */
import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { normalizeLayerDesign } from '../src/agent/layeredDesignInput.js';
import { composeLayeredSvg } from '../src/agent/layeredDesignSvg.js';
import { composeLayeredPptx } from '../src/agent/layeredDesignPptx.js';
import { protectOverlayText, overlayTexts, SCRIM_LEVELS } from '../src/agent/layeredDesignScrim.js';
import { checkLayerContrast } from '../src/agent/layeredDesignQuality.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';

/** 合成照片：上半亮（天空），下半按 tone 取亮或暗 */
function photo(tone) {
  const canvas = createCanvas(540, 960), g = canvas.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 960);
  grad.addColorStop(0, '#DCEBF5'); grad.addColorStop(1, tone === 'dark' ? '#14181F' : '#F4F1EA');
  g.fillStyle = grad; g.fillRect(0, 0, 540, 960);
  return { data: 'data:image/png;base64,' + canvas.toBuffer('image/png').toString('base64'), width: 540, height: 960 };
}
const design = (extra = [], textColor = '#FFFFFF') => normalizeLayerDesign({
  width: 540, height: 960, title: '秋日音乐节',
  palette: { background: '#101114' },
  assets: [{ id: 'hero', path: 'hero.png' }],
  layers: [
    { id: 'hero', type: 'image', asset: 'hero', x: 0, y: 0, w: 540, h: 960 },
    ...extra,
    { id: 'title', type: 'text', text: '秋日音乐节', x: 40, y: 700, w: 460, h: 80, fontSize: 64, weight: 700, color: textColor },
    { id: 'date', type: 'text', text: '11月22日 · 江边草坪', x: 40, y: 800, w: 460, h: 48, fontSize: 32, color: textColor }
  ]
});
const compose = assets => d => composeLayeredSvg(d, assets);
const raster = (svg, options) => renderVisualScene(svg, options);

describe('叠加版式局部遮罩', () => {
  it('白字压在亮照片上：加一条渐变遮罩，复测通过，原文/字号/位置不变', async () => {
    const assets = new Map([['hero', photo('light')]]), d = design();
    const before = structuredClone(d.layers.filter(n => n.type === 'text'));
    expect((await checkLayerContrast(d, composeLayeredSvg(d, assets), raster)).status).toBe('failed');
    const result = await protectOverlayText(d, { compose: compose(assets), raster });
    expect(result.status).toBe('passed');
    expect(result.scrims).toEqual([{ id: 'scrim-1', image: 'hero', text: ['title', 'date'] }]);
    expect(SCRIM_LEVELS).toContain(result.level);
    const scrim = d.layers.find(n => n.id === 'scrim-1');
    // 在文字下层、照片上层；横贯整张图；上端透明渐入，不是硬边色块
    expect(d.layers.map(n => n.id)).toEqual(['hero', 'scrim-1', 'title', 'date']);
    expect(scrim).toMatchObject({ type: 'shape', decorative: true, x: 0, w: 540, fill: '#101114' });
    expect(scrim.fade.stops[0]).toEqual([0, 0]);
    expect(d.layers.filter(n => n.type === 'text')).toEqual(before);
    expect((await checkLayerContrast(d, composeLayeredSvg(d, assets), raster)).status).toBe('passed');
    // 归一化往返和PPTX都保留遮罩
    expect(normalizeLayerDesign(structuredClone(d)).layers.find(n => n.id === 'scrim-1').fade).toEqual(scrim.fade);
    expect((await composeLayeredPptx(d, assets)).size).toBeGreaterThan(0);
  }, 60000);
  it('白字压在暗处：本来就清楚，不加遮罩', async () => {
    const assets = new Map([['hero', photo('dark')]]), d = design();
    const result = await protectOverlayText(d, { compose: compose(assets), raster });
    expect(result).toEqual({ status: 'passed', scrims: [] });
    expect(d.layers.map(n => n.id)).toEqual(['hero', 'title', 'date']);
  }, 60000);
  it('模型自己垫了底块：量出来清楚，不重复加', async () => {
    const assets = new Map([['hero', photo('light')]]);
    const d = design([{ id: 'band', type: 'shape', x: 0, y: 670, w: 540, h: 210, fill: '#1B1E26' }]);
    const result = await protectOverlayText(d, { compose: compose(assets), raster });
    expect(result.scrims).toEqual([]);
    expect(d.layers.some(n => n.id.startsWith('scrim-'))).toBe(false);
  }, 60000);
  it('没有压图文字（上图下文）时不渲染、不花时间', async () => {
    const d = normalizeLayerDesign({ width: 540, height: 960, title: 't', assets: [{ id: 'hero', path: 'hero.png' }], layers: [
      { id: 'hero', type: 'image', asset: 'hero', x: 0, y: 0, w: 540, h: 400 },
      { id: 'title', type: 'text', text: '标题', x: 40, y: 480, w: 460, h: 80, fontSize: 48 }] });
    expect(overlayTexts(d)).toEqual([]);
    let called = 0;
    expect(await protectOverlayText(d, { compose: () => '', raster: async () => { called++; } })).toEqual({ status: 'skipped', scrims: [] });
    expect(called).toBe(0);
  });
});
