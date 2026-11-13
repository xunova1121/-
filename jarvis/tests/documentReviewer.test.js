import { describe, it, expect, vi } from 'vitest';
import { createDocumentReviewer } from '../src/llm/documentReviewer.js';
import { copyModelSettings } from '../src/llm/modelLibrary.js';
import { createModelScopes } from '../src/llm/modelScopes.js';
import { mergeConfig } from '../server/serverMode.mjs';

const cfg = {
  provider: 'custom', models: { custom: 'writer', 'relay-2': 'reviewer' },
  keys: { custom: 'one', 'relay-2': 'two' },
  baseURLs: { custom: 'https://one.invalid/v1', 'relay-2': 'https://two.invalid/v1' },
  routing: { enabled: true, provider: 'custom', routes: { write: 'custom::writer' } }
};

describe('文档审查分工', () => {
  it('旧配置与显式关闭不构造审查模型', () => {
    const make = vi.fn();
    expect(createDocumentReviewer(cfg, make)).toBeNull();
    expect(createDocumentReviewer({ ...cfg, documentReviewer: null }, make)).toBeNull();
    expect(make).not.toHaveBeenCalled();
  });

  it('两家同名型号仍按服务商分别取地址与密钥，不改变聊天或写作分工', async () => {
    const original = structuredClone(cfg);
    const helper = vi.fn(async () => '审查意见');
    const make = vi.fn(() => helper);
    const reviewer = createDocumentReviewer({ ...cfg, documentReviewer: { provider: 'relay-2', model: 'writer' } }, make);
    expect(make.mock.calls[0][0]).toMatchObject({ provider: 'relay-2', models: { 'relay-2': 'writer' }, keys: { 'relay-2': 'two' }, baseURLs: { 'relay-2': 'https://two.invalid/v1' } });
    const controller = new AbortController();
    const request = { prompt: '核对', signal: controller.signal, maxWebSearches: 0 };
    expect(await reviewer(request)).toBe('审查意见');
    expect(helper).toHaveBeenCalledWith(request);
    expect(cfg).toEqual(original);
  });

  it('缺密钥或型号无效时延迟明确报错，不冒充独立审查或阻断工具组装', () => {
    for (const line of [{ provider: 'deepseek', model: 'r' }, { provider: 'unknown', model: 'r' }, { provider: 'custom', model: '' }]) {
      const make = vi.fn();
      const reviewer = createDocumentReviewer({ ...cfg, documentReviewer: line }, make);
      expect(reviewer).toBeTypeOf('function');
      expect(reviewer).toThrow(expect.objectContaining({ code: 'DOCUMENT_REVIEWER_UNAVAILABLE', kind: 'api' }));
      expect(make).not.toHaveBeenCalled();
    }
    expect(createDocumentReviewer({ ...cfg, documentReviewer: { provider: 'custom', model: 'r' } }, () => null)).toThrow('文档审查模型不可用');
  });

  it('停止和预算错误透传，不重试或偷偷改用写作模型', async () => {
    for (const error of [Object.assign(new Error('stop'), { name: 'AbortError' }), Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' })]) {
      const helper = vi.fn(async () => { throw error; });
      const reviewer = createDocumentReviewer({ ...cfg, documentReviewer: { provider: 'custom', model: 'r' } }, () => helper);
      await expect(reviewer({})).rejects.toBe(error);
      expect(helper).toHaveBeenCalledTimes(1);
    }
  });

  it('服务器修改和清空审查分工不写本机，不重复上传未变凭据', async () => {
    let local = structuredClone(cfg);
    let remote = structuredClone(cfg);
    const patches = [];
    const scopes = createModelScopes({ getLocal: () => local, saveLocal: value => { local = value; }, getClient: () => ({ getConfig: async () => structuredClone(remote), putConfig: async delta => { patches.push(delta); remote = mergeConfig(remote, delta); } }) });
    const line = { provider: 'relay-2', model: 'reviewer' };
    await scopes.patch('server', value => ({ ...value, documentReviewer: line }));
    expect(remote.documentReviewer).toEqual(line);
    expect(local.documentReviewer).toBeUndefined();
    expect(patches).toEqual([{ documentReviewer: line }]);
    expect(copyModelSettings(remote).documentReviewer).toEqual(line);
    await scopes.patch('server', value => ({ ...value, documentReviewer: null }));
    expect(remote.documentReviewer).toBeNull();
    expect(remote.routing).toEqual(cfg.routing);
  });
});
