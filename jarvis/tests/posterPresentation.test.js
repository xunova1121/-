import { describe, it, expect, vi } from 'vitest';
import { planLayerDesign } from '../src/agent/layeredDesignLayout.js';
import { normalizeLayerDesign } from '../src/agent/layeredDesignInput.js';
import { checkDesignPresentation, phonePreviewSvg } from '../src/agent/layeredDesignPresentation.js';
import { checkLayerCopy, checkLayerOverlap, reviewLayeredDesign } from '../src/agent/layeredDesignQuality.js';
import { composeLayeredSvg } from '../src/agent/layeredDesignSvg.js';
import { validateVisualSceneSvg } from '../src/agent/visualSceneSvg.js';
import { posterFollowupRequirement } from '../src/agent/posterFollowup.js';
import { textPosterRequest, POSTER_GUIDANCE } from '../src/agent/posterRouting.js';
import { compositionToolArgs, imageCompositionPrompt } from '../src/agent/imageCompositionPrompt.js';
import { createTools } from '../src/agent/tools.js';
import { runAgent } from '../src/agent/agent.js';
import { availableLayerOutputBase, releaseLayerOutputBase } from '../src/agent/layeredDesignSource.js';
import { newsInput } from '../e2e/fixtures/layered-design.mjs';

const free = layers => planLayerDesign({ title: '今日要闻', width: 1024, height: 1536, design: { layout: 'free', layers } });
const body = { id: 'news-body', type: 'text', x: 60, y: 800, w: 900, h: 100, text: '正文不能在手机上缩成几乎看不见的小字。', fontSize: 16 };
const png = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' });

describe('海报实际阅读尺度', () => {
  it('复现“不重叠但小字”的海报，不能把几何通过当成手机可读', () => {
    const d = free([body]);
    expect(checkLayerOverlap(d).status).toBe('passed');
    expect(checkLayerCopy(d, composeLayeredSvg(d)).status).toBe('passed');
    expect(checkDesignPresentation(d)).toMatchObject({ status: 'failed', target: 'phone', previewWidth: 390, failed: [expect.objectContaining({ id: 'news-body', minimum: 12 })] });
  });
  it('4K画布不会把同样小字变成高质量，不能把长正文标caption绕过', () => {
    const d = normalizeLayerDesign({ ...free([{ ...body, text: '完整的新闻正文，不能为了假装通过可读性而标成小字说明。', role: 'caption' }]), width: 2160, height: 3840 });
    expect(checkDesignPresentation(d).status).toBe('failed');
    expect(checkDesignPresentation(d).failed[0].role).toBe('body');
  });
  it('短正文即使误标caption也不能掩盖小字；整版背景图不误判为独占正文空间', () => {
    expect(checkDesignPresentation(free([{ ...body, text: '这是一条新闻正文', role: 'caption' }])).status).toBe('failed');
    const d = free(Array.from({ length: 5 }, (_, i) => ({ ...body, id: `story-${i}-body`, y: 300 + i * 140, text: '完整的新闻正文', fontSize: 36 })));
    d.assets = [{ id: 'art', path: '测试背景.png' }];
    d.layers.unshift({ id: 'background-art', type: 'image', x: 0, y: 0, w: 1024, h: 1536, asset: 'art', group: 'background' });
    expect(checkDesignPresentation(normalizeLayerDesign(d)).status).toBe('passed');
  });
  it('手机预览输出名也受并发互斥保护，不能与另一稿的主PNG冲突', async () => {
    const d = free([{ ...body, fontSize: 36 }]);
    const a = await availableLayerOutputBase({ path: '排版并发/preview.png' }, d);
    let b;
    try {
      b = await availableLayerOutputBase({ path: '排版并发/preview.phone.png' }, d);
      expect(b).not.toBe(a + '.phone');
    } finally { releaseLayerOutputBase(a); if (b) releaseLayerOutputBase(b); }
  });
  it('正常页脚和栏目标签有独立尺度，旧稿没有新检查不能冒称已检查', () => {
    const d = free([{ ...body, fontSize: 36 }, { ...body, id: 'footer', y: 1440, h: 60, text: '排版样张 · 非实时新闻', fontSize: 20, role: 'caption' }]);
    expect(checkDesignPresentation(d).status).toBe('passed');
    const old = { ...d }; delete old.reading;
    expect(checkDesignPresentation(normalizeLayerDesign(old)).status).toBe('not_checked');
  });
  it('手机预览缩放同一张原图，继续经过原SVG白名单，不能另排卡片冒充', () => {
    const d = free([{ ...body, fontSize: 36 }]), svg = composeLayeredSvg(d), preview = phonePreviewSvg(svg, d);
    const checked = validateVisualSceneSvg(preview.svg);
    expect([checked.width, checked.height]).toEqual([390, 585]);
    expect(preview.svg).toContain(body.text);
    expect(preview.svg).toContain('transform="scale(0.380859375)"');
    expect(checked.text).toContain(body.text);
  });
  it.each(['editorial', 'timeline', 'newspaper', 'campaign'])('%s保留七组全部原文且通过手机尺度，无压缩小字', layout => {
    const d = planLayerDesign({ ...newsInput, title: '今日要闻', subtitle: '七条速览，看见城市新变化', design: { ...newsInput.design, layout } });
    for (const s of newsInput.design.sections) {
      expect(d.layers.some(n => n.text === s.title)).toBe(true);
      expect(d.layers.some(n => n.text === s.body)).toBe(true);
    }
    expect(checkDesignPresentation(d).status).toBe('passed');
    expect(checkLayerOverlap(d).status).toBe('passed');
    expect(checkLayerCopy(d, composeLayeredSvg(d)).status).toBe('passed');
  });
  it('换结构确实改变坐标与骨架，保留同一配色及完整内容', () => {
    const make = layout => planLayerDesign({ ...newsInput, design: { ...newsInput.design, layout } });
    const timeline = make('timeline'), newspaper = make('newspaper');
    expect(timeline.palette).toEqual(newspaper.palette);
    expect(timeline.layers.some(n => n.id === 'timeline-spine')).toBe(true);
    expect(newspaper.layers.some(n => n.id === 'newspaper-divider')).toBe(true);
    expect(timeline.layers.find(n => n.id === 'section-3-title').x).not.toBe(newspaper.layers.find(n => n.id === 'section-3-title').x);
  });
  it.each(['timeline', 'newspaper'])('有原图的%s换结构仍保留素材，不以不支持为由丢图', layout => {
    const d = planLayerDesign({ ...newsInput, title: '今日要闻', design: { ...newsInput.design, layout, assets: [{ id: 'original', path: '原始图片.png' }] } });
    expect(d.layers.find(n => n.type === 'image').asset).toBe('original');
    expect(d.assets[0].path).toBe('原始图片.png');
    expect(checkDesignPresentation(d).status).toBe('passed');
    expect(checkLayerOverlap(d).status).toBe('passed');
  });
  it('放不下时明确拒绝，不隐去新闻、不改成6px小字', () => {
    expect(() => planLayerDesign({ ...newsInput, width: 1024, height: 1024, design: { ...newsInput.design, layout: 'campaign' } })).toThrow(/可读字号|手机可读/);
    const reading = { ...free([{ ...body, fontSize: 36 }]), reading: 'invalid' };
    expect(() => normalizeLayerDesign(reading)).toThrow(/阅读场景/);
  });
  it('成品看图只调用一次，同时带原图和实际缩放图，不放宽原核验字段', async () => {
    const d = free([{ ...body, fontSize: 36 }]);
    const visionLlm = vi.fn(async () => '{"copyMatches":true,"readable":true,"noOverlap":true,"issues":["主视觉仍残留空卡片"]}');
    const consume = vi.fn(), result = await reviewLayeredDesign({ visionLlm }, d, png, { previewPng: png, retrieval: { consume } });
    expect(result.status).toBe('failed'); expect(visionLlm).toHaveBeenCalledTimes(1); expect(consume).toHaveBeenCalledTimes(1);
    expect(visionLlm.mock.calls[0][0].images).toHaveLength(2);
    expect(visionLlm.mock.calls[0][0].system).toContain('不能以放大原图可读代替');
    expect(visionLlm.mock.calls[0][0].allowWebSearch).toBe(false);
  });
});

describe('实际海报任务的能力发现与素材约束', () => {
  it('新增素材规范不破坏普通工具调用关联，回执回到下一次请求且次数保持', async () => {
    const tool = { name: 'fixture_echo', description: '回传固定测试文本', input_schema: { type: 'object', properties: {} }, run: async () => '真实工具回执' };
    let calls = 0;
    const adapter = { async stream({ messages, onText }) {
      if (++calls === 1) return { text: '', toolCalls: [{ id: 'echo', name: tool.name, args: {} }], stop: 'tool_use' };
      expect(messages.find(m => m.role === 'tool')?.content).toBe('真实工具回执');
      onText('完成'); return { text: '完成', toolCalls: [], stop: 'end_turn' };
    } };
    const result = await runAgent({ adapter, tools: [tool], model: 'fixture', userText: '执行样例', history: [], context: { dynamic: '' }, emit() {}, quiet: true });
    expect(result.toolCalls).toBe(1); expect(calls).toBe(2);
  });
  const history = [{ role: 'user', content: '做今日新闻海报' }, { role: 'assistant', content: '海报：设计/新闻.design.json；可以换结构。' }];
  it.each(['换结构，不动颜色', '再做一个其他风格', '做一个类似这种的', '没合成？', '做啊'])('短追问“%s”保留本轮海报能力说明', text => {
    const normalized = posterFollowupRequirement(text, history);
    expect(normalized.startsWith(text)).toBe(true);
    expect(textPosterRequest(normalized)).toBe(true);
    expect(POSTER_GUIDANCE).toContain('不能沿用历史回答声称');
  });
  it.each(['查询今天的天气', '只解释为什么换结构不行', '先不做，再做一个风格怎么办'])('新问题或禁止执行的提问“%s”不被旧海报接管', text => {
    expect(posterFollowupRequirement(text, history)).toBe(text);
  });
  it('新网页/驾驶舱话题隔断旧海报，不扫描整个历史攀附旧任务', () => {
    const web = [...history, { role: 'user', content: '帮我写一个网页' }, { role: 'assistant', content: '网页已完成，接下来可以换风格。' }];
    expect(posterFollowupRequirement('换个风格', web)).toBe('换个风格');
    expect(posterFollowupRequirement('换个风格', [{ role: 'assistant', content: '城市驾驶舱Demo，源稿design/城市.design.json' }])).toBe('换个风格');
  });
  it('海报和同稿Demo生图在执行层补素材用途；不改变用户明确直接画字的选择', () => {
    const args = { prompt: '右侧蓝色玻璃装置，左侧柔和光线' };
    expect(compositionToolArgs('generate_image', args, '制作中文海报')).toMatchObject({ purpose: 'poster_art' });
    expect(compositionToolArgs('generate_image', args, '制作高清图文原型Demo')).toMatchObject({ purpose: 'poster_art' });
    expect(compositionToolArgs('generate_image', args, 'GPT 2.6直接画整张带字海报')).toBe(args);
    expect(compositionToolArgs('generate_image', { ...args, purpose: 'poster_art' }, '制作海报和交互Demo，用GPT 2.6直接画整张带字海报').purpose).toBe('general');
    expect(compositionToolArgs('generate_image', args, '画一只猫')).toBe(args);
    expect(compositionToolArgs('process_image', args, '制作中文海报')).toBe(args);
    expect(args).not.toHaveProperty('purpose');
  });
  it('实际generate_image请求包含禁字/空框约束，仍只调用原服务一次；原片/选项不丢', async () => {
    const imageGen = vi.fn(async () => ({ blob: png, model: 'fixture' }));
    const tool = createTools({ imageGen }).find(t => t.name === 'generate_image');
    await tool.run({ prompt: '右侧科技装置', purpose: 'poster_art', size: '1024x1536', quality: 'high' });
    expect(imageGen).toHaveBeenCalledTimes(1);
    expect(imageGen.mock.calls[0][0]).toMatchObject({ size: '1024x1536', quality: 'high', images: [] });
    expect(imageGen.mock.calls[0][0].prompt).toContain('空胶囊框');
    expect(imageGen.mock.calls[0][0].prompt).toContain('不要任何文字');
    expect(imageCompositionPrompt('直接画标题「你好」')).toBe('直接画标题「你好」');
    expect(() => imageCompositionPrompt('素材', 'other')).toThrow(/图片用途/);
  });
});
