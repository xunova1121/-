import { describe, it, expect, vi } from 'vitest';
import { createLookupWindow, modelWindow } from '../src/agent/lookupWindow.js';
import { searchRequest, screenSearchHits, createQueryLedger } from '../src/agent/retrievalQuality.js';
import { reviewOutcome } from '../src/agent/reviewOutcome.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { runAgent } from '../src/agent/agent.js';
import { probeDirectModel } from '../scripts/probe-model-stream.mjs';
import { qualityReport } from '../evals/quality-report.mjs';

const context = { dynamic: '' };
const input = { model: 'fixture', userText: '今天国内有哪些重要新闻？', history: [], context, tools: [], emit() {} };
const finalAnswer = (text) => ({ text, toolCalls: [], stop: 'end_turn' });

describe('普通查询预留整理窗口', () => {
  it('共享总时钟，不在每次调用时重置；长任务升级后解除短时限', () => {
    let clock = 0;
    let disabled = false;
    const control = createLookupWindow({ totalMs: 60000, now: () => clock, disabled: () => disabled });
    expect(control.retrievalRemaining()).toBe(45000);
    clock = 44000;
    expect(control.retrievalRemaining()).toBe(1000);
    expect(control.remaining()).toBe(16000);
    disabled = true;
    expect(control.remaining()).toBe(Infinity);
  });

  it('忽略取消的上游也结束检索阶段，不把控制信号当正常结果', async () => {
    vi.useFakeTimers();
    try {
      const control = createLookupWindow({ totalMs: 60000 });
      const controller = new AbortController();
      const frame = modelWindow(control, false, controller);
      const check = expect(frame.race(new Promise(() => {}))).rejects.toMatchObject({ code: 'LOOKUP_RETRIEVAL_END' });
      await vi.advanceTimersByTimeAsync(45000);
      await check;
      expect(controller.signal.aborted).toBe(true);
      frame.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('真实调度：45秒终止无结果检索，仍可用剩余时间给正式说明', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const messages = [];
      const adapter = { stream: async (options) => {
        calls++;
        messages.push(options);
        if (calls === 1) return new Promise(() => {});
        expect(options.allowWebSearch).toBe(false);
        expect(options.tools).toEqual([]);
        options.onText('暂未取得可核查来源。');
        return finalAnswer('暂未取得可核查来源。');
      } };
      const resultPromise = runAgent({ ...input, adapter });
      await vi.advanceTimersByTimeAsync(45001);
      const result = await resultPromise;
      expect(calls).toBe(2);
      expect(result.text).toContain('暂未取得');
      expect(result.review.outcome).toBe('partial');
      expect(messages[0].signal.aborted).toBe(true);
      expect(result.text).not.toContain('交付回执核对');
    } finally { vi.useRealTimers(); }
  });

  it('最后整理也卡住时59秒留存半成品，不等60秒全局错误', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let late;
      const emitted = [];
      const adapter = { stream: (options) => {
        if (++calls === 1) return new Promise(() => {});
        options.onText('已整理的部分。');
        late = options.onText;
        return new Promise(() => {});
      } };
      const resultPromise = runAgent({ ...input, adapter, emit: (event) => { if (event.type === 'text') emitted.push(event.delta); } });
      await vi.advanceTimersByTimeAsync(59001);
      const result = await resultPromise;
      expect(result.review.outcome).toBe('partial');
      expect(result.text).toContain('已整理的部分');
      const before = emitted.join('');
      late('迟到文字');
      expect(emitted.join('')).toBe(before);
    } finally { vi.useRealTimers(); }
  });

  it('用户停止仍为AbortError，不被改成部分完成', async () => {
    const controller = new AbortController();
    const resultPromise = runAgent({ ...input, signal: controller.signal, adapter: { stream: () => new Promise(() => {}) } });
    controller.abort();
    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('搜索相关性与每轮去重', () => {
  it('今日新闻补齐日期和检索类型，使用北京时间，用户显式freshness保留', () => {
    const now = Date.parse('2026-10-19T16:30:00Z');
    expect(searchRequest('国内', '今天国内重要新闻', undefined, now)).toEqual({ query: '国内 2026-10-20 新闻', freshness: 'day' });
    expect(searchRequest('国内新闻', '今天新闻', 'week', now)).toEqual({ query: '国内新闻', freshness: 'week' });
    expect(searchRequest('Node.js版本', '查版本', undefined, now).query).toBe('Node.js版本');
  });
  it('年度资料不能充当今日新闻，不删除真实报道，也不把未知日期当已核实', () => {
    const hits = [{ title: '2026年概况' }, { title: '国务院办公厅关于2026年部分节假日安排的通知' }, { title: '今日发布重要消息' }];
    const result = screenSearchHits(hits, '今天国内新闻');
    expect(result.rejected).toBe(2);
    expect(result.hits).toEqual([hits[2]]);
    expect(screenSearchHits(hits, '今年放假安排').hits).toEqual(hits);
  });
  it('重复词及标点变体不再次请求；不同任务隔离，缓存有上限', () => {
    const record = createQueryLedger();
    record('北京 新闻');
    expect(() => record('北京，新闻')).toThrow();
    expect(() => createQueryLedger()('北京新闻')).not.toThrow();
    for (let index = 0; index < 31; index++) record(`词${index}`);
    expect(() => record('更多')).toThrow();
  });
  it('已开始检索的普通任务最多三次主请求后收尾，不再空转七轮', async () => {
    let calls = 0;
    const adapter = { stream: async (options) => {
      calls++;
      if (!options.allowWebSearch) return finalAnswer('已有资料仍不足，不能编造。');
      return { text: '', toolCalls: [{ id: `s${calls}`, name: 'web_search', args: { query: `词${calls}` } }], stop: 'tool_use' };
    } };
    const tools = [{ name: 'web_search', input_schema: { type: 'object' }, run: async () => '搜索线索，尚待核实' }];
    const result = await runAgent({ ...input, adapter, tools });
    expect(calls).toBe(4);
    expect(result.toolCalls).toBe(3);
    expect(result.review.outcome).toBe('needs_review');
  });
  it('每轮budget对象持有独立查询指纹', () => {
    const first = createRetrievalBudget('查新闻');
    const second = createRetrievalBudget('查新闻');
    first.registerQuery('词');
    expect(() => first.registerQuery('词')).toThrow();
    expect(() => second.registerQuery('词')).not.toThrow();
  });
});

describe('交付状态不冒充语义通过', () => {
  it('失败新闻任务只有用户说明，不泄露内部验收指令', () => {
    const report = createExecutionReview('今天国内新闻').report();
    const outcome = reviewOutcome(report);
    expect(outcome.outcome).toBe('partial');
    expect(outcome.notice).toContain('不能当作查询成功');
    expect(outcome.notice).not.toMatch(/review_task|交付回执核对|不要重复操作/);
  });
  it('记录过搜索线索不代表答案正确，只标待复核', () => {
    const review = createExecutionReview('今天国内新闻');
    review.record({ name: 'web_search', ok: true });
    expect(reviewOutcome(review.report()).outcome).toBe('needs_review');
  });
  it('评测单独统计已知未完成，不把done当正确率', () => {
    const result = qualityReport({ results: [{ status: 'done', outcome: 'partial', quality: 'not_reviewed' }] });
    expect(result).toMatchObject({ knownIncomplete: 1, reviewedAccuracy: null, executionComplete: 1 });
  });
});

describe('直连测速不输出内容且不自动重试', () => {
  it('只记录首字和总耗时，禁用搜索重试', async () => {
    let clock = 0;
    const adapter = { stream: vi.fn(async (options) => {
      expect(options).toMatchObject({ allowWebSearch: false, maxTransientRetries: 0, maxPartialRetries: 0, tools: [] });
      clock = 25;
      options.onText('仅测试内容');
      clock = 40;
    }) };
    expect(await probeDirectModel({ adapter, model: 'fixture', question: '你好', now: () => clock })).toMatchObject({ status: 'done', firstTextMs: 25, totalMs: 40 });
    expect(adapter.stream).toHaveBeenCalledTimes(1);
  });
  it('响应报错不泄露上游消息或密钥', async () => {
    const result = await probeDirectModel({ adapter: { stream: async () => { throw Object.assign(new Error('secret-fixture'), { status: 429 }); } }, model: 'fixture', question: '你好' });
    expect(result.httpStatus).toBe(429);
    expect(JSON.stringify(result)).not.toContain('secret-fixture');
  });
  it('取消忽略signal的调用仍立即结束', async () => {
    const controller = new AbortController();
    const result = probeDirectModel({ adapter: { stream: () => new Promise(() => {}) }, model: 'fixture', question: '你好', signal: controller.signal });
    controller.abort();
    expect((await result).status).toBe('stopped');
  });
});
