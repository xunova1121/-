import { describe, it, expect } from 'vitest';
import { toPlainText, toSpeech } from '../src/core/markdown.js';
import { isSmallTalk } from '../src/llm/router.js';
import { runAgent, STABLE_PROMPT, LIGHT_PROMPT, VOICE_NOTE } from '../src/agent/agent.js';

describe('复制、朗读用的文字', () => {
  const md = '# 结论\n**营收**增长 18%，见[报告](https://a.cn/r)\n- 华东\n- 华南\n\n| 区域 | 营收 |\n|--|--|\n| 华东 | 820 |\n\n```js\nx = 1\n```';
  it('复制：去掉格式符号，列表留“- ”，表格用制表符，链接带网址', () => {
    const t = toPlainText(md);
    expect(t).not.toMatch(/\*\*|^#/m);
    expect(t).toContain('营收增长 18%，见报告（https://a.cn/r）');
    expect(t).toContain('- 华东\n- 华南');
    expect(t).toContain('区域\t营收');
    expect(t).toContain('x = 1');
  });
  it('朗读：只念正文和列表，代码、表格、网址不念', () => {
    const t = toSpeech(md);
    expect(t).toContain('营收增长 18%，见报告');
    expect(t).not.toMatch(/https?:|x = 1|820|\*/);
  });
});

describe('寒暄走轻量模式', () => {
  it('你好、谢谢、晚安算寒暄；带了要做的事不算', () => {
    expect(['你好', '你好呀！', '谢谢', '晚安~', '在吗'].every(isSmallTalk)).toBe(true);
    expect(['你好，帮我查下天气', '写个周报', '谢谢，再改一下第二段'].some(isSmallTalk)).toBe(false);
  });
  it('轻量模式：短提示、不带工具；语音对话加上“口语短答”', async () => {
    const seen = [];
    const adapter = { async stream(req) { seen.push(req); req.onText('你好呀'); return { text: '你好呀', toolCalls: [], stop: 'end_turn' }; } };
    const tool = { name: 'tick', description: 't', input_schema: { type: 'object', properties: {} }, run: async () => 'ok' };
    await runAgent({ adapter, model: 'x', history: [], userText: '你好', tools: [tool], emit: () => {}, light: true, voice: true });
    expect(seen[0].system[0]).toBe(LIGHT_PROMPT);
    expect(seen[0].system[0].length).toBeLessThan(STABLE_PROMPT.length / 5);
    expect(seen[0].tools).toEqual([]);
    expect(seen[0].system[1]).toContain(VOICE_NOTE);
    await runAgent({ adapter, model: 'x', history: [], userText: '写个周报', tools: [tool], emit: () => {} });
    expect(seen.at(-1).system[0]).toBe(STABLE_PROMPT);
    expect(seen.at(-1).tools.some((t) => t.name === 'tick')).toBe(true);
    expect(seen.at(-1).system[1]).not.toContain(VOICE_NOTE);
  });
});
