/** 真实问题：“这个图的场景描述下先发散思维”被当成普通查询，45 秒时模型还在思考就被按“查资料时间到了”打断，最后什么都没写 */
import { describe, it, expect } from 'vitest';
import { isQuickLookup } from '../src/agent/lookupDeadline.js';
import { createModelRequest } from '../src/agent/agentModelRequest.js';
import { createLookupWindow } from '../src/agent/lookupWindow.js';

describe('要她动脑的话不套普通查询的 60 秒', () => {
  it('描述、发散、讲讲图、出主意、编故事：不算普通查询；查天气、查票房照旧', () => {
    for (const t of ['这个图的场景描述下先发散思维', '给我讲讲这张图', '帮我出个主意', '编个睡前故事', '你怎么看这件事']) expect(isQuickLookup(t), t).toBe(false);
    for (const t of ['北京今天天气', '比较这两部电影的票房', '演员是谁', '你好']) expect(isQuickLookup(t), t).toBe(true);
  });
});

describe('没开始查资料时，不按“查资料时间到了”打断模型', () => {
  // 假模型：想 80 毫秒才答；查资料窗口只给 0 毫秒（相当于已经过了 45 秒）
  const slowModel = { model: 'm', adapter: { kind: 'openai', stream: async ({ onText }) => { await new Promise((r) => setTimeout(r, 80)); onText('答案'); return { text: '答案', toolCalls: [], stop: 'end_turn' }; } } };
  const control = { remaining: () => 30_000, retrievalRemaining: () => 0 };
  const make = (active, current = slowModel) => createModelRequest({ current, signal: new AbortController().signal, lookupDeadline: true, lookupControl: control, closing: false, retrieval: { active, left: 6, remaining: Infinity, close() {} }, emit() {}, onNativeSearch() {}, onText() {}, onRetry() {} });
  it('还没查资料：让模型想完再答', async () => {
    const request = make(false);
    const r = await request.run({ system: ['', ''], messages: [{ role: 'user', content: '发散一下' }], tools: [] });
    expect(r.text).toBe('答案');
    request.dispose();
  });
  it('已经在查资料：时间到了照旧收尾', async () => {
    const request = make(true);
    await expect(request.run({ system: ['', ''], messages: [{ role: 'user', content: '查一下' }], tools: [] })).rejects.toMatchObject({ code: 'LOOKUP_RETRIEVAL_END' });
    request.dispose();
  });
  it('会自己联网的模型（Claude 等）卡在搜索里：时间到了照旧收尾', async () => {
    const request = make(false, { ...slowModel, adapter: { ...slowModel.adapter, kind: 'anthropic' } });
    await expect(request.run({ system: ['', ''], messages: [{ role: 'user', content: '查一下' }], tools: [] })).rejects.toMatchObject({ code: 'LOOKUP_RETRIEVAL_END' });
    request.dispose();
  });
  it('整理时间窗口本身不变', () => {
    expect(createLookupWindow({ totalMs: 60_000 }).retrievalRemaining()).toBeLessThanOrEqual(45_000);
  });
});
