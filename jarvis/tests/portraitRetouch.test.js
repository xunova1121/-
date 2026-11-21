import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sizedRasterPng } from './fixtures/visualRasterImages.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { createImageTaskTool, imageTaskPrompt } from '../src/agent/imageTasks.js';
import { parsePortraitReview, reviewPortrait } from '../src/agent/portraitRetouch.js';
import { isPortraitRetouch } from '../src/core/portraitIntent.js';
import { followsImage, creativeWithoutLookup } from '../src/core/imageFollowup.js';
import { isQuickLookup } from '../src/agent/lookupDeadline.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { editImage } from '../src/llm/imageEdit.js';
import { BUILTIN_AGENTS } from '../src/agent/agentProfiles.js';
import { agentFormNote, withAgentRequirement } from '../src/agent/agentTurn.js';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';

// 几何图形作为可解码的像素夹具；视觉回执为替身，不声称通过真人美化验收。
const png = (width, height, color) => new Blob([sizedRasterPng(width, height, [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16)))], { type: 'image/png' });
const original = png(512, 768, '#e6d2c1'), edited = png(1024, 1536, '#e8d5c7');
const passed = { appearancePreserved: true, naturalSkin: true, naturalProportions: true, backgroundPreserved: true, noArtifacts: true, requestedChangeVisible: true, issues: [] };
let directory;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-retouch-'));
  useBackend(createFileStore(directory));
  await ws.write('上传/原片.png', original);
});
afterEach(() => { useBackend(null); fs.rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

function fixture(review = JSON.stringify(passed)) {
  const imageEdit = vi.fn(async options => {
    options.beforeRequest?.();
    return { blob: edited, model: 'gpt-image-2', requested: { size: options.size, quality: options.quality, output_format: options.outputFormat } };
  });
  const imageGen = vi.fn();
  const visionLlm = vi.fn(async () => review);
  const onFileChanged = vi.fn(), onImage = vi.fn();
  const ctx = { imageEdit, imageGen, visionLlm, onFileChanged, onImage };
  return { ctx, tool: createImageTaskTool(ctx), imageEdit, imageGen, visionLlm, onFileChanged };
}

it.each(['把妈妈P瘦，美化好看', '自然美颜，保留长相', '人像优化', '再瘦一点', '照片精修'])('自然修图意图“%s”不会套普通查询，也不主动联网', text => {
  expect(isPortraitRetouch(text)).toBe(true);
  expect(isQuickLookup(text)).toBe(false);
  expect(creativeWithoutLookup(text)).toBe(true);
  expect(createRetrievalBudget(text).extensive).toBe(true);
});
it.each(['美颜相机推荐', '什么是人像美化', '怎么开发美颜接口', '今天有什么新闻'])('讨论/选软件“%s”不当作原片编辑', text => {
  expect(isPortraitRetouch(text)).toBe(false);
});

it('修图追问沿用当前对话最近图片，没有原图缓存时不凭空带入图片', () => {
  const messages = [{ role: 'user', ts: 1, content: '上传照片' }, { role: 'assistant', content: '候选图' }];
  expect(followsImage('再瘦一点', messages, new Map([[1, true]]))).toBe(true);
  expect(followsImage('再瘦一点', [], new Map())).toBe(false);
});

it('选择人像操作不夹带海报默认比例/文案；明确修图原话覆盖旧海报预设', () => {
  const profile = BUILTIN_AGENTS.find(item => item.id === 'poster-designer');
  const fields = { size: '竖版', style: '国风美学', ratio: '9:16', caption: '旧海报文字', operation: '人像显瘦' };
  expect(agentFormNote(profile, fields)).toBe('用户选择：图片处理 人像显瘦');
  const agent = { profile, note: '用户选择：尺寸 竖版；画面比例 9:16；图片处理 创作新海报' };
  expect(withAgentRequirement('把妈妈P瘦，保持原图比例', agent)).toBe('把妈妈P瘦，保持原图比例');
  expect(withAgentRequirement('给人像美颜，再做成活动海报', agent)).toContain('用户选择');
});

it('美颜与显瘦是独立任务，默认自然、保留长相年龄和背景；不把upscale当瘦身', () => {
  const beauty = imageTaskPrompt('portrait_retouch');
  const slim = imageTaskPrompt('portrait_slim', { instructions: '只微调腰身，不改脸', strength: 'moderate' });
  expect(beauty).toMatchObject({ quality: 'high', outputFormat: 'png' });
  expect(beauty.prompt).toContain('保留皮肤纹理'); expect(beauty.prompt).toContain('不擅自改变脸型或身体形状');
  expect(slim.prompt).toContain('只微调腰身，不改脸'); expect(slim.prompt).toContain('衣服纹理、背景直线');
  expect(slim.prompt).toContain('年龄特征'); expect(slim.prompt).toContain('适度明显');
  expect(() => imageTaskPrompt('beautify')).toThrow('不支持');
  expect(() => imageTaskPrompt('__proto__')).toThrow('不支持');
});

it('真正把原片传给编辑，不走文生图；原图字节不动、结果原字节另存且双图只查一次', async () => {
  const f = fixture(), retrieval = { consume: vi.fn() };
  const out = JSON.parse(await f.tool.run({ task: 'portrait_slim', path: '上传/原片.png', instructions: '自然一些' }, { retrieval }));
  expect(f.imageGen).not.toHaveBeenCalled(); expect(f.imageEdit).toHaveBeenCalledOnce();
  const sent = f.imageEdit.mock.calls[0][0];
  expect(await sent.images[0].arrayBuffer()).toEqual(await original.arrayBuffer());
  expect(out).toMatchObject({ kind: 'portrait_retouch', task: 'portrait_slim', strength: 'natural', status: 'saved', readback: 'passed', actual: { width: 1024, height: 1536 }, portraitReview: { state: 'reviewed' }, source: { path: '上传/原片.png', unchanged: true } });
  expect(await (await ws.readBlob('上传/原片.png')).arrayBuffer()).toEqual(await original.arrayBuffer());
  expect(await (await ws.readBlob(out.path)).arrayBuffer()).toEqual(await edited.arrayBuffer());
  expect(out.path).toMatch(/^images\/原片-人像显瘦-/);
  expect(f.onFileChanged).toHaveBeenCalledWith(out.path);
  expect(f.visionLlm).toHaveBeenCalledOnce();
  const check = f.visionLlm.mock.calls[0][0];
  expect(check.images).toHaveLength(2);
  expect(check).toMatchObject({ allowWebSearch: false, maxWebSearches: 0, maxTransientRetries: 0, maxPartialRetries: 0 });
  expect(retrieval.consume.mock.calls).toEqual([['model'], ['model']]);
});

it('完整工具接入实际OpenAI编辑适配器：真实multipart原图、单次编辑POST与原像素读回', async () => {
  const encoded = Buffer.from(await edited.arrayBuffer()).toString('base64');
  const fetchImpl = vi.fn(async (url, options) => {
    expect(url).toBe('https://images.example/v1/images/edits');
    expect(options.body).toBeInstanceOf(FormData);
    expect(await options.body.get('image').arrayBuffer()).toEqual(await original.arrayBuffer());
    expect(options.body.get('model')).toBe('gpt-image-2');
    expect(options.body.get('prompt')).toContain('自然显瘦');
    expect(options.body.get('quality')).toBe('high');
    return new Response(JSON.stringify({ data: [{ b64_json: encoded }] }));
  });
  const cfg = { provider: 'custom', baseURLs: { custom: 'https://images.example/v1' }, keys: { custom: 'fixture-key' }, imageModel: 'gpt-image-2' };
  const tool = createImageTaskTool({ imageEdit: options => editImage(cfg, { ...options, fetchImpl }), visionLlm: async () => JSON.stringify(passed) });
  const result = JSON.parse(await tool.run({ task: 'portrait_slim', path: '上传/原片.png' }));
  expect(result).toMatchObject({ status: 'saved', readback: 'passed', actual: { width: 1024, height: 1536 }, portraitReview: { state: 'reviewed' } });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each([
  { ...passed, appearancePreserved: false, issues: ['五官出现非预期变化'] },
  { ...passed, noArtifacts: false, issues: ['衣服线条变形'] },
  { ...passed, requestedChangeVisible: false, issues: [] },
  { appearancePreserved: true },
  '不是JSON'
])('对照有变化/伪影/无效果/不完整时不谎称通过，不重新付费生成', async review => {
  const f = fixture(typeof review === 'string' ? review : JSON.stringify(review));
  const out = JSON.parse(await f.tool.run({ task: 'portrait_retouch', path: '上传/原片.png' }));
  expect(out.status).toBe('partial'); expect(out.portraitReview.state).not.toBe('reviewed');
  expect(await ws.exists(out.path)).toBe(true);
  expect(f.imageEdit).toHaveBeenCalledOnce(); expect(f.visionLlm).toHaveBeenCalledOnce();
});

it('没有看图配置也保留真实编辑候选和像素说明，不把未核验说成保真', async () => {
  const f = fixture(); delete f.ctx.visionLlm;
  const out = JSON.parse(await f.tool.run({ task: 'portrait_retouch', path: '上传/原片.png', size: '3840x2160' }));
  expect(out).toMatchObject({ status: 'partial', sizeMatch: false, actual: { width: 1024, height: 1536 }, portraitReview: { state: 'not_checked' } });
  expect(out.notes.join(' ')).toContain('实际返回1024×1536');
  expect(f.imageEdit).toHaveBeenCalledOnce(); expect(f.visionLlm).not.toHaveBeenCalled();
});

it('无效参数与已停止请求在收费编辑之前拒绝', async () => {
  const f = fixture();
  for (const args of [{ strength: 'extreme' }, { instructions: 'x'.repeat(1201) }, { size: '4K' }]) {
    await expect(f.tool.run({ task: 'portrait_slim', path: '上传/原片.png', ...args })).rejects.toMatchObject({ kind: 'input' });
  }
  const ctrl = new AbortController(); ctrl.abort();
  await expect(f.tool.run({ task: 'portrait_slim', path: '上传/原片.png' }, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.imageEdit).not.toHaveBeenCalled();
});

it('复核预算耗尽向上抛控制信号，已付费得到的候选仍保存且不再生成', async () => {
  const f = fixture(); let requests = 0;
  const retrieval = { consume() { if (++requests === 2) throw Object.assign(new Error('测试收尾'), { code: 'RETRIEVAL_BUDGET' }); } };
  const failure = await f.tool.run({ task: 'portrait_retouch', path: '上传/原片.png' }, { retrieval }).catch(error => error);
  expect(failure.code).toBe('RETRIEVAL_BUDGET');
  const saved = JSON.parse(failure.partialEvidence);
  expect(saved).toMatchObject({ saved: true, source: '上传/原片.png', portraitReview: 'not_checked' });
  expect(await ws.exists(saved.path)).toBe(true);
  expect(f.imageEdit).toHaveBeenCalledOnce(); expect(f.visionLlm).not.toHaveBeenCalled();
});

it('执行器把已保存但未复核的候选当部分交付，计真实编辑，不误隐藏成未执行的读取', async () => {
  const f = fixture(), events = [];
  let requests = 0;
  const retrieval = { extensive: true, consume() { if (++requests === 2) throw Object.assign(new Error('测试视觉收尾'), { code: 'RETRIEVAL_BUDGET' }); }, close: vi.fn() };
  const [result] = await executeToolCalls([{ id: 'retouch', name: 'process_image', args: { task: 'portrait_slim', path: '上传/原片.png' } }], {
    loader: { get: () => f.tool }, emit: event => events.push(event), seen: new Map(), closing: false, retrieval,
    review: { record() {}, report: () => ({ request: '自然显瘦' }) }, webTools: new Set(), parallelSafe: new Set()
  });
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.output)).toMatchObject({ status: 'partial', readback: 'passed', portraitReview: { state: 'not_checked' } });
  expect(events.find(event => event.type === 'tool_end')).toMatchObject({ ok: true });
  expect(events.some(event => event.type === 'diagnostic' && event.code === 'RETRIEVAL_BUDGET')).toBe(true);
  expect(retrieval.close).toHaveBeenCalled();
  expect(f.imageEdit).toHaveBeenCalledOnce(); expect(f.visionLlm).not.toHaveBeenCalled();
});

it('回执与问题列表有界，错误/字符串布尔/未知字段不能冒充通过', () => {
  expect(parsePortraitReview(JSON.stringify({ ...passed, appearancePreserved: 'true' })).state).toBe('not_checked');
  const result = parsePortraitReview(JSON.stringify({ ...passed, issues: Array(10).fill('x'.repeat(500)) }));
  expect(result.issues).toHaveLength(6); expect(result.issues.every(text => text.length <= 160)).toBe(true);
  expect(parsePortraitReview('x'.repeat(6001)).state).toBe('not_checked');
  expect(parsePortraitReview(JSON.stringify({ ...passed, issues: null })).state).toBe('not_checked');
});

it('复核超时只取消这一轮视觉请求，不重试收费，也不声称通过', async () => {
  vi.useFakeTimers();
  try {
    let signal;
    const visionLlm = vi.fn(options => { signal = options.signal; return new Promise(() => {}); });
    const pending = reviewPortrait({ visionLlm }, original, edited, { task: 'portrait_retouch' });
    await vi.advanceTimersByTimeAsync(25001);
    expect((await pending).state).toBe('not_checked');
    expect(signal.aborted).toBe(true); expect(visionLlm).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
