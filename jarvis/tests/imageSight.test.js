/** 真实问题：主模型是 DeepSeek 文字模型，图片硬塞过去被换成“Unsupported Image”，未央以为图片坏了、让用户换 PNG 重发 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { visionRoute, seesImages } from '../src/llm/router.js';
import { createImageSight, NO_SIGHT_NOTE } from '../src/agent/imageSight.js';

const IMG = { mime: 'image/jpeg', data: '/9j/AAAA' };
const ctx = { dynamic: '测试', kbHits: [] };

describe('看图找谁', () => {
  const base = { provider: 'deepseek', models: { deepseek: 'deepseek-v4-pro' }, keys: { deepseek: 'sk-d' } };
  it('只填了 DeepSeek：用 DeepSeek 官方的看图模型', () => {
    expect(seesImages('deepseek-v4-pro')).toBe(false);
    const r = visionRoute(base);
    expect(r).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash-vision-exp', auto: true });
    expect(r.cfg.models.deepseek).toBe('deepseek-v4-flash-vision-exp');
    expect(seesImages(r.model)).toBe(true);
  });
  it('还填了百炼：优先 qwen-vl', () => {
    expect(visionRoute({ ...base, keys: { ...base.keys, qwen: 'sk-q' } })).toMatchObject({ provider: 'qwen', model: 'qwen-vl-max' });
  });
  it('分工里设了“看图”就用设的；当前模型自己能看就用当前的', () => {
    expect(visionRoute({ ...base, keys: { ...base.keys, qwen: 'sk-q' }, routing: { enabled: true, provider: 'deepseek', routes: { vision: 'qwen::qwen3-vl-plus' } } })).toMatchObject({ provider: 'qwen', model: 'qwen3-vl-plus', auto: false });
    expect(visionRoute({ provider: 'openai', models: { openai: 'gpt-5.1' }, keys: { openai: 'k' } })).toMatchObject({ model: 'gpt-5.1', auto: false });
  });
  it('一个能看图的都没有：null', () => {
    expect(visionRoute({ provider: 'moonshot', models: { moonshot: 'kimi-latest' }, keys: { moonshot: 'k' } })).toBeNull();
  });
});

describe('图片换成文字', () => {
  it('主模型看不了图：交给看图模型描述，图片不再发给主模型', async () => {
    const asked = [];
    const events = [];
    const see = createImageSight({ model: 'deepseek-v4-pro', label: 'qwen-vl-max', describe: async (o) => { asked.push(o); return '一张夜景照片：湖边亮着路灯，远处有三座高楼。'; }, emit: (e) => events.push(e) });
    const m = { role: 'tool', content: '图片 uploads/a.jpg', images: [IMG] };
    await see(m, { hint: '这个图的场景描述下先发散思维' });
    expect(m.images).toBeUndefined();
    expect(m.content).toContain('湖边亮着路灯');
    expect(m.content).toContain('qwen-vl-max');
    expect(asked[0].images).toEqual([IMG]);
    expect(asked[0].prompt).toContain('发散思维');
    expect(events[0]).toMatchObject({ type: 'seeing' });
  });
  it('主模型自己能看：原样不动', async () => {
    const describe = vi.fn();
    const m = { role: 'user', content: '看看', images: [IMG] };
    await createImageSight({ model: 'qwen-vl-max', describe })(m);
    expect(m.images).toEqual([IMG]);
    expect(describe).not.toHaveBeenCalled();
  });
  it('没有看图模型：图片照旧发；DeepSeek 这类只认文字的附上“看不到就如实说”，只附一次', async () => {
    const see = createImageSight({ model: 'deepseek-v4-pro' });
    const m = { role: 'user', content: '请看看这张图片', images: [IMG] };
    await see(m);
    await see(m);
    expect(m.images).toEqual([IMG]);
    expect(m.content.split(NO_SIGHT_NOTE)).toHaveLength(2);
    expect(NO_SIGHT_NOTE).toContain('不是图片格式的问题');
    const unknown = { role: 'user', content: '看看', images: [IMG] };
    await createImageSight({ model: 'my-relay-model' })(unknown);
    expect(unknown.content).toBe('看看'); // 认不出的名字可能能看：不打扰
  });
  it('看图模型出错：如实说没看到，不让用户换格式', async () => {
    const m = { role: 'user', content: '看图', images: [IMG, IMG] };
    await createImageSight({ model: 'deepseek-v4-pro', describe: async () => { throw new Error('503'); } })(m);
    expect(m.images).toBeUndefined();
    expect(m.content).toContain('2 张图片');
    expect(m.content).toContain('不要说图片格式有问题');
  });
});

describe('整个流程：读到工作区里的图片', () => {
  let agent;
  beforeEach(async () => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    agent = await import('../src/agent/agent.js');
  });
  afterEach(() => { delete globalThis.indexedDB; });

  it('read_file 读出的图片和用户发的图：主模型收到的是文字描述，没有图片', async () => {
    const seen = [];
    let n = 0;
    const adapter = {
      kind: 'openai',
      async stream(o) {
        seen.push(o.messages.map((m) => ({ role: m.role, images: m.images?.length || 0, content: String(m.content) })));
        if (++n === 1) return { text: '', toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'uploads/a.jpg' } }], stop: 'tool_use' };
        o.onText('看到了：湖边夜景。');
        return { text: '看到了：湖边夜景。', toolCalls: [], stop: 'end_turn' };
      }
    };
    const tools = [{ name: 'read_file', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string' } } }, run: async () => ({ text: '图片 uploads/a.jpg', images: [IMG] }) }];
    const describe = vi.fn(async () => '湖边夜景，路灯，三座高楼。');
    const r = await agent.runAgent({ adapter, model: 'deepseek-v4-pro', history: [], userText: '请看看这张图片', images: [IMG], tools, context: ctx, emit: () => {}, quiet: true, describeImages: describe, visionLabel: 'qwen-vl-max' });
    expect(r.text).toContain('湖边夜景');
    expect(describe).toHaveBeenCalledTimes(2);
    for (const request of seen) for (const m of request) expect(m.images).toBe(0);
    expect(seen[0].at(-1).content).toContain('路灯');
    expect(seen[1].find((m) => m.role === 'tool').content).toContain('三座高楼');
  });
});
