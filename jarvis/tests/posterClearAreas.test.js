/** 2026-11-17 用户反馈：机器人占了上方55%，文字只能压在机器人身上。海报配图先定文字区再生图，生成后按像素核对 */
import { describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { normalizeClearAreas, clearAreaPrompt, checkClearAreas } from '../src/agent/posterClearAreas.js';
import { createTools } from '../src/agent/tools.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';

/** 合成配图：上半是亮色、细节多的“主体”，下半是干净的深蓝 */
function art() {
  const c = createCanvas(400, 600), g = c.getContext('2d');
  g.fillStyle = '#0B1A33'; g.fillRect(0, 0, 400, 600);
  for (let i = 0; i < 300; i++) { g.fillStyle = i % 2 ? '#F0F6FF' : '#2A6FD6'; g.fillRect((i * 37) % 400, (i * 53) % 300, 14, 14); }
  return new Blob([c.toBuffer('image/png')], { type: 'image/png' });
}
const areas = [{ id: 'news', x: 0.06, y: 0.6, w: 0.88, h: 0.32, tone: 'dark' }, { id: 'title', x: 0.06, y: 0.05, w: 0.88, h: 0.2, tone: 'dark' }];

describe('海报配图留白', () => {
  it('参数校验：最多4块、0–1比例、默认深色字底', () => {
    expect(normalizeClearAreas([{ x: 0, y: 0.5, w: 1, h: 0.4 }])).toEqual([{ id: 'text-1', tone: 'dark', x: 0, y: 0.5, w: 1, h: 0.4 }]);
    expect(() => normalizeClearAreas([{ x: 0.5, y: 0, w: 0.8, h: 0.2 }])).toThrow(/画面内/);
    expect(() => normalizeClearAreas(Array(5).fill({ x: 0, y: 0, w: 0.5, h: 0.5 }))).toThrow(/4块/);
    expect(normalizeClearAreas(undefined)).toEqual([]);
  });
  it('要求里写明位置、明暗、主体让开，且不要画成方框', () => {
    const text = clearAreaPrompt(normalizeClearAreas([areas[0]]));
    expect(text).toContain('从上往下60%到92%');
    expect(text).toContain('偏暗');
    expect(text).toContain('主体放在这些区域之外');
    expect(text).toContain('不要画成方框或卡片');
  });
  it('按真实像素核对：干净暗区通过，细节多的亮区不通过并给出建议', async () => {
    const result = await checkClearAreas(art(), normalizeClearAreas(areas), { width: 400, height: 600, raster: renderVisualScene });
    expect(result.status).toBe('failed');
    expect(result.areas[0]).toMatchObject({ id: 'news', ok: true });
    expect(result.areas[1]).toMatchObject({ id: 'title', ok: false });
    expect(result.areas[1].problem).toBeTruthy();
    expect(result.advice).toContain('不要把正文硬压');
  }, 60000);
  it('generate_image：留白要求进生图请求，回执带像素核对结果', async () => {
    const imageGen = vi.fn(async () => ({ blob: art(), model: 'fixture' }));
    const tool = createTools({ imageGen, renderVisualScene }).find(t => t.name === 'generate_image');
    const receipt = JSON.parse(await tool.run({ prompt: '科技蓝智能机器人', purpose: 'poster_art', size: '1024x1536', keep_clear: [areas[0]] }));
    expect(imageGen.mock.calls[0][0].prompt).toContain('版式留白');
    expect(imageGen.mock.calls[0][0].prompt).toContain('不要任何文字'); // 原素材约束保留
    expect(receipt.clearAreas).toMatchObject({ status: 'passed', areas: [{ id: 'news', ok: true }] });
  }, 60000);
});

it('海报指引要求生成配图时先标出文字区并看核对结果', async () => {
  const { POSTER_GUIDANCE } = await import('../src/agent/posterRouting.js');
  for (const word of ['keep_clear', 'clearAreas', '必须写design.concept', 'chart图层']) expect(POSTER_GUIDANCE).toContain(word);
});
