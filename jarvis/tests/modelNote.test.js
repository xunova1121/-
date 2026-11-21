import { describe, it, expect } from 'vitest';
import { modelNote } from '../src/llm/modelLibrary.js';
import { runAgent, INFO_PROMPT } from '../src/agent/agent.js';

const cfg = {
  provider: 'relay-multi',
  models: { 'relay-multi': 'gpt-5.6-luna', deepseek: 'deepseek-chat' },
  providerNames: { 'relay-multi': 'TeamoRouter' },
  keys: { 'relay-multi': 'k', deepseek: 'k' },
  favoriteModels: [{ provider: 'deepseek', model: 'deepseek-chat' }]
};

describe('告诉模型它用的是哪个模型（问“你用的什么大模型”说看不到）', () => {
  it('写明这一轮的服务商和型号，以及模型库里还有哪些', () => {
    const note = modelNote(cfg, { provider: 'relay-multi', model: 'gpt-5.6-luna' });
    expect(note).toContain('TeamoRouter · gpt-5.6-luna');
    expect(note).toMatch(/还配了：DeepSeek[^·]*· deepseek-chat/);
    expect(note).toMatch(/不要拿网上查不到来否认/);
  });
  it('每轮放进系统提示；中途换成备用模型也照实写', async () => {
    const systems = [];
    let n = 0;
    const adapter = { async stream({ system }) { systems.push([].concat(system).join('\n')); if (++n === 1) throw Object.assign(new Error('500'), { status: 500 }); return { text: '好', toolCalls: [], stop: 'end_turn' }; } };
    const backup = { async stream({ system }) { systems.push([].concat(system).join('\n')); return { text: '好', toolCalls: [], stop: 'end_turn' }; } };
    await runAgent({ adapter, model: 'gpt-5.6-luna', fallbacks: [{ adapter: backup, model: 'deepseek-chat', label: 'DeepSeek · deepseek-chat' }], history: [], userText: '你用的什么大模型', context: { dynamic: '' }, tools: [], emit: () => {}, modelNote: modelNote(cfg, { provider: 'relay-multi', model: 'gpt-5.6-luna' }) });
    expect(systems[0]).toContain('TeamoRouter · gpt-5.6-luna');
    expect(systems.at(-1)).toMatch(/实际换成了 deepseek-chat/);
  });
  it('做事要用到用户信息（如出发地）也先查记忆和旧对话，查到的记下来', () => {
    expect(INFO_PROMPT).toMatch(/做事要用到用户的信息（出发地/);
    expect(INFO_PROMPT).toMatch(/category: profile/);
  });
});
