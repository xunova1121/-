import { describe, it, expect, vi } from 'vitest';
import { serverModelPreview, modelPreview } from '../src/core/serverModelPreview.js';
import { createModelScopes } from '../src/llm/modelScopes.js';

const memory = () => { const map = new Map(); return { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), map }; };
const alice = { base: 'https://server.invalid', account: { userId: 'u_' + 'a'.repeat(24), token: 'private-login-token' } };
const bob = { base: alice.base, account: { userId: 'u_' + 'b'.repeat(24), token: 'bob-private-token' } };
const cfg = { provider: 'custom', models: { custom: '原来模型' }, pinModel: true, providerNames: { custom: '我的线路' }, keys: { custom: 'secret-model-key' }, baseURLs: { custom: 'https://user:password@secret.invalid/v1?key=private' }, favoriteModels: [{ provider: 'custom', model: '常用模型' }], openaiSearchKey: 'secret-search-key', abilities: { vision: { main: { provider: 'custom', model: '看图模型' } } } };
const setup = (storage, getClient) => createModelScopes({ getLocal: () => cfg, saveLocal: vi.fn(), getClient, storage });

describe('模型选择预览的持久化边界', () => {
  it('只存有限型号/名字，不保存任何密钥、Token、URL或搜索配置', () => {
    const storage = memory(), cache = serverModelPreview({ storage });
    cache.save(alice, cfg);
    expect(cache.read(alice)).toMatchObject({ models: { custom: '原来模型' }, pinModel: true });
    expect(cache.read(alice).favoriteModels).toEqual([{ provider: 'custom', model: '原来模型' }, ...cfg.favoriteModels]);
    const raw = [...storage.map.values()].join('');
    expect(raw).not.toMatch(/secret|password|private|baseURLs|"keys"|openaiSearch/);
    const bounded = modelPreview({ ...cfg, favoriteModels: Array.from({ length: 1000 }, (_, n) => ({ provider: 'custom', model: 'm' + n })), modelLists: { ignored: { ids: Array(10000).fill('big') } } });
    expect(bounded.favoriteModels).toHaveLength(24); expect(bounded.modelLists).toBeUndefined();
    expect(raw.length).toBeLessThan(32000);
  });

  it('服务器和账号必须同时匹配，只留最近一份，过期/损坏/旧无账号身份时不使用', () => {
    const storage = memory(); let now = 1000;
    const cache = serverModelPreview({ storage, now: () => now });
    cache.save(alice, cfg);
    expect(cache.read(bob)).toBeNull(); expect(cache.read({ ...alice, base: 'https://other.invalid' })).toBeNull();
    now += 24 * 60 * 60_000 + 1; expect(cache.read(alice)).toBeNull();
    now = 1000; cache.save(bob, cfg); expect(cache.read(alice)).toBeNull(); expect(storage.map.size).toBe(1);
    const legacy = { base: alice.base, account: { token: 'legacy' } };
    cache.save(legacy, cfg); expect(cache.read(legacy)).toBeNull();
    storage.setItem('jarvis.server.model-preview.v1', '{broken'); expect(cache.read(bob)).toBeNull();
    storage.setItem('jarvis.server.model-preview.v1', 'x'.repeat(32001)); expect(cache.read(bob)).toBeNull();
  });

  it('被拒绝的存储不影响正常读取和保存', () => {
    const cache = serverModelPreview({ storage: { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } } });
    expect(cache.read(alice)).toBeNull(); expect(() => cache.save(alice, cfg)).not.toThrow();
  });

  it('主人账号也可预览，评测身份不继承主人的预览', () => {
    const cache = serverModelPreview({ storage: memory() });
    const owner = { ...alice, account: { userId: 'owner', role: 'owner' } };
    cache.save(owner, cfg); expect(cache.read(owner).models.custom).toBe('原来模型');
    expect(cache.read({ ...owner, account: { userId: 'owner', role: 'evaluation' } })).toBeNull();
  });
});

describe('配置的预览、并发读取和账号竞态', () => {
  it('重建后可立即预览；完整配置仍只在内存，实际切换必须重新读取并确认', async () => {
    const storage = memory();
    const client = { ...alice, getConfig: vi.fn(async () => structuredClone(cfg)), putConfig: vi.fn() };
    await setup(storage, () => client).refresh('server');
    const scopes = setup(storage, () => client);
    expect(scopes.get('server')).toBeNull(); expect(scopes.preview('server').models.custom).toBe('原来模型');
    const offline = Object.assign(new Error('离线'), { kind: 'network' });
    client.getConfig.mockRejectedValueOnce(offline);
    await expect(scopes.patch('server', old => ({ ...old, pinModel: false }))).rejects.toBe(offline);
    expect(client.putConfig).not.toHaveBeenCalled(); expect(scopes.preview('server').pinModel).toBe(true);
  });

  it('同时打开/刷新只发一份读取；失败后允许再次刷新', async () => {
    let resolve;
    const client = { ...alice, getConfig: vi.fn(() => new Promise(r => { resolve = r; })) };
    const scopes = setup(memory(), () => client);
    const first = scopes.refresh('server'), second = scopes.refresh('server');
    await Promise.resolve(); await Promise.resolve();
    expect(client.getConfig).toHaveBeenCalledOnce(); resolve(cfg);
    expect(await first).toEqual(cfg); expect(await second).toEqual(cfg);
    client.getConfig.mockRejectedValueOnce(new Error('offline'));
    await expect(scopes.refresh('server')).rejects.toThrow('offline');
    client.getConfig.mockResolvedValue(cfg); await scopes.refresh('server'); expect(client.getConfig).toHaveBeenCalledTimes(3);
  });

  it('旧账号的迟到读取不覆盖新账号、不落盘；退出后也不显示旧内存配置', async () => {
    let resolve, current = { ...alice, getConfig: () => new Promise(r => { resolve = r; }) };
    const storage = memory(), scopes = setup(storage, () => current);
    const old = scopes.refresh('server').catch(e => e);
    await Promise.resolve(); await Promise.resolve();
    current = { ...bob, getConfig: async () => ({ ...cfg, models: { custom: '乙账号模型' } }) };
    await scopes.refresh('server'); resolve(cfg);
    expect(await old).toMatchObject({ code: 'SERVER_SCOPE_CHANGED' });
    expect(scopes.get('server').models.custom).toBe('乙账号模型'); expect(scopes.preview('server').models.custom).toBe('乙账号模型');
    current = null; expect(scopes.get('server')).toBeNull(); expect(scopes.preview('server')).toBeNull();
  });

  it('读配置途中切账号，原账号的更新和排队更新都不能写给新账号', async () => {
    let resolve;
    const oldClient = { ...alice, getConfig: vi.fn(() => new Promise(r => { resolve = r; })), putConfig: vi.fn() };
    const newClient = { ...bob, getConfig: vi.fn(async () => cfg), putConfig: vi.fn() };
    let current = oldClient;
    const scopes = setup(memory(), () => current);
    const first = scopes.patch('server', c => ({ ...c, pinModel: false })).catch(e => e);
    const queued = scopes.patch('server', c => ({ ...c, pinModel: false })).catch(e => e);
    await Promise.resolve(); await Promise.resolve(); current = newClient; resolve(cfg);
    expect(await first).toMatchObject({ code: 'SERVER_SCOPE_CHANGED' }); expect(await queued).toMatchObject({ code: 'SERVER_SCOPE_CHANGED' });
    expect(oldClient.putConfig).not.toHaveBeenCalled(); expect(newClient.putConfig).not.toHaveBeenCalled();
  });
});
