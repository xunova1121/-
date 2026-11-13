import { describe, it, expect } from 'vitest';
import { runTeam, shouldTeam, ruleBasedPlan, toolsFor } from '../src/agent/team.js';

const TOOLS = ['web_search', 'deep_research', 'fetch_url', 'write_file', 'read_file', 'run_python', 'preview', 'create_document', 'computer_run', 'get_current_time', 'mcp_fs__read']
  .map((name) => ({ name, input_schema: { type: 'object', properties: {} } }));

describe('团队模式：何时组团、怎么拆', () => {
  it('明确要求或多个先后步骤时组团', () => {
    expect(shouldTeam('/团队 写个网页')).toBe(true);
    expect(shouldTeam('/团队 写个网页', 'off')).toBe(true);
    expect(shouldTeam('你好')).toBe(false);
    expect(shouldTeam('先调研一下 2026 年国产大模型的价格，然后整理成对比表格，最后写一份给老板看的 Word 报告')).toBe(true);
    expect(shouldTeam('先调研一下 2026 年国产大模型的价格，然后整理成对比表格，最后写一份给老板看的 Word 报告', 'off')).toBe(false);
    expect(shouldTeam('你好', 'on')).toBe(true);
  });

  it('规则拆步：按连接词切开并猜角色', () => {
    const p = ruleBasedPlan('/团队 调研一下本机大模型，然后写一个介绍网页，最后写一份总结报告');
    expect(p.map((s) => s.role)).toEqual(['researcher', 'coder', 'writer']);
    expect(p[1].detail).toBe('写一个介绍网页');
  });

  it('每个角色只拿到相关工具（加上通用工具）', () => {
    const names = (r) => toolsFor(r, TOOLS).map((t) => t.name);
    expect(names('researcher')).toEqual(['web_search', 'deep_research', 'fetch_url', 'read_file', 'get_current_time', 'mcp_fs__read']);
    expect(names('writer')).toEqual(['write_file', 'read_file', 'preview', 'create_document', 'get_current_time']);
    expect(names('generalist')).toHaveLength(TOOLS.length);
  });
});

function harness({ llmReplies = [] } = {}) {
  const events = [];
  const calls = [];
  const prompts = [];
  const llm = async ({ system }) => { prompts.push(system); return llmReplies.shift() ?? ''; };
  const run = async (o) => {
    calls.push({ userText: o.userText, tools: o.tools.map((t) => t.name) });
    o.emit({ type: 'tool_start', id: `t${calls.length}`, name: o.tools[0]?.name ?? 'x', args: {} });
    o.emit({ type: 'text', delta: '中间步骤的文字不应直接出现在回答里' });
    o.emit({ type: 'tool_end', id: `t${calls.length}`, name: 'x', ok: true, output: 'ok', ms: 1 });
    return { text: `第 ${calls.length} 次执行的成果`, toolCalls: 1 };
  };
  const adapter = { async stream({ onText }) { onText('最终答复'); return { text: '最终答复', toolCalls: [] }; } };
  return { events, calls, prompts, llm, run, adapter, emit: (e) => events.push(e) };
}

describe('团队执行流程', () => {
  it('规划 → 分角色执行（带前序成果）→ 审核不通过返工 → 通过 → 汇总', async () => {
    const h = harness({
      llmReplies: [
        '```json\n{"steps":[{"role":"researcher","title":"查价格","detail":"搜索各家价格"},{"role":"writer","title":"写报告","detail":"写成 Word"}]}\n```',
        '{"pass":false,"issues":["报告缺少价格来源"],"fix_step":2}',
        '{"pass":true,"issues":[]}'
      ]
    });
    const r = await runTeam({ adapter: h.adapter, model: 'm', userText: '/团队 调研价格并写报告', tools: TOOLS, emit: h.emit, llm: h.llm, run: h.run });
    expect(h.calls).toHaveLength(3);
    expect(h.calls[0].tools).toContain('web_search');
    expect(h.calls[0].tools).not.toContain('create_document');
    expect(h.calls[1].tools).toContain('create_document');
    expect(h.calls[1].userText).toMatch(/^写成 Word/);
    expect(h.calls[1].userText).toContain('第 1 次执行的成果');
    expect(h.calls[2].userText).toContain('报告缺少价格来源');
    const plan = h.events.find((e) => e.type === 'team_plan');
    expect(plan.steps.map((s) => s.roleName)).toEqual(['研究员', '撰稿人']);
    expect(h.events.filter((e) => e.type === 'team_step').map((e) => `${e.index}:${e.status}`))
      .toEqual(['0:running', '0:done', '1:running', '1:done', '1:redo', '1:running', '1:done']);
    expect(h.events.filter((e) => e.type === 'team_review').map((e) => e.pass)).toEqual([false, true]);
    // 中间步骤的文字不进回答；工具事件照常转发
    const text = h.events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    expect(text).toBe('最终答复');
    expect(h.events.filter((e) => e.type === 'tool_start')).toHaveLength(3);
    expect(r).toMatchObject({ text: '最终答复', toolCalls: 3, steps: 2 });
  });

  it('返工最多一次：第二次审核仍不通过也结束', async () => {
    const h = harness({ llmReplies: ['{"steps":[{"role":"coder","title":"写网页","detail":"写网页"}]}', '{"pass":false,"issues":["a"],"fix_step":1}', '{"pass":false,"issues":["b"],"fix_step":1}'] });
    await runTeam({ adapter: h.adapter, model: 'm', userText: '写网页', tools: TOOLS, emit: h.emit, llm: h.llm, run: h.run });
    expect(h.calls).toHaveLength(2);
    expect(h.events.filter((e) => e.type === 'team_review').at(-1)).toMatchObject({ pass: false, final: true });
  });

  it('没有大模型：规则拆步、跳过审核、拼接各步成果', async () => {
    const h = harness();
    const r = await runTeam({ adapter: h.adapter, model: 'm', userText: '/团队 搜索一下天气，然后写一个网页', tools: TOOLS, emit: h.emit, llm: null, run: h.run });
    expect(h.calls.map((c) => c.userText.split('\n')[0])).toEqual(['搜索一下天气', '写一个网页']);
    expect(h.events.find((e) => e.type === 'team_review')).toMatchObject({ skipped: true });
    expect(r.text).toContain('**1. 研究员 · 搜索一下天气**');
    expect(r.text).toContain('第 2 次执行的成果');
  });

  it('某一步失败不影响后面的步骤；取消会中止', async () => {
    const h = harness();
    let n = 0;
    const run = async (o) => { if (++n === 1) throw new Error('网络错误'); return h.run(o); };
    const r = await runTeam({ adapter: h.adapter, model: 'm', userText: '/团队 搜索天气，然后写网页', tools: TOOLS, emit: h.emit, llm: null, run });
    expect(h.events.filter((e) => e.type === 'team_step' && e.status === 'fail')).toHaveLength(1);
    expect(r.text).toContain('失败：网络错误');
    const ac = new AbortController();
    ac.abort();
    await expect(runTeam({ adapter: h.adapter, model: 'm', userText: '/团队 a，然后b', tools: TOOLS, emit: () => {}, llm: null, run: h.run, signal: ac.signal })).rejects.toThrow(/aborted/);
  });
});
