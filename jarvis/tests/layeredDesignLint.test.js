/** 2026-11-17 用户讨论 Demo 美观：程序检查颜色/对齐/字号/主图主色（只给建议），Demo 手机卡片预览参与自审 */
import { describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { normalizeLayerDesign } from '../src/agent/layeredDesignInput.js';
import { lintLayerDesign, imageColors } from '../src/agent/layeredDesignLint.js';
import { mobileCardsPreviewSvg, mobileGroups } from '../src/agent/layeredDesignHtml.js';
import { reviewLayeredDesign } from '../src/agent/layeredDesignQuality.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { decodePngRgba } from '../src/agent/posterContrast.js';
import * as ws from '../src/agent/workspace.js';

const base = { width: 1920, height: 1080, title: '城市运行', palette: { background: '#0E1A24', ink: '#F2F5F7', muted: '#8DA2B0', accent: '#2FB3A8', card: '#16283A' } };
const text = (id, x, fontSize, color = '#F2F5F7') => ({ id, type: 'text', text: '内容' + id, x, y: 40 + fontSize * 3, w: 400, h: fontSize * 2, fontSize, color });

describe('设计规则体检', () => {
  it('颜色、对齐线、字号都收敛时不提建议', () => {
    const d = normalizeLayerDesign({ ...base, layers: [text('title', 80, 64), text('a', 80, 32), text('b', 80, 32, '#8DA2B0'), text('c', 1000, 32)] });
    expect(lintLayerDesign(d)).toMatchObject({ status: 'clean', suggestions: [] });
  });
  it('颜色太多、对齐线太散、字号太多都给出具体建议，但不判失败', () => {
    const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFAA00', '#AA00FF'];
    const layers = colors.map((c, i) => text('t' + i, 60 + i * 40, 20 + i * 8, c)).concat([text('u', 600, 76), text('v', 700, 88)]);
    const result = lintLayerDesign(normalizeLayerDesign({ ...base, layers }));
    expect(result.status).toBe('advice');
    expect(result.suggestions.map(s => s.code)).toEqual(['DESIGN_TOO_MANY_COLORS', 'DESIGN_TOO_MANY_EDGES', 'DESIGN_TOO_MANY_SIZES']);
  });
  it('从主图真实像素取主色；强调色离主图太远时建议从主图取色', async () => {
    const canvas = createCanvas(200, 100), g = canvas.getContext('2d');
    g.fillStyle = '#C8642A'; g.fillRect(0, 0, 140, 100); g.fillStyle = '#1C2A3A'; g.fillRect(140, 0, 60, 100);
    const colors = await imageColors({ data: 'data:image/png;base64,' + canvas.toBuffer('image/png').toString('base64') }, renderVisualScene);
    expect(colors[0].color).toMatch(/^#[0-9A-F]{6}$/);
    expect(colors[0].share).toBeGreaterThan(colors[1].share);
    const d = normalizeLayerDesign({ ...base, palette: { ...base.palette, accent: '#2FB3A8' }, layers: [text('title', 80, 64)] });
    expect(lintLayerDesign(d, colors).suggestions.map(s => s.code)).toContain('DESIGN_ACCENT_OFF_IMAGE');
    expect(lintLayerDesign(d, [{ color: '#30B0A0', share: 1 }]).suggestions).toEqual([]);
  }, 60000);
});

describe('Demo 手机卡片预览', () => {
  const design = normalizeLayerDesign({ ...base, layers: [
    { id: 'card', type: 'shape', x: 60, y: 300, w: 800, h: 600, fill: '#16283A', group: 'g1' },
    { id: 'title', type: 'text', text: '城市运行一张图', x: 80, y: 60, w: 1200, h: 120, fontSize: 80, color: '#F2F5F7' },
    { id: 'g1-title', type: 'text', text: '今日客流', x: 100, y: 340, w: 600, h: 60, fontSize: 40, color: '#F2F5F7', group: 'g1' },
    { id: 'g1-value', type: 'text', text: '128万', x: 100, y: 420, w: 600, h: 100, fontSize: 72, color: '#2FB3A8', group: 'g1' },
    { id: 'g1-body', type: 'text', text: '早高峰集中在地铁1号线和2号线换乘站，建议错峰出行。'.repeat(2), x: 100, y: 560, w: 700, h: 200, fontSize: 32, color: '#F2F5F7', group: 'g1' }] });
  it('与网页同样分组，按手机宽度排成卡片流，真实渲染成功', async () => {
    expect(mobileGroups(design).map(g => g.group)).toEqual(['design-intro', 'g1']);
    const preview = mobileCardsPreviewSvg(design, new Map());
    expect(preview.width).toBe(780);
    expect(preview.svg).toContain('今日客流');
    expect(preview.svg.match(/<rect /g)).toHaveLength(3); // 底色 + 两张卡片
    const rendered = await renderVisualScene(preview.svg, {});
    const image = await decodePngRgba(new Uint8Array(await rendered.blob.arrayBuffer()));
    expect([image.width, image.height]).toEqual([preview.width, preview.height]);
  }, 60000);
  it('自审提示说明第二张是手机卡片预览，不是浏览器截图', async () => {
    const visionLlm = vi.fn(async () => JSON.stringify({ copyMatches: true, readable: true, noOverlap: true, issues: [] }));
    const png = new Blob([new Uint8Array(10)], { type: 'image/png' });
    await reviewLayeredDesign({ visionLlm }, design, png, { previewPng: png, previewKind: 'mobile_cards' });
    expect(visionLlm.mock.calls[0][0].system).toContain('卡片布局预览');
    expect(visionLlm.mock.calls[0][0].images).toHaveLength(2);
  });
  it('真实 Demo 交付带手机卡片预览和设计体检（含主图主色）', async () => {
    const photo = createCanvas(320, 180), g = photo.getContext('2d');
    g.fillStyle = '#C8642A'; g.fillRect(0, 0, 320, 180);
    await ws.write('Demo体检/主图.png', new Blob([photo.toBuffer('image/png')], { type: 'image/png' }));
    const result = JSON.parse(await createVisualDemoTool({ renderVisualScene }).run({ title: '城市运行一张图', width: 1920, height: 1080, path: 'Demo体检/城市.html',
      design: { layout: 'free', palette: base.palette, assets: [{ id: 'hero', path: 'Demo体检/主图.png' }],
        layers: [...design.layers, { id: 'hero', type: 'image', asset: 'hero', x: 1000, y: 300, w: 800, h: 450 }] } }));
    expect(result.designLint.imageColors[0].color).toMatch(/^#[0-9A-F]{6}$/);
    expect(result.phonePreview).toMatchObject({ kind: 'mobile_cards', width: 780, render: 'passed' });
    expect(await ws.exists(result.phonePreview.path)).toBe(true);
    expect(result.designLint.basis).toContain('只给建议');
  }, 120000);
});
