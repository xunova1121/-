/** 纯配置回归：手机选择器不改路由规则，不把自动和显式关闭混为一谈。 */
import { describe, it, expect } from 'vitest';
import { mobileAbilityUpdate } from '../src/ui/mobileAbilityTable.js';

const cfg = {
  provider: 'custom',
  models: { custom: 'shared-model' },
  keys: { custom: 'fake-local-key' },
  abilities: { code: { main: { provider: 'custom', model: 'code-model' }, backup: { provider: 'relay-2', model: 'shared-model' } } },
  pinModel: true,
  unrelated: '保留'
};

describe('手机模型中心配置语义', () => {
  it('同名型号按服务商分别保存，不覆盖默认型号或密钥', () => {
    const next = mobileAbilityUpdate(cfg, 'code', 'main', { provider: 'relay-2', model: 'shared-model' });
    expect(next.abilities.code.main).toEqual({ provider: 'relay-2', model: 'shared-model' });
    expect(next.models).toEqual(cfg.models);
    expect(next.keys).toEqual(cfg.keys);
    expect(next.pinModel).toBe(true);
    expect(cfg.abilities.code.main.model).toBe('code-model');
  });
  it('自动备用删除覆盖，显式不用备用保存 null', () => {
    const auto = mobileAbilityUpdate(cfg, 'code', 'backup', 'auto');
    expect(Object.hasOwn(auto.abilities.code, 'backup')).toBe(false);
    expect(auto.abilities.code.main).toEqual(cfg.abilities.code.main);
    expect(mobileAbilityUpdate(cfg, 'code', 'backup', 'none').abilities.code.backup).toBeNull();
  });
  it('思考和代码恢复跟随，不写一个猜出来的型号', () => {
    const next = mobileAbilityUpdate(cfg, 'code', 'main', 'auto');
    expect(next.abilities.code.main).toBeNull();
    expect(next.abilities.code.backup).toEqual(cfg.abilities.code.backup);
    expect(next.unrelated).toBe('保留');
  });
  it('关键词与向量开关独立，恢复自动或指定型号会重新启用向量', () => {
    const off = mobileAbilityUpdate(cfg, 'embed', 'main', 'off');
    expect(off.embedding.engine).toBe('off');
    expect(mobileAbilityUpdate(off, 'embed', 'main', 'auto').embedding.engine).toBe('auto');
    const chosen = mobileAbilityUpdate(off, 'embed', 'main', { provider: 'zhipu', model: 'embedding-3' });
    expect(chosen.embedding.engine).toBe('auto');
    expect(chosen.abilities.embed.main.model).toBe('embedding-3');
  });
});
