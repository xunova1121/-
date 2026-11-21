import { describe, it, expect, vi } from 'vitest';
import { OutputBoundary } from '../src/llm/outputBoundary.js';
import { createOpenAIAdapter } from '../src/llm/openai.js';
import { createResponsesAdapter } from '../src/llm/responses.js';
import { verifyNumbers, currentTime } from '../src/agent/verifyNumbers.js';
import { userEvidence, summaryForTurn, hasCorrection } from '../src/agent/summaryEvidence.js';
import { updateSummary, summaryBlock } from '../src/agent/compress.js';
import { capabilityBlock, needsActionTools } from '../src/agent/dialoguePolicy.js';
import { createToolLoader } from '../src/agent/toolLoader.js';
import { runAgent } from '../src/agent/agent.js';
import { reliabilityCases } from '../evals/reliability-cases.mjs';

const visible = (input) => {
  const boundary = new OutputBoundary();
  let result = '';
  for (const char of input) result += boundary.push(char);
  return result + boundary.flush();
};
const context = { dynamic: '测试环境', kbHits: [] };
const run = (options) =>
  runAgent({
    adapter: {
      stream: async ({ onText }) => {
        onText('正式回答。');
        return { text: '正式回答。', toolCalls: [], stop: 'end_turn' };
      }
    },
    model: 'test',
    history: [],
    userText: '普通问题',
    tools: [],
    emit: () => {},
    context,
    ...options
  });

describe('真实对话故障回归（均为虚构数据）', () => {
  it('当前这句纠错立即使旧摘要待核对，不延迟到下一轮', async () => {
    let sentSystem = '';
    await run({
      context: undefined,
      summary: { text: '用户成本99元，等待用户重新提供', upTo: 1 },
      userText: '价格不对，你不是查到了吗',
      adapter: {
        stream: async ({ system, onText }) => {
          sentSystem = system.join('\n');
          onText('我先核对原记录。');
          return { text: '我先核对原记录。', toolCalls: [], stop: 'end_turn' };
        }
      }
    });
    expect(sentSystem).toContain('较早摘要需要核对');
    expect(sentSystem).not.toContain('用户成本99元');
  });

  it.each(['think', 'thinking', 'analysis', 'reasoning'])('分片隔离%s标签', (tag) => expect(visible(`<${tag}>内部分析</${tag}>正式答案`)).toBe('正式答案'));
  it('正常英文和代码里的示例标签不误删', () => {
    expect(visible('The meeting is on Friday.')).toBe('The meeting is on Friday.');
    expect(visible('```xml\n<think>示例</think>\n```')).toBe('```xml\n<think>示例</think>\n```');
  });
  it('已知英文分析草稿在逐字传输时也不会先泄漏开头', () => {
    const boundary = new OutputBoundary();
    let sent = '';
    expect(() => {
      for (const char of 'The user said hello. I need to consider the summary says a different value.') sent += boundary.push(char);
      sent += boundary.flush();
    }).toThrow();
    expect(sent).toBe('');
  });
  it('实际执行器拦截草稿后只修正一次，正式输出不含草稿', async () => {
    let attempts = 0;
    const shown = [];
    const result = await run({
      emit: (e) => {
        if (e.type === 'text') shown.push(e.delta);
      },
      adapter: {
        stream: async ({ onText }) => {
          const text = ++attempts === 1 ? 'The user said hello. I need to consider the summary says a different value.' : '正式中文答复。';
          onText(text);
          return { text, toolCalls: [], stop: 'end_turn' };
        }
      }
    });
    expect(attempts).toBe(2);
    expect(result.text).toBe('正式中文答复。');
    expect(shown.join('')).toBe('正式中文答复。');
  });
  it('修正失败后明确报错，不能无限重试或保存草稿', async () => {
    let calls = 0;
    await expect(
      run({
        adapter: {
          stream: async ({ onText }) => {
            calls++;
            onText('The user said hello. I need to consider the summary says another number.');
            return { text: '', toolCalls: [], stop: 'end_turn' };
          }
        }
      })
    ).rejects.toMatchObject({ code: 'ANALYSIS_IN_OUTPUT' });
    expect(calls).toBe(2);
  });
  it('结束标记后连接挂住也能完成OpenAI请求', async () => {
    const cancel = vi.fn();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\n'));
          },
          cancel
        })
      )
    );
    try {
      const result = await createOpenAIAdapter({ baseURL: 'https://test.invalid', retryDelays: [] }).stream({
        model: 'm',
        system: [],
        messages: [],
        tools: []
      });
      expect(result.text).toBe('完成');
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('Responses完成事件后不等EOF', async () => {
    const cancel = vi.fn();
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","delta":"完成"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'
              )
            );
          },
          cancel
        })
      );
    const result = await createResponsesAdapter({ baseURL: 'https://test.invalid', fetchImpl }).stream({ model: 'm', system: [], messages: [], tools: [] });
    expect(result.text).toBe('完成');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('长度截断不冒充完成', async () =>
    await expect(
      run({
        adapter: {
          stream: async ({ onText }) => {
            onText('未完成的正式内容');
            return { text: '未完成的正式内容', toolCalls: [], stop: 'length' };
          }
        }
      })
    ).rejects.toMatchObject({ code: 'MODEL_OUTPUT_LIMIT' }));
  it('用户确认执行时保留工具，当前无定时工具就明确不可调用', async () => {
    const previous = [{ role: 'assistant', content: '要不要帮你设明早提醒？' }];
    expect(needsActionTools('好的', previous)).toBe(true);
    let gotTools;
    await run({
      history: previous,
      userText: '好的',
      light: true,
      tools: [{ name: 'schedule_task', description: '定时', input_schema: { type: 'object' }, run: async () => '' }],
      adapter: {
        stream: async ({ tools, onText }) => {
          gotTools = tools;
          onText('需要按工具结果确认');
          return { text: '需要按工具结果确认', toolCalls: [], stop: 'end_turn' };
        }
      }
    });
    expect(gotTools.some((tool) => tool.name === 'schedule_task')).toBe(true);
    expect(capabilityBlock([])).toContain('本轮未开放');
  });
  it('已常驻的定时工具仍可按关键词发现', async () => {
    const tools = [{ name: 'schedule_task', description: '创建定时任务', input_schema: { type: 'object' } }];
    const loader = createToolLoader(tools, { limit: 0 });
    const result = await loader.get('tool_search').run({ query: '定时任务' });
    expect(result).toContain('schedule_task');
    expect(result).not.toContain('没有找到');
  });
  it('用户原话索引不会把助手旧价格变成事实，容量有上限', () => {
    const items = userEvidence(
      [],
      Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `我的成本${i + 1}元`, ts: i + 1 }))
    );
    expect(items).toHaveLength(8);
    expect(userEvidence([], [{ role: 'assistant', content: '用户成本99元', ts: 1 }])).toEqual([]);
  });
  it('数据纠正时暂不把旧摘要当事实和待办，原摘要不被删除', () => {
    const original = { text: '需要用户再报成本99元', upTo: 1 };
    const revised = summaryForTurn(original, [{ role: 'user', content: '你不是查到了吗', ts: 2 }]);
    expect(revised.review).toBe(true);
    expect(summaryBlock(revised)).not.toContain('成本99');
    expect(original.text).toContain('成本99');
    expect(hasCorrection([{ role: 'user', content: '价格不对' }])).toBe(true);
  });
  it('压缩遇纠错只提取用户证据，停止和预算错误向上传播', async () => {
    const messages = [
      { role: 'assistant', content: '成本99元', ts: 1 },
      { role: 'user', content: '之前数据不对，我成本20元', ts: 2 }
    ];
    const result = await updateSummary(messages, null, { keep: 0, batch: 1, llm: async () => '成本99元' });
    expect(result.text).not.toContain('成本99');
    expect(result.facts[0].quote).toContain('成本20');
    for (const error of [Object.assign(new Error('停止'), { name: 'AbortError' }), Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' })])
      await expect(
        updateSummary(messages, null, {
          keep: 0,
          batch: 1,
          llm: async () => {
            throw error;
          }
        })
      ).rejects.toBe(error);
  });
  it('盈亏和孕周使用算式核对', () => {
    expect(verifyNumbers('pnl', { cost: 20, price: 18 }).pnlPercent).toBe(-10);
    expect(verifyNumbers('gestational_age', { weeks: 20, days: 5, baseDate: '2026-10-18', targetDate: '2026-10-19' })).toMatchObject({ weeks: 20, days: 6 });
    expect(() => verifyNumbers('gestational_age', { weeks: 20, days: 5, baseDate: '2026-02-30', targetDate: '2026-03-01' })).toThrow();
  });
  it('T+1可卖底仓与委托有效范围，不保证成交', () => {
    const result = verifyNumbers('a_share_order', { totalShares: 1000, todayBuyShares: 400, sellShares: 1000, orderPrice: 8.8, lowerLimit: 9, upperLimit: 11 });
    expect(result.valid).toBe(false);
    expect(result.maxSellShares).toBe(600);
    expect(result.issues).toHaveLength(2);
    expect(result.note).toContain('不代表');
    expect(() => verifyNumbers('pnl', { cost: 0, price: 18 })).toThrow();
    expect(() => verifyNumbers('pnl', { cost: 20, price: NaN })).toThrow();
  });
  it('服务器UTC时钟也显式给北京时间，跨零点正确', () =>
    expect(currentTime(new Date('2026-10-19T16:30:00Z'))).toMatchObject({ beijing: expect.stringContaining('2026/10/20'), timeZone: 'Asia/Shanghai' }));
  it('30题核心评测全部脱敏并有验收标准，保留原60题入口', () => {
    expect(reliabilityCases).toHaveLength(30);
    expect(new Set(reliabilityCases.map((item) => item.id)).size).toBe(30);
    expect(reliabilityCases.every((item) => item.rubric && item.timeoutMs > 0)).toBe(true);
  });
});
