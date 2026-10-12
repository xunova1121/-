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

import { modelKind, generateImage, imageModelOf } from '../src/llm/images.js';
import { repairChatModel } from '../src/ui/modelPicker.js';
describe('画图模型', () => {
  it('按名字区分用途', () => {
    expect(['gpt-image-2', 'dall-e-3', 'flux-1.1-pro', 'seedream-4', 'midjourney'].map(modelKind)).toEqual(['image', 'image', 'image', 'image', 'image']);
    expect(['gpt-6.1-sol', 'claude-opus-5-5', 'qwen3-vl-max', 'deepseek-r2'].map(modelKind)).toEqual(['chat', 'chat', 'chat', 'chat']);
    expect(modelKind('text-embedding-3-small')).toBe('embed');
    expect(modelKind('gpt-4o-mini-tts')).toBe('audio');
    expect(modelKind('sora-2')).toBe('video');
  });
  it('选画图模型不会改聊天模型；误选的自动修正', () => {
    expect(pickModel(base, 'gpt-image-2')).toMatchObject({ imageModel: 'gpt-image-2', models: { custom: 'gpt-6.1-sol' } });
    const broken = { ...base, models: { custom: 'gpt-image-2' }, modelLists: { k: { ids, at: 1 } } };
    const fixed = repairChatModel(broken);
    expect(fixed.imageModel).toBe('gpt-image-2');
    expect(modelKind(fixed.models.custom)).toBe('chat');
    expect(repairChatModel(base)).toBeNull();
  });
  it('调用 /images/generations：b64 或 url 都能拿到图片', async () => {
    let sent;
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/images/generations')) { sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }; return new Response(JSON.stringify({ data: [{ b64_json: btoa('PNGDATA') }] })); }
      return new Response('x');
    };
    const r = await generateImage({ ...base, imageModel: 'gpt-image-2' }, { prompt: '天空', fetchImpl });
    expect(sent).toEqual({ url: 'https://teamorouter.com/v1/images/generations', body: { model: 'gpt-image-2', prompt: '天空', size: '1024x1024', n: 1 }, auth: 'Bearer k' });
    expect(await r.blob.text()).toBe('PNGDATA');
    const viaUrl = async (url) => (url.endsWith('/images/generations') ? new Response(JSON.stringify({ data: [{ url: 'https://cdn/x.png' }] })) : new Response('IMG', { headers: { 'content-type': 'image/png' } }));
    expect(await (await generateImage(base, { prompt: 'a', fetchImpl: viaUrl })).blob.text()).toBe('IMG');
    const fail = async () => new Response(JSON.stringify({ error: { message: 'no quota' } }), { status: 403 });
    await expect(generateImage(base, { prompt: 'a', fetchImpl: fail })).rejects.toThrow('no quota');
    expect(imageModelOf({ ...base, modelLists: { k: { ids: ['gpt-6.1', 'dall-e-3', 'gpt-image-2'] } } })).toBe('gpt-image-2');
  });
});
