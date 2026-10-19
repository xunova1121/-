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

import { generateVideo, videoModelOf, readTask } from '../src/llm/videos.js';
describe('生成视频', () => {
  it('选视频模型不改聊天模型；默认挑 sora', () => {
    expect(pickModel(base, 'sora-2')).toMatchObject({ videoModel: 'sora-2', models: { custom: 'gpt-6.1-sol' } });
    expect(videoModelOf({ ...base, modelLists: { k: { ids: ['kling-v2', 'sora-2', 'gpt-6.1'] } } })).toBe('sora-2');
    expect(videoModelOf(base)).toBe('');
  });
  it('OpenAI 格式：提交 /videos → 轮询 → 下载 /content', async () => {
    const calls = [];
    const states = [{ id: 'v1', status: 'queued' }, { id: 'v1', status: 'in_progress', progress: 40 }, { id: 'v1', status: 'completed' }];
    const fetchImpl = async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url.replace('https://teamorouter.com/v1', '')}`);
      if (url.endsWith('/content')) return new Response('MP4', { headers: { 'content-type': 'video/mp4' } });
      return new Response(JSON.stringify(states.shift()));
    };
    const progress = [];
    const r = await generateVideo({ ...base, videoModel: 'sora-2' }, { prompt: '海浪', seconds: 4, fetchImpl, pollMs: 1, onProgress: (t) => progress.push(t) });
    expect(await r.blob.text()).toBe('MP4');
    expect(r.blob.type).toBe('video/mp4');
    expect(calls).toEqual(['POST /videos', 'GET /videos/v1', 'GET /videos/v1', 'GET /videos/v1/content']);
    expect(progress.some((t) => t.includes('40%'))).toBe(true);
  });
  it('中转站格式：/videos 不存在时改用 /video/generations，成片给的是地址', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url.replace('https://teamorouter.com/v1', '')}`);
      if (url.endsWith('/videos')) return new Response('not found', { status: 404 });
      if (url.endsWith('/video/generations')) return new Response(JSON.stringify({ task_id: 't9', status: 'submitted' }));
      if (url.includes('/video/generations/t9')) return new Response(JSON.stringify({ data: { status: 'SUCCESS', url: 'https://cdn/v.mp4' } }));
      return new Response('MP4');
    };
    const r = await generateVideo({ ...base, videoModel: 'kling-v2' }, { prompt: 'a', fetchImpl, pollMs: 1 });
    expect(await r.blob.text()).toBe('MP4');
    expect(calls).toEqual(['POST /videos', 'POST /video/generations', 'GET /video/generations/t9', 'GET https://cdn/v.mp4']);
  });
  it('失败、没有视频模型时说清楚', async () => {
    await expect(generateVideo(base, { prompt: 'a', fetchImpl: async () => new Response('{}') })).rejects.toThrow('视频模型');
    const failing = async (url) => new Response(JSON.stringify(url.endsWith('/videos') ? { id: 'v', status: 'queued' } : { id: 'v', status: 'failed', error: { message: '内容不合规' } }));
    await expect(generateVideo({ ...base, videoModel: 'sora-2' }, { prompt: 'a', fetchImpl: failing, pollMs: 1 })).rejects.toThrow('内容不合规');
    expect(readTask({ data: { task_status: 'succeed', result: { video_url: 'u' } } })).toMatchObject({ done: true, url: 'u' });
  });
});
