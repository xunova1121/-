import { describe, it, expect } from 'vitest';
import { routeFor, suggestRoutes, keyedProviders, parseRoute, routeLabel } from '../src/llm/router.js';
import { gatherModelRefs, autoRouting, isAuto } from '../src/ui/modelPicker.js';

const base = { provider: 'custom', baseURLs: { custom: 'https://relay.example/v1' }, keys: { custom: 'k1', deepseek: 'k2', qwen: '' }, models: { custom: 'gpt-6.1-sol' } };

describe('跨服务商的模型分工', () => {
  it('“服务商::模型”的写法', () => {
    expect(parseRoute('deepseek::deepseek-chat')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(parseRoute('qwen3:4b')).toEqual({ provider: '', model: 'qwen3:4b' }); // Ollama 的单冒号不是服务商
    expect(routeLabel('deepseek::deepseek-chat', 'custom')).toMatch(/^deepseek-chat（DeepSeek/);
  });
  it('只算填了密钥的服务商（当前服务商总算）', () => {
    expect(keyedProviders(base)).toEqual(['custom', 'deepseek']);
  });
  it('按任务切到别家服务商；那家没密钥时退回默认模型', () => {
    const cfg = { ...base, routing: { enabled: true, provider: 'custom', multi: true, routes: { chat: 'deepseek::deepseek-chat', write: 'gpt-6.1-sol', vision: 'qwen::qwen-vl-max' } } };
    const chat = routeFor(cfg, 'chat');
    expect(chat).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', routed: true });
    expect(chat.cfg.provider).toBe('deepseek');
    expect(chat.cfg.models.deepseek).toBe('deepseek-chat');
    expect(routeFor(cfg, 'write')).toMatchObject({ provider: 'custom', model: 'gpt-6.1-sol' });
    expect(routeFor(cfg, 'vision')).toMatchObject({ provider: 'custom', model: 'gpt-6.1-sol', routed: false }); // 千问没填密钥
    // 换了默认服务商后，跨服务商的分工照样生效
    expect(routeFor({ ...cfg, provider: 'deepseek' }, 'write')).toMatchObject({ provider: 'custom', model: 'gpt-6.1-sol' });
    expect(isAuto({ ...cfg, provider: 'deepseek' })).toBe(true);
  });
  it('从所有服务商的模型里推荐', async () => {
    const lists = { custom: ['gpt-6.1-sol', 'gpt-6.1-mini', 'text-embedding-3'], deepseek: ['deepseek-chat', 'deepseek-reasoner'] };
    const { refs, notes } = await gatherModelRefs(base, { list: async (c) => lists[c.provider] });
    expect(refs).toEqual(['gpt-6.1-sol', 'gpt-6.1-mini', 'deepseek::deepseek-chat', 'deepseek::deepseek-reasoner']);
    expect(notes.join()).toMatch(/DeepSeek/);
    const s = suggestRoutes(refs, 'gpt-6.1-sol');
    expect(s.reason).toBe('deepseek::deepseek-reasoner');
    expect(s.chat).toBe('gpt-6.1-mini');
    const next = autoRouting(base, refs);
    expect(next.routing).toMatchObject({ enabled: true, multi: true, provider: 'custom' });
  });
  it('某家读不到模型列表时用它的默认型号，并说明原因', async () => {
    const { refs, notes } = await gatherModelRefs(base, { list: async (c) => { if (c.provider === 'deepseek') throw new Error('401'); return ['gpt-6.1-sol']; } });
    expect(refs).toContain('gpt-6.1-sol');
    expect(refs.some((r) => r.startsWith('deepseek::'))).toBe(true);
    expect(notes.join()).toMatch(/401/);
  });
});
