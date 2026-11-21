import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, maskConfig, mergeConfig, tokenFor } from '../server/serverMode.mjs';
import { memberModelConfig, memberRoute } from '../server/userRoutes.mjs';
import { useBackend } from '../src/agent/store.js';
import { createModelScopes } from '../src/llm/modelScopes.js';
import { copyModelSettings } from '../src/llm/modelLibrary.js';

const cfg = {
  provider: 'mock', keys: { openai: 'fixture-chat-key' }, models: {},
  openaiSearchEnabled: true, openaiSearchKey: 'fixture-search-key-1234',
  openaiSearchBaseURL: 'https://search.example.com/v1', openaiSearchModel: 'fixture-search-model',
  openaiSearchProtocol: 'responses', deepseekSearchKey: 'fixture-deepseek', tavilyKey: 'fixture-tavily'
};

describe('独立搜索配置的保存与身份边界', () => {
  it('默认掩码、空值及掩码保留旧Key，关搜索不改其他服务商', () => {
    const masked = maskConfig(cfg);
    expect(masked.openaiSearchKey).toBe('••••1234');
    expect(JSON.stringify(masked)).not.toContain(cfg.openaiSearchKey);
    for (const openaiSearchKey of ['', '  ', masked.openaiSearchKey]) {
      expect(mergeConfig(cfg, { openaiSearchKey, openaiSearchEnabled: false })).toMatchObject({
        ...cfg, openaiSearchEnabled: false
      });
    }
    expect(mergeConfig(cfg, { openaiSearchKey: ' fixture-replacement-5678 ' }).openaiSearchKey).toBe('fixture-replacement-5678');
    expect(copyModelSettings(cfg)).not.toHaveProperty('openaiSearchKey');
  });

  it('只改单项沿用当前协议，不让模型Key或旧快照覆盖独立搜索Key', () => {
    const chat = { ...cfg, openaiSearchProtocol: 'chat-completions', openaiSearchBaseURL: 'https://search.example.com/v1/chat/completions' };
    expect(mergeConfig(chat, { openaiSearchModel: 'new-search' })).toMatchObject({ ...chat, openaiSearchModel: 'new-search' });
    expect(mergeConfig(cfg, { models: { openai: 'new-chat' }, keys: { openai: 'new-chat-key' } }).openaiSearchKey).toBe(cfg.openaiSearchKey);
  });

  it.each([
    { openaiSearchEnabled: 'true' }, { openaiSearchKey: { value: 'bad' } },
    { openaiSearchProtocol: 'unknown' }, { openaiSearchBaseURL: 'https://user:password@search.example.com/v1' },
    { openaiSearchBaseURL: 'https://127.0.0.1/v1' }, { openaiSearchBaseURL: 'https://search.example.com/v1?key=secret' },
    { openaiSearchModel: 'bad\nmodel' }
  ])('拒绝无效配置，不将未校验字段落盘：%j', patch => {
    expect(() => mergeConfig(cfg, patch)).toThrow();
  });

  it('普通成员拿不到搜索地址或密钥，也不能触发管理员收费测试', () => {
    const member = memberModelConfig(cfg);
    expect(member).not.toHaveProperty('openaiSearchKey');
    expect(member).not.toHaveProperty('openaiSearchBaseURL');
    expect(memberRoute('POST', '/api/server/search-test')).toBe(false);
  });

  it('云端搜索Key读回不一致不能提示保存成功；本机设置不被复制', async () => {
    let stored = maskConfig(cfg);
    const local = { ...cfg, openaiSearchKey: 'fixture-local-key' };
    const client = { getConfig: vi.fn(async () => stored), putConfig: vi.fn(async () => {}) };
    const saved = vi.fn();
    const scopes = createModelScopes({ getLocal: () => local, saveLocal: saved, getClient: () => client });
    await expect(scopes.patch('server', before => ({ ...before, openaiSearchKey: 'fixture-new-5678' }))).rejects.toMatchObject({ code: 'MODEL_KEY_SAVE' });
    expect(saved).not.toHaveBeenCalled();
    client.putConfig.mockImplementation(async delta => { stored = { ...stored, ...delta, openaiSearchKey: '••••5678' }; });
    await expect(scopes.patch('server', before => ({ ...before, openaiSearchKey: 'fixture-new-5678' }))).resolves.toHaveProperty('openaiSearchKey', '••••5678');
    expect(scopes.get('local').openaiSearchKey).toBe('fixture-local-key');
  });

  it('真实HTTP保存后测试使用服务器落盘Key，错误不混淆未央登录且不回显密钥', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-search-config-'));
    let upstreamStatus = 200;
    const searchFetch = vi.fn(async (url, init) => {
      expect(url).toBe('https://search.example.com/v1/responses');
      expect(init.headers.Authorization).toBe('Bearer ' + cfg.openaiSearchKey);
      expect(JSON.parse(init.body)).toMatchObject({ model: cfg.openaiSearchModel, max_tool_calls: 1 });
      return new Response(JSON.stringify(upstreamStatus === 200 ? {
        output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://www.gov.cn/fixture', title: '合成资料' }] } }]
      } : { error: { message: cfg.openaiSearchKey + ' private upstream text' } }), { status: upstreamStatus });
    });
    const mode = createServerMode({ dataDir: dir, password: 'fixture-password', searchFetch });
    await mode.ready;
    const server = createServer({ serverMode: mode, ollama: null });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: 'Bearer ' + tokenFor('fixture-password'), 'Content-Type': 'application/json' };
    try {
      const save = await fetch(base + '/api/server/config', { method: 'PUT', headers, body: JSON.stringify(cfg) });
      expect(save.status).toBe(200);
      await save.arrayBuffer();
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).openaiSearchKey).toBe(cfg.openaiSearchKey);
      const read = await (await fetch(base + '/api/server/config', { headers })).json();
      expect(read.openaiSearchKey).toBe('••••1234');
      const probe = () => fetch(base + '/api/server/search-test', { method: 'POST', headers, body: JSON.stringify({ kind: 'openai' }) });
      const good = await probe();
      expect(good.status).toBe(200);
      expect(await good.json()).toMatchObject({ count: 1, requests: 1 });
      upstreamStatus = 401;
      const bad = await probe();
      expect(bad.status).toBe(502);
      const error = await bad.json();
      expect(error.upstreamStatus).toBe(401);
      expect(JSON.stringify(error)).not.toContain(cfg.openaiSearchKey);
      expect(JSON.stringify(error)).not.toContain('private upstream text');
      expect(searchFetch).toHaveBeenCalledTimes(2);
    } finally {
      await mode.runner.settled(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      useBackend(null); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
