import { describe, it, expect } from 'vitest';
import { runAgent } from '../src/agent/agent.js';
import { createTools, validateArgs } from '../src/agent/tools.js';
import { createMockAdapter, plan } from '../src/llm/mock.js';
import { createAccumulator, sseLines, toOpenAIMessages } from '../src/llm/openai.js';
import { toAnthropicMessages } from '../src/llm/anthropic.js';
import * as ws from '../src/agent/workspace.js';
import * as memory from '../src/agent/memory.js';
import * as kb from '../src/agent/knowledge.js';
import { tokenize, buildIndex, chunkText } from '../src/agent/search.js';

const ctx = { metrics: async () => ({ cpu: { percent: 10 }, memory: { percent: 20 }, network: { online: true } }) };

async function run(userText, adapter = createMockAdapter({ charDelayMs: 0 })) {
  const events = [];
  const r = await runAgent({ adapter, model: 'x', history: [], userText, tools: createTools(ctx), emit: (e) => events.push(e) });
  return { r, events, text: events.filter((e) => e.type === 'text').map((e) => e.delta).join('') };
}

describe('检索', () => {
  it('中文二元组分词', () => {
    expect(tokenize('机器学习')).toEqual(['机', '机器', '器', '器学', '学', '学习', '习']);
    expect(tokenize('Hello the World 2026')).toEqual(['hello', 'world', '2026']);
  });
  it('BM25 排序', () => {
    const s = buildIndex([{ id: 'a', text: '今天天气晴朗' }, { id: 'b', text: '季度销售额增长百分之二十' }, { id: 'c', text: '销售团队' }]);
    expect(s('销售额')[0].id).toBe('b');
    expect(s('完全无关的词xyz')).toEqual([]);
  });
  it('切块保留重叠', () => {
    const chunks = chunkText(`${'甲'.repeat(500)}\n\n${'乙'.repeat(500)}`, { size: 600, overlap: 50 });
    expect(chunks).toHaveLength(2);
    expect(chunks[1].startsWith('甲'.repeat(50))).toBe(true);
  });
});

describe('模型适配器', () => {
  it('OpenAI 流式：文本与分片的工具调用', () => {
    const texts = [];
    const acc = createAccumulator((t) => texts.push(t));
    acc.push({ choices: [{ delta: { content: '好的' } }] });
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_', arguments: '{"pa' } }] } }] });
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.txt","content":"x"}' } }] }, finish_reason: 'tool_calls' }] });
    const r = acc.result();
    expect(texts).toEqual(['好的']);
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'write_file', args: { path: 'a.txt', content: 'x' }, parseError: null }]);
  });
  it('OpenAI：截断的参数 JSON 标记为解析错误', () => {
    const acc = createAccumulator();
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"a":' } }] } }] });
    expect(acc.result().toolCalls[0].parseError).toMatch('不是合法 JSON');
  });
  it('SSE 分行保留不完整的尾巴', () => {
    expect(sseLines('data: {"a":1}\n\ndata: [DONE]\ndata: {"b"')).toEqual({ events: ['{"a":1}', '[DONE]'], rest: 'data: {"b"' });
  });
  it('统一消息 → OpenAI / Anthropic 格式', () => {
    const msgs = [
      { role: 'user', content: '写文件' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', args: { x: 1 } }, { id: 't2', name: 'b', args: {} }] },
      { role: 'tool', toolCallId: 't1', name: 'a', content: 'ok' },
      { role: 'tool', toolCallId: 't2', name: 'b', content: 'bad', isError: true }
    ];
    const o = toOpenAIMessages(['sys', 'ctx'], msgs);
    expect(o[0]).toEqual({ role: 'system', content: 'sys\n\nctx' });
    expect(o[2].tool_calls[0].function.arguments).toBe('{"x":1}');
    expect(o[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'ok' });
    const a = toAnthropicMessages(msgs);
    expect(a).toHaveLength(3);
    expect(a[2].content.map((b) => b.tool_use_id)).toEqual(['t1', 't2']);
    expect(a[2].content[1].is_error).toBe(true);
  });
});

describe('智能体循环（离线演示模型）', () => {
  it('写网页 → 预览 → 总结', async () => {
    const previews = [];
    const events = [];
    await runAgent({
      adapter: createMockAdapter({ charDelayMs: 0 }), model: 'x', history: [], userText: '帮我写一个网页',
      tools: createTools({ ...ctx, onPreview: (p) => previews.push(p) }), emit: (e) => events.push(e)
    });
    expect(events.filter((e) => e.type === 'tool_end').map((e) => [e.name, e.ok])).toEqual([['write_file', true], ['preview', true]]);
    expect(previews).toEqual(['demo/clock.html']);
    expect(await ws.readText('demo/clock.html')).toContain('<!doctype html>');
    expect(events.find((e) => e.type === 'emotion').value).toBe('专注');
    expect(events.at(-1)).toEqual({ type: 'state', value: 'done' });
  });

  it('生成 Word / PPT / Excel 文件', async () => {
    for (const [q, f] of [['生成一份Word周报', 'docx'], ['做一个PPT', 'pptx'], ['做一个Excel表格', 'xlsx']]) {
      const { events } = await run(q);
      const end = events.find((e) => e.type === 'tool_end');
      expect(end.ok).toBe(true);
      expect(end.output).toContain(`.${f}`);
      expect(await ws.exists(`文档/示例.${f}`)).toBe(true);
    }
  }, 20_000); // 真的生成三份 Office 文件：单独跑 2–3 秒，全部测试并行时机器忙，默认 5 秒会偶尔超时

  it('记住偏好，下次上下文里能取到', async () => {
    await run('记住我喜欢简洁的回答');
    const c = await memory.contextFor('回答风格');
    expect(c.memories.map((m) => m.content)).toContain('我喜欢简洁的回答');
  });

  it('知识库检索并注明来源', async () => {
    await kb.addDocument({ name: '员工手册.docx', text: '年假规定：入职满一年的员工每年享有带薪年假十天。' });
    const { events, text } = await run('根据知识库，年假有几天？');
    expect(events.find((e) => e.type === 'sources')?.items).toContain('员工手册.docx');
    expect(text).toContain('年假');
  });

  it('工具参数缺失时返回错误让模型修正，而不是崩溃', async () => {
    const tools = createTools(ctx);
    expect(validateArgs(tools.find((t) => t.name === 'write_file'), { path: 'a' })).toBe('缺少必填参数 content');
    expect(validateArgs(tools.find((t) => t.name === 'create_document'), { format: 'exe', path: 'a', content: 'x' })).toMatch('只能是');
    let n = 0;
    const adapter = {
      async stream({ messages, onText }) {
        n++;
        if (n === 1) return { text: '', toolCalls: [{ id: '1', name: 'write_file', args: { path: 'a.txt' } }], stop: 'tool_use' };
        const text = `<emotion>警觉</emotion>收到：${messages.at(-1).content}`;
        onText(text);
        return { text, toolCalls: [], stop: 'end_turn' };
      }
    };
    const { events, text } = await run('x', adapter);
    expect(events.find((e) => e.type === 'tool_end').ok).toBe(false);
    expect(text).toContain('缺少必填参数 content');
  });

  const TICK = { name: 'tick', description: '测试用：总是成功', input_schema: { type: 'object', properties: { n: { type: 'number' } } }, run: async ({ n }) => `ok ${n}` };
  it('步数到了上限但还在推进：自动接着做完，不停下来问', async () => {
    let n = 0;
    const adapter = { async stream({ onText }) {
      n++;
      if (n <= 7) return { text: '', toolCalls: [{ id: String(n), name: 'tick', args: { n } }], stop: 'tool_use' };
      onText('做完了'); return { text: '做完了', toolCalls: [], stop: 'end_turn' };
    } };
    const r = await runAgent({ adapter, model: 'x', history: [], userText: 'go', tools: [TICK], emit: () => {}, maxSteps: 3 });
    expect(r.toolCalls).toBe(7);
    expect(r.text).toBe('做完了');
  });

  it('原地打转（同样的调用反复做、大多失败）：拦下重复调用，卡住就停', async () => {
    const adapter = { async stream() { return { text: '', toolCalls: [{ id: String(Math.random()), name: 'get_current_time', args: {} }], stop: 'tool_use' }; } };
    const events = [];
    const r = await runAgent({ adapter, model: 'x', history: [], userText: 'loop', tools: createTools(ctx), emit: (e) => events.push(e), maxSteps: 3 });
    expect(events.filter((e) => e.type === 'tool_end' && !e.ok)[0].output).toMatch(/已经做过 2 次/);
    expect(r.toolCalls).toBeLessThan(12);
    expect(r.text).toContain('卡住');
  });

  it('一直在做但停不下来：最多做到上限的 4 倍', async () => {
    let n = 0;
    const adapter = { async stream() { n++; return { text: '', toolCalls: [{ id: String(n), name: 'tick', args: { n } }], stop: 'tool_use' }; } };
    const r = await runAgent({ adapter, model: 'x', history: [], userText: 'go', tools: [TICK], emit: () => {}, maxSteps: 3 });
    expect(r.toolCalls).toBe(12);
    expect(r.text).toContain('连续做了 12 步');
  });

  it('演示模型的意图识别', () => {
    expect(plan([{ role: 'user', content: '运行一段代码' }]).calls[0].name).toBe('run_javascript');
    expect(plan([{ role: 'user', content: '总结 报告.pdf' }]).calls[0]).toMatchObject({ name: 'read_file', args: { path: '报告.pdf' } });
    expect(plan([{ role: 'user', content: '你好' }]).text).toContain('离线演示模式');
  });
});

describe('进化等级', () => {
  it('经验值与等级', () => {
    expect(memory.levelOf({})).toMatchObject({ xp: 0, level: 1 });
    expect(memory.levelOf({ memories: 5, skills: 2, lessons: 1, docs: 1, tasks: 3 }).xp).toBe(10 + 10 + 3 + 2 + 3);
    expect(memory.levelOf({ skills: 4 }).level).toBe(3);
  });
});

describe('工作区', () => {
  it('路径规范化与越界保护', () => {
    expect(ws.normalize('/a//b/./c.txt')).toBe('a/b/c.txt');
    expect(() => ws.normalize('../etc/passwd')).toThrow('..');
  });
});

describe('多步输出的表达标签', () => {
  it('每一步开头的 <emotion> 标签都会被剥离', async () => {
    const { text, events } = await run('帮我写一个网页');
    expect(text).not.toContain('<emotion>');
    expect(events.filter((e) => e.type === 'emotion').map((e) => e.value)).toEqual(['专注', '愉悦']);
  });
});
