/** 2026-11-17 用户讨论“GPT生成卡槽的，文字怎么添加”：先按真实文案算好卡槽，再写进生图要求，填字时按计划核对 */
import { describe, expect, it, vi } from 'vitest';
import { planCanvasSlots, slotImagePrompt, validSlotPlan, flatRegion, parseImageSize } from '../src/agent/canvasSlotPlan.js';
import { locateImageText } from '../src/agent/imageTextRegions.js';
import { compositionToolArgs } from '../src/agent/imageCompositionPrompt.js';

const slots = {
  header: { title: '社区秋季健康讲座', body: '免费参加 · 名额有限' },
  entries: [
    { title: '时间', body: '11月22日（周六）上午9:30' },
    { title: '地点', body: '幸福里社区服务中心三楼多功能厅' },
    { title: '内容', body: '高血压日常管理、秋冬饮食建议、现场答疑，可携带近期体检报告请医生解读' }
  ],
  footer: '报名电话：025-1234 5678'
};
/** 合成画面：整体有噪点纹理，只有给定区域是平整的中灰色（像素找卡片找不到“浅色长条”，只能靠计划核对） */
function frame(width, height, flat = []) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, inside = flat.some(r => x >= r.x * width && x < (r.x + r.w) * width && y >= r.y * height && y < (r.y + r.h) * height);
    const v = inside ? 150 : (x * 37 + y * 91) % 200;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { width, height, data };
}
const entries = [{ role: 'header', title: 'h' }, { role: 'slot', title: 'a' }, { role: 'slot', title: 'b' }, { role: 'slot', title: 'c' }, { role: 'footer', title: 'f' }];

describe('卡槽先排版后生图', () => {
  it('按文案长短算出标题区、卡片、底注和主体，长内容的卡片更高，互不重叠、都在画面内', () => {
    const plan = planCanvasSlots(slots, 1024, 1536);
    expect(plan.regions.map(r => r.id)).toEqual(['header', 'slot-1', 'slot-2', 'slot-3', 'footer']);
    const [header, a, b, c, footer] = plan.regions;
    expect(c.h).toBeGreaterThan(a.h);
    for (const [upper, lower] of [[header, a], [a, b], [b, c], [c, footer]]) expect(upper.y + upper.h).toBeLessThanOrEqual(lower.y + 1e-6);
    for (const r of plan.regions) expect(r.y + r.h).toBeLessThanOrEqual(1);
    expect(plan.subject.h).toBeGreaterThanOrEqual(0.2);
    expect(plan.subject.y).toBeGreaterThanOrEqual(header.y + header.h);
    expect(plan.subject.y + plan.subject.h).toBeLessThanOrEqual(a.y);
    expect(validSlotPlan(JSON.parse(JSON.stringify(plan)), 2048, 3072)).toBeTruthy();
    expect(validSlotPlan(plan, 1536, 1024)).toBeNull(); // 比例不符不采用
  });
  it('文案太多放不下主体时如实报错，不缩字', () => {
    const many = { entries: Array.from({ length: 12 }, (_, i) => ({ title: '第' + i + '项', body: '这是一段比较长的说明文字，用来占用卡片高度，看看会不会挤掉主体画面的位置。'.repeat(2) })) };
    expect(() => planCanvasSlots(many, 1024, 1536)).toThrow(/主体/);
    expect(() => planCanvasSlots({ entries: [] }, 1024, 1536)).toThrow(/1–12/);
  });
  it('生图要求写明每块的百分比位置和主体范围，并禁止画任何字', () => {
    const plan = planCanvasSlots(slots, ...parseImageSize('1024x1536'));
    const prompt = slotImagePrompt('秋天的社区小广场，银杏树，温暖光线', plan);
    expect(prompt).toContain('秋天的社区小广场');
    expect(prompt).toMatch(/第1张卡片：从上往下[\d.]+%到[\d.]+%/);
    expect(prompt).toContain('标题留白');
    expect(prompt).toContain('底注留白');
    expect(prompt).toContain('主体（人物、产品、场景）放在');
    expect(prompt).toContain('整张图任何地方都不要写字');
    expect(parseImageSize('')).toEqual([1024, 1536]);
  });
  it('海报请求不把卡槽底图改成普通素材用途', () => {
    const args = { prompt: 'x', purpose: 'poster_slots', text_slots: slots };
    expect(compositionToolArgs('generate_image', args, '制作中文海报')).toBe(args);
  });
  it('像素没找到卡片时，按计划核对：计划位置真是平整留白才采用，并把主体设为保护区', async () => {
    const plan = planCanvasSlots(slots, 400, 600);
    const located = await locateImageText({ spec: {}, entries, frame: frame(400, 600, plan.regions), ctx: {}, plan });
    expect(located.detection.method).toBe('plan+pixels');
    expect(located.regions.map(r => r.id)).toEqual(['header', 'slot-1', 'slot-2', 'slot-3', 'footer']);
    expect(located.protected.map(r => r.id)).toEqual(['subject']);
  });
  it('生出来的图没按计划留白：不硬套计划，交给看图定位或报需要排版', async () => {
    const plan = planCanvasSlots(slots, 400, 600);
    const vision = vi.fn(async () => { throw new Error('offline'); });
    const located = await locateImageText({ spec: {}, entries, frame: frame(400, 600, plan.regions.slice(0, 2)), ctx: { visionLlm: vision }, plan, blob: new Blob([new Uint8Array([1])], { type: 'image/png' }) });
    expect(located.detection.method).toBe('needs_layout');
    expect(flatRegion(frame(400, 600), plan.regions[1])).toBe(false);
  });
});

describe('generate_image 卡槽底图', () => {
  it('purpose=poster_slots：要求里写入计划位置，图片旁另存同名.slots.json，回执告诉下一步怎么填字', async () => {
    const { createTools } = await import('../src/agent/tools.js');
    const ws = await import('../src/agent/workspace.js');
    const { collection, useBackend } = await import('../src/agent/store.js');
    useBackend(null);
    await collection('files').clear();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X0AAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const imageGen = vi.fn(async () => ({ blob: new Blob([png], { type: 'image/png' }), model: 'fixture' }));
    const tool = createTools({ imageGen }).find(t => t.name === 'generate_image');
    const receipt = JSON.parse(await tool.run({ prompt: '秋天的社区小广场', purpose: 'poster_slots', text_slots: slots }));
    expect(imageGen).toHaveBeenCalledTimes(1);
    expect(imageGen.mock.calls[0][0].size).toBe('1024x1536');
    expect(imageGen.mock.calls[0][0].prompt).toMatch(/第3张卡片：从上往下/);
    expect(receipt.slotsPath).toBe(receipt.path.replace(/\.png$/, '.slots.json'));
    const saved = JSON.parse(await ws.readText(receipt.slotsPath));
    expect(saved).toMatchObject({ kind: 'canvas-slot-plan', version: 1, width: 1024, height: 1536 });
    expect(receipt.next).toContain(receipt.path);
    await expect(tool.run({ prompt: 'x', purpose: 'poster_slots' })).rejects.toThrow(/1–12/);
  });
});
