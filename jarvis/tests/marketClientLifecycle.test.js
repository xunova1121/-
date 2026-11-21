import { describe, expect, it, vi } from 'vitest';
import { createTurnInputs } from '../src/app/turnInputs.js';
import { createRemoteTask } from '../src/app/remoteTask.js';

const transport = vi.hoisted(() => ({ runRemote: vi.fn() }));
vi.mock('../src/core/serverClient.js', async original => ({ ...await original(), runRemote: transport.runRemote }));
vi.mock('../src/agent/sessions.js', async original => ({ ...await original(), get: vi.fn(async () => null) }));
vi.mock('../src/app/env.js', () => ({ $: vi.fn(), DESKTOP: null, COMPACT: false, now: () => performance.now(), toast: vi.fn() }));
const snapshot = { version: 1, kind: 'quote', title: '行情', fetchedAt: Date.parse('2026-11-12T10:00:00Z'), quotes: [{ symbol: 'sh600519', name: '示例公司', price: 1500, unit: '元', time: '2026-11-11 15:00:00', source: { name: '只用于展示的来源标记', url: 'https://example.com/quote-only-metadata' } }] };
describe('行情客户端生命周期', () => {
  it('本机真实takeTurnInput组装路径仅发送历史正文，不把行情元数据加入LLM history', () => {
    const app = {
      attachments: [], history: [{ role: 'assistant', content: '上一轮行情已整理。', ts: Date.now(), markets: [snapshot] }], session: { summary: null },
      renderAttachments: vi.fn(), director: { onUserText: vi.fn() }, hud: { newTurn: vi.fn(), think: vi.fn() }
    };
    const next = createTurnInputs(app).takeTurnInput('继续解释', false);
    expect(next.llmHistory).toEqual([{ role: 'assistant', content: '上一轮行情已整理。' }]);
    expect(JSON.stringify(next.llmHistory)).not.toContain('quote-only-metadata');
    expect(app.history[0].markets).toEqual([snapshot]);
  });
  for (const reason of ['abort', 'streamDone']) it(`接回服务器任务后${reason}，迟到行情事件不能继续写原气泡或新会话`, async () => {
    let emit, finish;
    transport.runRemote.mockImplementationOnce(async (_server, opts) => {
      emit = opts.emit;
      await new Promise(resolve => { finish = resolve; });
    });
    const bubble = { el: { classList: { add: vi.fn() } }, marketCards: vi.fn(), done: vi.fn() };
    const session = { id: 'original', taskId: 'task' };
    const app = { server: {}, session, transcript: { add: () => bubble }, setTask: vi.fn(), replayTranscript: vi.fn() };
    const followed = createRemoteTask(app).followServerTask(session);
    const original = app.active;
    emit({ type: 'market_quote', value: snapshot });
    expect(bubble.marketCards).toHaveBeenCalledTimes(1);
    const saved = structuredClone(original.markets);
    if (reason === 'abort') original.ctrl.abort(); else original.streamDone = true;
    app.session = { id: 'different' }; app.active = { session: app.session };
    emit({ type: 'market_quote', value: { ...snapshot, fetchedAt: snapshot.fetchedAt + 1, quotes: [{ ...snapshot.quotes[0], price: 99 }] } });
    expect(bubble.marketCards).toHaveBeenCalledTimes(1);
    expect(original.markets).toEqual(saved); expect(app.active.markets).toBeUndefined();
    finish(); await followed;
    expect(app.replayTranscript).not.toHaveBeenCalled();
  });
});
