import { describe, it, expect } from 'vitest';
import { toOpenAIMessages } from '../src/llm/openai.js';
import { toAnthropicMessages } from '../src/llm/anthropic.js';
import { runAgent } from '../src/agent/agent.js';

const IMG = { mime: 'image/jpeg', data: 'QUJD' };

describe('看图：消息格式', () => {
  it('OpenAI 兼容：用户消息带图；工具返回的图放在随后的用户消息里', () => {
    const out = toOpenAIMessages(['sys'], [
      { role: 'user', content: '这是什么', images: [IMG] },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'computer_screenshot', args: {} }] },
      { role: 'tool', toolCallId: 't1', name: 'computer_screenshot', content: '已截屏', images: [IMG] },
      { role: 'assistant', content: '好的' }
    ]);
    expect(out[1].content).toEqual([{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }]);
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: '已截屏' });
    expect(out[4].role).toBe('user');
    expect(out[4].content[1].image_url.url).toContain('base64,QUJD');
    expect(out[5]).toMatchObject({ role: 'assistant', content: '好的' });
  });

  it('Anthropic：图片块在文字前；工具结果里可以带图片', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: '看看', images: [IMG] },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 's', args: {} }] },
      { role: 'tool', toolCallId: 't1', name: 's', content: '已截屏', images: [IMG] }
    ]);
    expect(out[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
    expect(out[0].content[1]).toEqual({ type: 'text', text: '看看' });
    expect(out[2].content[0].content[1].type).toBe('image');
  });

  it('不带图时保持纯文本（兼容不支持识图的模型）', () => {
    expect(toOpenAIMessages(['s'], [{ role: 'user', content: 'hi' }])[1].content).toBe('hi');
    expect(toAnthropicMessages([{ role: 'user', content: 'hi' }])[0].content).toBe('hi');
  });
});

describe('看图：智能体循环', () => {
  it('用户图片随第一条消息发出；工具返回 { text, images } 时图片交给模型', async () => {
    const seen = [];
    let step = 0;
    const adapter = {
      async stream({ messages, onText }) {
        seen.push(structuredClone(messages));
        if (step++ === 0) return { text: '', toolCalls: [{ id: 'a', name: 'snap', args: {} }], stop: 'tool_use' };
        onText('看到了');
        return { text: '看到了', toolCalls: [], stop: 'end_turn' };
      }
    };
    const tools = [{ name: 'snap', description: '', input_schema: { type: 'object', properties: {} }, run: async () => ({ text: '截好了', images: [IMG] }) }];
    const r = await runAgent({ adapter, model: 'm', history: [], userText: '帮我看看', images: [IMG], tools, emit: () => {}, context: { dynamic: '' } });
    expect(r.text).toBe('看到了');
    expect(seen[0][0]).toMatchObject({ role: 'user', content: '帮我看看', images: [IMG] });
    expect(seen[1].at(-1)).toMatchObject({ role: 'tool', content: '截好了', images: [IMG] });
  });
});
