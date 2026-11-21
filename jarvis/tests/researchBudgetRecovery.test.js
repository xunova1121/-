import { describe, it, expect, vi } from 'vitest';
import { createRetrievalBudget, createLookupClock } from '../src/agent/lookup/clock.js';
import { withLookupDeadline } from '../src/agent/lookup/turn.js';
import { deepResearch, DEPTHS } from '../src/agent/research.js';
import { RESEARCH_BUDGETS } from '../src/agent/researchBudget.js';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { runAgent } from '../src/agent/agent.js';

const question = '江苏天合云商股份有限公司简介';
const call = (name, args = {}) => ({ id: name, name, args });
const tool = (name, run) => ({ name, description: name, input_schema: { type: 'object', properties: {} }, run });
const fixtures = () => ({
  llm: vi.fn(async ({ system }) => {
    if (/检索计划/.test(system)) return JSON.stringify({ queries: [question] });
    if (/摘录/.test(system)) return JSON.stringify({ relevant: true, points: ['江苏天合云商股份有限公司提供供应链服务；此为测试资料。'] });
    if (/是否足以/.test(system)) return JSON.stringify({ enough: true });
    return '## 结论摘要\n测试公司资料 [1][2]';
  }),
  search: vi.fn(async () => [1, 2].map(n => ({ title: `公司介绍${n}`, url: `https://source${n}.example/company`, snippet: question }))),
  read: vi.fn(async () => `${question}，公开页面介绍企业供应链服务。`.repeat(8))
});

function execution(tools, retrieval, extra = {}) {
  return { loader: { get: name => tools.find(item => item.name === name) }, seen: new Map(), emit: vi.fn(),
    review: createExecutionReview(question), retrieval, webTools: new Set(['deep_research', 'lookup_company']), parallelSafe: new Set(), ...extra };
}

describe('调研与普通查询预算协调', () => {
  it('重现普通简介3次辅助调用中断；进入实际工具后能够核对并生成答案', async () => {
    const oldBudget = createRetrievalBudget(question);
    oldBudget.begin();
    const before = fixtures();
    await expect(deepResearch({ question, ...before, consume: kind => oldBudget.consume(kind) })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(before.llm).toHaveBeenCalledTimes(3);
    const budget = createRetrievalBudget(question);
    const after = fixtures();
    const research = tool('deep_research', async (_args, context) => {
      const result = await deepResearch({ question, ...after, signal: context.signal, consume: kind => context.retrieval.consume(kind) });
      return result.markdown;
    });
    const [result] = await executeToolCalls([call('deep_research')], execution([research], budget));
    expect(result.ok).toBe(true);
    expect(result.output).toContain('测试公司资料');
    expect(result.output).toContain('https://source1.example/company');
    expect(after.llm).toHaveBeenCalledTimes(5);
    expect(budget.resources).toEqual({ model: 5, search: 1, read: 2 });
  });

  it.each(Object.keys(RESEARCH_BUDGETS))('%s额度有界，已消耗计数保留，重复/升档不能续时或补额度', depth => {
    let at = 0;
    const clock = createLookupClock({ totalMs: 60_000, now: () => at });
    const budget = createRetrievalBudget(question, { clock, now: () => at });
    budget.begin(); budget.consume('search'); budget.consume('model');
    at = 10_000;
    budget.beginResearch(depth);
    expect(budget.resources).toEqual({ model: 1, search: 1, read: 0 });
    const deadline = clock.totalMs;
    const remaining = budget.remaining;
    at += 1000;
    budget.beginResearch('deep');
    expect(clock.totalMs).toBe(deadline);
    expect(budget.remaining).toBe(remaining - 1000);
    for (let i = 0; i < RESEARCH_BUDGETS[depth].model; i++) budget.consume('model');
    expect(() => budget.consume('model')).toThrow(/本轮调研.*预算/);
    expect(budget.resources.model).toBe(RESEARCH_BUDGETS[depth].model + 1);
  });

  it('普通web查询仍只有3次辅助调用；显式期限和已经关闭的预算不能被调研绕过', () => {
    const ordinary = createRetrievalBudget('今天南京多少度');
    for (let i = 0; i < 3; i++) ordinary.consume('model');
    expect(() => ordinary.consume('model')).toThrow(/普通查询/);
    const clock = createLookupClock({ totalMs: 60_000 });
    const explicit = createRetrievalBudget(question, { clock, timeBudgetMs: 20_000 });
    explicit.begin(); explicit.beginResearch('deep');
    expect(clock.totalMs).toBe(60_000);
    expect(explicit.remaining).toBeLessThanOrEqual(20_000);
    const long = createRetrievalBudget(question, { timeBudgetMs: 600_000 });
    long.begin(); long.beginResearch('quick');
    expect(long.remaining).toBeLessThanOrEqual(RESEARCH_BUDGETS.quick.durationMs);
    const closed = createRetrievalBudget(question);
    closed.close('检索已结束');
    expect(() => closed.beginResearch()).toThrow('检索已结束');
    expect(closed.extensive).toBe(false);
  });

  it.each(['search', 'read'])('调研%s及重试有有限次数，严格核验原限制仍保留', kind => {
    const ordinary = createRetrievalBudget(question);
    ordinary.beginResearch('quick');
    for (let i = 0; i < RESEARCH_BUDGETS.quick[kind]; i++) ordinary.consume(kind);
    expect(() => ordinary.consume(kind)).toThrow(/本轮调研.*预算/);
    const strict = createRetrievalBudget('逐项核验原文');
    strict.beginResearch('deep');
    for (let i = 0; i < (kind === 'search' ? 20 : 16); i++) strict.consume(kind);
    expect(() => strict.consume(kind)).toThrow(/预算/);
  });

  it('工具截止时间在升级之后创建，70秒调研不会被旧60秒时钟截断', async () => {
    vi.useFakeTimers();
    try {
      const result = withLookupDeadline({ userText: question }, async options => {
        const budget = createRetrievalBudget(question, { clock: options.lookupControl });
        const research = tool('deep_research', async () => {
          await new Promise(resolve => setTimeout(resolve, 70_000));
          return '已完成调研';
        });
        const [response] = await executeToolCalls([call('deep_research')], execution([research], budget, options));
        return { text: response.output };
      });
      await vi.advanceTimersByTimeAsync(70_001);
      expect((await result).text).toBe('已完成调研');
    } finally { vi.useRealTimers(); }
  });
});

describe('调研中断保留资料与取消', () => {
  it('预算异常继续向上抛，附带已取得的有界来源摘要，执行器保留失败与部分证据', async () => {
    const budget = createRetrievalBudget(question);
    let used = 0;
    const research = tool('deep_research', async (_args, context) => {
      return deepResearch({ question, ...fixtures(), signal: context.signal,
        consume: kind => { if (kind === 'model' && used++ >= 3) throw Object.assign(new Error('本轮辅助调用结束'), { code: 'RETRIEVAL_BUDGET' }); } });
    });
    const [result] = await executeToolCalls([call('deep_research')], execution([research], budget));
    expect(result.ok).toBe(false);
    expect(result.failure.code).toBe('RETRIEVAL_BUDGET');
    expect(result.output).toContain('调研未完成');
    expect(result.output).toContain('https://source1.example/company');
    expect(result.output).toContain('尚未完成交叉核对');
    expect(result.output.length).toBeLessThan(2000);
    expect(budget.reason).toBe('本轮辅助调用结束');
  });

  it('用户取消仍抛AbortError，不写回迟到的网页证据或伪装成部分完成', async () => {
    const abort = new AbortController();
    const web = fixtures();
    const saved = vi.fn();
    await expect(deepResearch({ question, ...web, signal: abort.signal, onEvidence: saved,
      read: async () => { abort.abort(); return '迟到的网页正文'.repeat(50); }
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(saved).not.toHaveBeenCalled();
    expect(web.llm).toHaveBeenCalledTimes(1);
  });

  it.each(Object.keys(DEPTHS))('%s总读取页数不超过声明上限，预留最后写作调用', async depth => {
    let round = 0;
    const llm = vi.fn(async ({ system }) => {
      if (/检索计划/.test(system)) return '{"queries":["first"]}';
      if (/摘录/.test(system)) return '{"points":["来源中的测试公司事实"]}';
      if (/是否足以/.test(system)) return JSON.stringify({ enough: false, queries: ['next' + ++round] });
      return '测试结论 [1]';
    });
    const read = vi.fn(async () => '测试公司介绍'.repeat(30));
    const result = await deepResearch({ question, depth, llm, read,
      search: async query => Array.from({ length: 20 }, (_, n) => ({ title: '网页', url: `https://site${n}.example/${query}`, snippet: '公司资料' })) });
    expect(read.mock.calls.length).toBeLessThanOrEqual(DEPTHS[depth].pages);
    expect(llm.mock.calls.length).toBeLessThanOrEqual(RESEARCH_BUDGETS[depth].model);
    expect(result.markdown).toContain('测试结论');
  });
});

it('企业空结果和tool_search成功不阻断无资料后的自主接续，真实非空结果才计作取数', async () => {
  let at = 0, stage = 0;
  const events = [], prompts = [];
  const company = tool('lookup_company', async () => { at += 50_000; return JSON.stringify({ items: [], dataRetrieved: false }); });
  const web = tool('web_search', vi.fn(async () => '江苏天合云商股份有限公司，公开公司介绍：https://company.example/about'));
  const filler = Array.from({ length: 28 }, (_, n) => tool('fixture_' + n, async () => ''));
  const adapter = { async stream({ messages, onText, allowWebSearch }) {
    prompts.push({ messages: structuredClone(messages), allowWebSearch });
    if (stage++ === 0) return { text: '', toolCalls: [call('tool_search', { names: ['lookup_company'] })], stop: 'tool_use' };
    if (stage === 2) return { text: '', toolCalls: [call('lookup_company')], stop: 'tool_use' };
    if (stage === 3) return { text: '', toolCalls: [call('web_search')], stop: 'tool_use' };
    onText('根据公司公开页面，已找到公司简介。');
    return { text: '根据公司公开页面，已找到公司简介。', toolCalls: [], stop: 'end_turn' };
  } };
  const result = await runAgent({ adapter, model: 'fixture', userText: question, history: [], now: () => at,
    tools: [company, web, ...filler], emit: event => events.push(event), context: { dynamic: '', memory: '', lessons: [], skills: [], summary: null } });
  expect(result.text).toContain('已找到公司简介');
  expect(web.run).toHaveBeenCalledTimes(1);
  expect(events.some(event => event.phase === 'self_drive')).toBe(true);
  expect(prompts[2].allowWebSearch).toBe(true);
  const recovery = prompts[2].messages.at(-1).content;
  expect(recovery).toContain('lookup_company：没取得有效结果');
  expect(recovery).not.toContain('lookup_company：取得结果');
});
