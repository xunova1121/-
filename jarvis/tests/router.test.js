import { describe, it, expect } from 'vitest';
import { classifyTask, suggestRoutes, routeFor } from '../src/llm/router.js';
import { measureFirstToken } from '../src/ui/routingPanel.js';

describe('模型分工', () => {
  it('按内容判断任务类型', () => {
    expect(classifyTask('你好呀，今天天气怎么样')).toBe('chat');
    expect(classifyTask('帮我写一个网页，带动画')).toBe('code');
    expect(classifyTask('这段 python 报错了')).toBe('code');
    expect(classifyTask('帮我写一份季度工作总结')).toBe('write');
    expect(classifyTask('把这段话翻译成英文')).toBe('write');
    expect(classifyTask('对比一下这两个方案的利弊')).toBe('reason');
    expect(classifyTask('看看这个', { images: 1 })).toBe('vision');
  });

  it('按模型名字推荐分工', () => {
    const ids = ['gpt-6.1', 'gpt-6.1-mini', 'gpt-5', 'claude-sonnet-4.5', 'claude-opus-4.1', 'o3', 'gpt-4o', 'text-embedding-3-small', 'qwen2.5-vl-72b', 'gemini-2.5-flash', 'deepseek-r1', 'gpt-5-codex'];
    const r = suggestRoutes(ids, 'gpt-6.1');
    expect(r.chat).toBe('gemini-2.5-flash');
    expect(r.code).toBe('gpt-5-codex');
    expect(r.write).toMatch(/claude-(opus|sonnet)/);
    expect(r.reason).toMatch(/^(o3|deepseek-r1)$/);
    expect(r.vision).toBe('qwen2.5-vl-72b');
    expect(suggestRoutes(['only-model'], 'only-model')).toEqual({ chat: 'only-model', code: 'only-model', write: 'only-model', reason: 'only-model', vision: 'only-model' });
  });

  it('只在开启、且服务商没换时生效', () => {
    const cfg = { provider: 'custom', models: { custom: 'gpt-6.1' }, routing: { enabled: true, provider: 'custom', routes: { chat: 'gpt-6.1-mini', code: '' } } };
    expect(routeFor(cfg, 'chat')).toMatchObject({ model: 'gpt-6.1-mini', routed: true });
    expect(routeFor(cfg, 'chat').cfg.models.custom).toBe('gpt-6.1-mini');
    expect(routeFor(cfg, 'code')).toMatchObject({ model: 'gpt-6.1', routed: false });
    expect(routeFor({ ...cfg, provider: 'openai' }, 'chat').routed).toBe(false);
    expect(routeFor({ ...cfg, routing: { ...cfg.routing, enabled: false } }, 'chat').routed).toBe(false);
  });

  it('测速：从发出到第一个字', async () => {
    let t = 0;
    const adapter = { stream: async ({ onText, signal }) => { t += 1200; onText('好'); if (signal.aborted) throw Object.assign(new Error('a'), { name: 'AbortError' }); } };
    expect(await measureFirstToken(adapter, 'm', { now: () => t })).toBe(1200);
  });
});
