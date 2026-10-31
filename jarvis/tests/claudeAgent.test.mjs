/**
 * 用本地假服务器模拟 Messages API 的流式响应，验证 ClaudeAgent 的事件映射与工具循环。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { ClaudeAgent } from '../server/agents.mjs';

const requests = [];
let script = [];

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function message({ blocks, stop }) {
  const ev = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const piece of b.pieces) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    } else {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{}' } });
    }
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev.push({ type: 'message_stop' });
  return ev;
}

let server;
let agent;
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    requests.push({ headers: req.headers, body: JSON.parse(body) });
    sse(res, message(script.shift()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  agent = new ClaudeAgent({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${server.address().port}` });
});
afterAll(() => server.close());

async function collect(messages) {
  const out = [];
  for await (const ev of agent.run(messages)) out.push(ev);
  return out;
}

describe('ClaudeAgent', () => {
  it('剥离情绪标签 → emotion_hint；文本 → delta；结束 → done', async () => {
    requests.length = 0;
    script = [{ blocks: [{ type: 'text', pieces: ['<emotion>安', '抚</emotion>', '没关系，', '慢慢来。'] }], stop: 'end_turn' }];
    const evs = await collect([{ role: 'user', content: '好累' }]);
    expect(evs[0]).toMatchObject({ task_state: 'processing' });
    expect(evs.find((e) => e.emotion_hint)?.emotion_hint).toBe('安抚');
    expect(evs.map((e) => e.delta).join('')).toBe('没关系，慢慢来。');
    expect(evs.at(-1).task_state).toBe('done');

    const req = requests[0];
    expect(req.body.model).toBe('claude-opus-5-5');
    expect(req.body.stream).toBe(true);
    expect(req.body.fallbacks).toBe('default');
    expect(req.body.output_config).toEqual({ effort: 'low' });
    expect(req.body.thinking).toBeUndefined();
    expect(req.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(req.body.tools.map((t) => t.name)).toEqual(['get_local_metrics', 'get_current_time']);
    // 系统提示保持冻结：不含时间戳等每次变化的内容
    expect(req.body.system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('工具轮：上报 processing + 工具名，回传 tool_result 后继续生成', async () => {
    requests.length = 0;
    script = [
      { blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'get_current_time' }], stop: 'tool_use' },
      { blocks: [{ type: 'text', pieces: ['<emotion>平静</emotion>现在是下午三点。'] }], stop: 'end_turn' }
    ];
    const evs = await collect([{ role: 'user', content: '几点了' }]);
    expect(evs.some((e) => e.task_state === 'processing' && e.tool === 'get_current_time')).toBe(true);
    expect(evs.map((e) => e.delta).join('')).toBe('现在是下午三点。');
    expect(requests).toHaveLength(2);
    const second = requests[1].body.messages;
    expect(second.at(-2).role).toBe('assistant');
    expect(second.at(-2).content[0]).toMatchObject({ type: 'tool_use', id: 'toolu_1' });
    expect(second.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(JSON.parse(second.at(-1).content[0].content)).toHaveProperty('timeZone');
  });

  it('拒绝：给出礼貌说明，不当作错误', async () => {
    script = [{ blocks: [], stop: 'refusal' }];
    const evs = await collect([{ role: 'user', content: 'x' }]);
    expect(evs.map((e) => e.delta).join('')).toContain('没办法协助');
    expect(evs.at(-1).task_state).toBe('done');
  });

  it('历史不以用户消息结尾时报错', async () => {
    await expect(collect([{ role: 'assistant', content: 'hi' }])).rejects.toThrow();
  });
});
