import { describe, it, expect } from 'vitest';
import { chipLabel, isAuto, autoRouting, pickModel, listKey } from '../src/ui/modelPicker.js';
import { routeFor } from '../src/llm/router.js';

const base = { provider: 'custom', models: { custom: 'gpt-6.1-sol' }, keys: { custom: 'k' }, baseURLs: { custom: 'https://teamorouter.com/v1' } };
const ids = ['gpt-6.1-sol', 'gpt-6.1-mini', 'claude-sonnet-5-5', 'deepseek-r2', 'qwen3-coder-plus', 'qwen3-vl-max', 'text-embedding-3-small'];

describe('选模型', () => {
  it('显示名字：内置演示 / 具体型号 / 自动', () => {
    expect(chipLabel({ provider: 'mock', models: {} })).toBe('内置演示');
    expect(chipLabel(base)).toBe('gpt-6.1-sol');
    expect(chipLabel(autoRouting(base, ids))).toBe('自动 · 按任务选模型');
  });

  it('自动：按任务分配不同模型，每句话据此换模型', () => {
    const cfg = autoRouting(base, ids);
    expect(isAuto(cfg)).toBe(true);
    const r = cfg.routing.routes;
    expect(Object.values(r)).not.toContain('text-embedding-3-small');
    expect(new Set(Object.values(r)).size).toBeGreaterThan(1);
    expect(routeFor(cfg, 'vision').model).toBe(r.vision);
    expect(routeFor(cfg, 'code').routed).toBe(true);
  });

  it('选定某个模型：设为默认并关闭自动', () => {
    const cfg = pickModel(autoRouting(base, ids), 'claude-sonnet-5-5');
    expect(cfg.models.custom).toBe('claude-sonnet-5-5');
    expect(isAuto(cfg)).toBe(false);
    expect(routeFor(cfg, 'code').model).toBe('claude-sonnet-5-5');
  });

  it('模型列表按服务商 + 地址缓存', () => {
    expect(listKey(base)).toBe('custom|https://teamorouter.com/v1');
    expect(listKey({ provider: 'openai', baseURLs: {} })).toBe('openai|');
  });
});
