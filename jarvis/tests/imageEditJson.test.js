import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import { editImage } from '../src/llm/imageEdit.js';
import { imageEditFormat } from '../src/llm/imageEditRequest.js';
import { sizedRasterPng } from './fixtures/visualRasterImages.js';

const original = sizedRasterPng(32, 48), output = sizedRasterPng(64, 96, [230, 213, 199]);
const blob = () => new Blob([original], { type: 'image/png' });
const cfg = { provider: 'custom', baseURLs: { custom: 'https://edit.example/v1' }, keys: { custom: 'fixture-key' }, imageModel: 'gpt-image-2.6-sunburst' };
const success = () => new Response(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }));
afterEach(() => vi.restoreAllMocks());

it.each(['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.5-sunburst-2026-09-08', 'openai/gpt-image-2.6-sunburst'])('%s原图走官方JSON images结构，完整字节和用户模型ID保持', async model => {
  const charge = vi.fn();
  const fetchImpl = vi.fn(async (url, init) => {
    expect(charge).toHaveBeenCalledOnce();
    expect(url).toBe('https://edit.example/v1/images/edits');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' });
    const request = JSON.parse(init.body);
    expect(request).toMatchObject({ model, prompt: '自然美颜', n: 1, quality: 'high', output_format: 'png', size: 'auto' });
    expect(request.image).toBeUndefined(); expect(request.images).toHaveLength(1);
    expect(request.images[0].image_url).toBe('data:image/png;base64,' + original.toString('base64'));
    expect(request.editFormat).toBeUndefined();
    return success();
  });
  const result = await editImage({ ...cfg, imageModel: model }, { prompt: '自然美颜', images: [blob()], size: 'auto', quality: 'high', outputFormat: 'png', beforeRequest: charge, fetchImpl });
  expect(Buffer.from(await result.blob.arrayBuffer())).toEqual(output);
  expect(result.actual).toMatchObject({ width: 64, height: 96, format: 'png' });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('显式编辑格式只影响编码，不改服务商、模型或画图参数；旧型号默认multipart', async () => {
  expect(imageEditFormat('gpt-image-2')).toBe('multipart');
  expect(imageEditFormat('gpt-image-1.5')).toBe('multipart');
  for (const [model, format] of [['gpt-image-2', 'json'], ['gpt-image-2.6-sunburst', 'multipart']]) {
    const fetchImpl = vi.fn(async (url, init) => {
      if (format === 'json') expect(JSON.parse(init.body)).toMatchObject({ model, images: [{ image_url: 'data:image/png;base64,' + original.toString('base64') }] });
      else { expect(init.body).toBeInstanceOf(FormData); expect(init.body.get('model')).toBe(model); expect(Buffer.from(await init.body.get('image').arrayBuffer())).toEqual(original); }
      return success();
    });
    await editImage({ ...cfg, imageModel: model, imageOptions: { editFormat: format } }, { prompt: '原片修图', images: [blob()], fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
  }
});

it('JSON按原顺序传多张真实输入，不伪造公网地址或额外上传图床', async () => {
  const second = new Blob([output], { type: 'image/png' });
  const fetchImpl = vi.fn(async (url, init) => {
    expect(JSON.parse(init.body).images).toEqual([original, output].map(data => ({ image_url: 'data:image/png;base64,' + data.toString('base64') })));
    return success();
  });
  await editImage(cfg, { prompt: '只改第一个人', images: [blob(), second], fetchImpl });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('原文件MIME为空或被标为octet-stream，仍按实际PNG字节传正确的data URL', async () => {
  const fetchImpl = vi.fn(async (url, init) => {
    expect(JSON.parse(init.body).images[0].image_url).toBe('data:image/png;base64,' + original.toString('base64'));
    return success();
  });
  await editImage(cfg, { prompt: '修图', images: [new Blob([original], { type: 'application/octet-stream' })], fetchImpl });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each([
  ['jpeg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='],
  ['webp', 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA=']
])('手机%s原片按真实格式送达，不误标为PNG', async (format, base64) => {
  const fetchImpl = vi.fn(async (url, init) => {
    expect(JSON.parse(init.body).images[0].image_url).toBe(`data:image/${format};base64,${base64}`);
    return success();
  });
  await editImage(cfg, { prompt: '原片美化', images: [new Blob([Buffer.from(base64, 'base64')])], fetchImpl });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('失败回执只保留短字段和格式，不回显上游复制的原片或密钥', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad fixture-key data:image/png;base64,privatephoto', param: 'images[0].image_url' } }), { status: 400 }));
  let failure;
  try { await editImage(cfg, { prompt: '修图', images: [blob()], fetchImpl }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ requestFormat: 'json', parameter: 'images[0].image_url' });
  expect(failure.message).not.toMatch(/fixture-key|privatephoto|data:image/);
  expect(failure.message).toContain('字段：images[0].image_url');
});

it('密钥先脱敏再裁剪，长报错不能泄露被截断的半截凭据', async () => {
  const key = 'private-prefix-' + 'a'.repeat(100);
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'x'.repeat(100) + key } }), { status: 400 }));
  await expect(editImage({ ...cfg, keys: { custom: key } }, { prompt: '修图', images: [blob()], fetchImpl })).rejects.not.toThrow('private-prefix');
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('JSON原片不能拿文本/SVG或错误字节冒充PNG，拒绝发生在扣费前', async () => {
  const fetchImpl = vi.fn(), beforeRequest = vi.fn();
  await expect(editImage(cfg, { prompt: '修图', images: [new Blob(['<svg></svg>'], { type: 'image/png' })], beforeRequest, fetchImpl })).rejects.toMatchObject({ code: 'IMAGE_EDIT_INPUT' });
  expect(beforeRequest).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
});

it.each([400, 415, 429, 500])('HTTP%s保留失败和实际格式，不自动换协议、备用或文生图重复计费', async status => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid request', param: 'images' } }), { status }));
  const beforeRequest = vi.fn();
  await expect(editImage(cfg, { prompt: '修图', images: [blob()], beforeRequest, fetchImpl })).rejects.toMatchObject({ status, code: 'IMAGE_API', requestFormat: 'json' });
  expect(beforeRequest).toHaveBeenCalledOnce(); expect(fetchImpl).toHaveBeenCalledOnce();
});

it('无效选项与预算拒绝均在发出请求之前结束，停止编码不发送原片', async () => {
  const fetchImpl = vi.fn(), charge = vi.fn();
  await expect(editImage(cfg, { prompt: '修图', images: [blob()], editFormat: 'guess', beforeRequest: charge, fetchImpl })).rejects.toMatchObject({ code: 'IMAGE_EDIT_FORMAT' });
  expect(charge).not.toHaveBeenCalled();
  const budget = Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' });
  await expect(editImage(cfg, { prompt: '修图', images: [blob()], beforeRequest: () => { throw budget; }, fetchImpl })).rejects.toBe(budget);
  const source = blob(), controller = new AbortController(), bytes = source.arrayBuffer.bind(source);
  source.arrayBuffer = async () => { controller.abort(); return bytes(); };
  await expect(editImage(cfg, { prompt: '修图', images: [source], signal: controller.signal, beforeRequest: charge, fetchImpl })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl).not.toHaveBeenCalled(); expect(charge).not.toHaveBeenCalled();
});

it('真实HTTP的JSON-only编辑端点接收原片，旧multipart会被415拒绝；一次请求保存原返回字节', async () => {
  let calls = 0, actual;
  const server = http.createServer(async (req, res) => {
    calls++;
    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end(); return; }
    const chunks = []; for await (const part of req) chunks.push(part);
    const request = JSON.parse(Buffer.concat(chunks));
    actual = { path: req.url, model: request.model, source: Buffer.from(request.images[0].image_url.split(',')[1], 'base64') };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await editImage({ ...cfg, baseURLs: { custom: `http://127.0.0.1:${server.address().port}/v1` } }, { prompt: '原片显瘦', images: [blob()] });
    expect(calls).toBe(1); expect(actual).toEqual({ path: '/v1/images/edits', model: cfg.imageModel, source: original });
    expect(Buffer.from(await result.blob.arrayBuffer())).toEqual(output);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
