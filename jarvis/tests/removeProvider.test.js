import { describe, it, expect } from 'vitest';
import { removeProvider, configuredProviders } from '../src/llm/modelLibrary.js';
import { mergeConfig } from '../server/serverMode.mjs';

const cfg = {
  provider: 'deepseek',
  models: { deepseek: 'deepseek-chat', custom: 'gpt-5.5-pro' },
  keys: { deepseek: 'sk-ds', custom: 'sk-quick' },
  baseURLs: { custom: 'https://api.quickrouter.ai/v1' },
  providerNames: { custom: 'QuickRouter' },
  serviceTiers: { custom: 'fast' },
  modelLists: { 'custom|https://api.quickrouter.ai/v1': { ids: ['gpt-5.5-pro'] }, 'deepseek|': { ids: ['deepseek-chat'] } },
  favoriteModels: [{ provider: 'custom', model: 'gpt-5.5-pro' }, { provider: 'deepseek', model: 'deepseek-chat' }],
  fallbackModels: [{ provider: 'custom', model: 'gpt-5.5-pro' }],
  abilities: { code: { main: { provider: 'custom', model: 'gpt-5.5-pro' }, backup: { provider: 'deepseek', model: 'deepseek-chat' } } },
  documentReviewer: { provider: 'custom', model: 'gpt-5.5-pro' }
};

describe('删除服务商', () => {
  it('Key、地址、名字、型号列表，以及常用、备用、能力表、审查里用到它的一起删', () => {
    const next = removeProvider(cfg, 'custom');
    expect(configuredProviders(next).map((p) => p.id)).toEqual(['deepseek']);
    expect(next.keys).toEqual({ deepseek: 'sk-ds' });
    expect(Object.keys(next.modelLists)).toEqual(['deepseek|']);
    expect(next.favoriteModels).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }]);
    expect(next.fallbackModels).toEqual([]);
    expect(next.abilities.code).toEqual({ backup: { provider: 'deepseek', model: 'deepseek-chat' } });
    expect(next.documentReviewer).toBeNull();
  });
  it('正在用的默认服务商不能删', () => {
    expect(() => removeProvider(cfg, 'deepseek')).toThrow(/默认服务商/);
  });
  it('服务器合并配置时也真的删掉（字典合并不会自己少），并去掉标记', () => {
    const merged = mergeConfig(cfg, { ...removeProvider(cfg, 'custom'), keys: { deepseek: '••••s-ds' } });
    expect(merged.keys).toEqual({ deepseek: 'sk-ds' });
    expect(merged.baseURLs.custom).toBeUndefined();
    expect(merged.providerNames.custom).toBeUndefined();
    expect(merged.removedProviders).toBeUndefined();
  });
  it('删了又加回来：带着旧标记也不再删', () => {
    const gone = mergeConfig(cfg, removeProvider(cfg, 'custom'));
    const back = mergeConfig(gone, { removedProviders: ['custom'], providerNames: { custom: 'QuickRouter' }, keys: { custom: 'sk-new' } });
    expect(back.keys.custom).toBe('sk-new');
  });
});
