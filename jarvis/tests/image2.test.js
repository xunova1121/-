import { it, expect, vi } from 'vitest';
import { generateImage } from '../src/llm/images.js';
import { editImage } from '../src/llm/imageEdit.js';
import { imageRequestOptions } from '../src/llm/imageOptions.js';
import { requestImage } from '../src/llm/imageResponse.js';
const cfg = { provider: 'custom', baseURLs: { custom: 'https://image.example/v1' }, keys: { custom: 'fixture' }, imageModel: 'gpt-image-2' };
const encoded = (bytes) => btoa(String.fromCharCode(...bytes));

it('Image2生成支持自定义尺寸画质格式，不注入旧response_format或fidelity', async () => {
  const beforeRequest = vi.fn();
  const fetchImpl = vi.fn(async (url, options) => {
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(options.body)).toEqual({
      model: 'gpt-image-2',
      prompt: '产品海报',
      size: '1536x864',
      n: 1,
      quality: 'high',
      output_format: 'jpeg',
      background: 'opaque'
    });
    return new Response(JSON.stringify({ data: [{ b64_json: encoded([255, 216, 255, 224]) }], output_format: 'jpeg' }));
  });
  const result = await generateImage(cfg, {
    prompt: '产品海报',
    size: '1536x864',
    quality: 'high',
    outputFormat: 'jpeg',
    background: 'opaque',
    fetchImpl,
    beforeRequest
  });
  expect(result.blob.type).toBe('image/jpeg');
  expect(result.model).toBe('gpt-image-2');
});

it('Image2原图编辑保留multipart与可选参数，仅提交一次', async () => {
  const fetchImpl = vi.fn(async (url, options) => {
    expect(url.endsWith('/images/edits')).toBe(true);
    expect(options.body.get('model')).toBe('gpt-image-2');
    expect(options.body.get('size')).toBe('auto');
    expect(options.body.get('quality')).toBe('medium');
    expect(options.body.get('input_fidelity')).toBeNull();
    expect(await options.body.get('image').text()).toBe('original');
    return new Response(JSON.stringify({ data: [{ b64_json: encoded([255, 216, 255, 224]) }], output_format: 'jpeg' }));
  });
  const result = await editImage(
    { ...cfg, imageOptions: { quality: 'medium', outputFormat: 'jpeg' } },
    { prompt: '只改背景', size: 'auto', images: [new Blob(['original'], { type: 'image/png' })], fetchImpl }
  );
  expect(result.blob.type).toBe('image/jpeg');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('不支持参数和非法尺寸在请求前拦截，未配置新参数保持原协议', async () => {
  for (const options of [{ size: '123x456' }, { size: '4000x4000' }, { background: 'transparent', outputFormat: 'jpeg' }, { quality: 'max' }]) {
    const fetchImpl = vi.fn();
    await expect(generateImage(cfg, { prompt: 'test', fetchImpl, ...options })).rejects.toMatchObject({ code: 'IMAGE_OPTIONS' });
    expect(fetchImpl).not.toHaveBeenCalled();
  }
  expect(imageRequestOptions('gpt-image-2', {})).toEqual({ size: '1024x1024' });
  expect(() => imageRequestOptions('cogview-4', { quality: 'high' })).toThrow();
});

it('预算/停止先于请求；5xx、超时、下载失败不换备用重复生成', async () => {
  const withBackup = {
    ...cfg,
    keys: { custom: 'fixture', zhipu: 'fixture' },
    abilities: { image: { main: { provider: 'custom', model: 'gpt-image-2' }, backup: { provider: 'zhipu', model: 'cogview-4' } } }
  };
  for (const fetchImpl of [
    vi.fn(async () => new Response('{}', { status: 500 })),
    vi.fn(async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    })
  ]) {
    await expect(generateImage(withBackup, { prompt: 'test', fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/result.png' }] })));
  await expect(
    generateImage(withBackup, {
      prompt: 'test',
      fetchImpl,
      download: async () => {
        throw new Error('download');
      }
    })
  ).rejects.toThrow('download');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const budget = Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' });
  fetchImpl.mockClear();
  await expect(
    generateImage(cfg, {
      prompt: 'test',
      fetchImpl,
      beforeRequest: () => {
        throw budget;
      }
    })
  ).rejects.toBe(budget);
  expect(fetchImpl).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(generateImage(cfg, { prompt: 'test', signal: controller.signal, fetchImpl })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('结果下载不带凭据，SVG或HTML不能冒充生成图片', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/result.png' }] })));
  const download = vi.fn(async (url, init) => {
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBe('omit');
    return new Response('html', { headers: { 'content-type': 'text/html' } });
  });
  await expect(generateImage(cfg, { prompt: 'test', fetchImpl, download })).rejects.toMatchObject({ code: 'IMAGE_RESPONSE_FORMAT' });
  const svgResponse = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: btoa('<svg width="1" height="1"></svg>') }] })));
  await expect(generateImage(cfg, { prompt: 'test', fetchImpl: svgResponse })).rejects.toMatchObject({ code: 'IMAGE_RESPONSE_FORMAT' });
});

it('忽略signal的上游也能结束超时等待，不触发第二次收费请求', async () => {
  const fetchImpl = vi.fn(async () => new Promise(() => {}));
  await expect(
    requestImage('https://image.example/v1/images/generations', {}, { fetchImpl, download: fetchImpl, model: 'gpt-image-2', timeoutMs: 10 })
  ).rejects.toMatchObject({ name: 'TimeoutError', code: 'IMAGE_TIMEOUT' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('单文件版没有网关时下载器为null仍能获取真实结果，不带模型凭据', async () => {
  const fetchImpl = vi.fn(async (url, init) => {
    if (url.endsWith('/images/generations')) return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.jpg' }] }));
    expect(init.headers).toBeUndefined();
    return new Response(new Uint8Array([255, 216, 255, 224]), { headers: { 'content-type': 'image/jpeg' } });
  });
  const result = await generateImage(cfg, { prompt: 'test', fetchImpl, download: null });
  expect(result.blob.type).toBe('image/jpeg');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
