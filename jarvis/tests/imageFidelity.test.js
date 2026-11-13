import { afterEach, expect, it, vi } from 'vitest';
import { generateImage } from '../src/llm/images.js';
import { editImage } from '../src/llm/imageEdit.js';
import { imageCoverReceipt, imageRequestReceipt, imageSizeMatch, readImageMetadata } from '../src/agent/imageMetadata.js';
import { deliverGeneratedImage } from '../src/agent/imageDelivery.js';
import * as ws from '../src/agent/workspace.js';

// 有效的1×1容器夹具；仅用于协议和字节检查，不冒充模型画质测试。
const encoded = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  webp: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA=',
  lossless: 'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA='
};
const bytes = kind => Buffer.from(encoded[kind], 'base64');
const blob = (kind = 'png', mime = 'application/octet-stream') => new Blob([bytes(kind)], { type: mime });
const cfg = { provider: 'custom', baseURLs: { custom: 'https://image.example/v1' }, keys: { custom: 'fixture-secret' }, imageModel: 'gpt-image-2' };
const response = kind => new Response(JSON.stringify({ data: [{ b64_json: encoded[kind] }], output_format: 'png' }));

afterEach(() => vi.restoreAllMocks());

it.each(['png', 'jpeg', 'webp'])('实际%s宽高格式来自字节，不信MIME或扩展名', async kind => {
  const result = await readImageMetadata(blob(kind, 'image/svg+xml'));
  expect(result).toEqual({ width: 1, height: 1, format: kind, mime: `image/${kind}`, bytes: bytes(kind).length, dimensions: 'verified', verification: 'container_metadata' });
});

it('WebP无损和扩展容器尺寸均按真实帧读取，冲突不能冒称已核实', async () => {
  expect(await readImageMetadata(blob('lossless'))).toMatchObject({ width: 1, height: 1, format: 'webp', dimensions: 'verified' });
  const extension = Buffer.alloc(18);
  extension.write('VP8X'); extension.writeUInt32LE(10, 4);
  const extended = Buffer.concat([bytes('webp').subarray(0, 12), extension, bytes('webp').subarray(12)]);
  extended.writeUInt32LE(extended.length - 8, 4);
  expect(await readImageMetadata(new Blob([extended]))).toMatchObject({ width: 1, height: 1, dimensions: 'verified' });
  extended[24] = 1;
  expect(await readImageMetadata(new Blob([extended]))).toMatchObject({ width: null, height: null, dimensions: 'unknown' });
});

it('截断、非法容器段长和零尺寸保持unknown，不用请求大小补值', async () => {
  const brokenPng = bytes('png'); brokenPng.writeUInt32BE(0, 16);
  const brokenJpeg = bytes('jpeg'); brokenJpeg.writeUInt16BE(65535, 4);
  const brokenWebp = bytes('webp'); brokenWebp.writeUInt32LE(0x7fffffff, 16);
  for (const input of [bytes('png').subarray(0, 30), bytes('jpeg').subarray(0, 50), bytes('webp').subarray(0, 25), brokenPng, brokenJpeg, brokenWebp, Buffer.from([255, 216, 255, 224]), Buffer.from('not an image')]) {
    const actual = await readImageMetadata(new Blob([input], { type: 'image/png' }));
    expect(actual).toMatchObject({ width: null, height: null, dimensions: 'unknown' });
    expect(imageSizeMatch({ size: '3840x2160' }, actual)).toBeNull();
  }
  expect(await readImageMetadata(new Blob(['unknown'], { type: 'image/png' }))).toMatchObject({ format: 'unknown', mime: null });
});

it('请求4K高画质却收到小图时回报不匹配，保留原字节且不调用备用模型', async () => {
  const fetchImpl = vi.fn(async () => response('png'));
  const config = { ...cfg, abilities: { image: { main: { provider: 'custom', model: 'gpt-image-2' }, backup: { provider: 'zhipu', model: 'cogview-4' } } } };
  const result = await generateImage(config, { prompt: 'private prompt', size: '3840x2160', quality: 'high', outputFormat: 'png', fetchImpl });
  expect(result.requested).toEqual({ model: 'gpt-image-2', size: '3840x2160', quality: 'high', output_format: 'png', background: null });
  expect(result.actual).toMatchObject({ width: 1, height: 1, format: 'png', bytes: bytes('png').length, dimensions: 'verified' });
  expect(result.sizeMatch).toBe(false);
  expect(result.formatMatch).toBe(true);
  expect(Buffer.from(await result.blob.arrayBuffer())).toEqual(bytes('png'));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(JSON.stringify({ requested: result.requested, actual: result.actual })).not.toMatch(/fixture-secret|private prompt|https/);
});

it('编辑auto仍返回实际像素，未指定画质不编造high或尺寸一致', async () => {
  const fetchImpl = vi.fn(async () => response('jpeg'));
  const result = await editImage(cfg, { prompt: '保留主体', images: [blob()], size: 'auto', fetchImpl });
  expect(result.requested).toMatchObject({ size: 'auto', quality: null });
  expect(result.actual).toMatchObject({ width: 1, height: 1, format: 'jpeg' });
  expect(result.blob.type).toBe('image/jpeg');
  expect(result.sizeMatch).toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each([['生成', generateImage], ['编辑', editImage]])('%s未填写参数继承用户4K配置，明确指定时覆盖配置', async (label, execute) => {
  const config = { ...cfg, imageOptions: { size: '3840x2160', quality: 'high', outputFormat: 'png' } };
  const fetchImpl = vi.fn(async (url, init) => {
    const request = init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body);
    expect(request.size).toBe(fetchImpl.mock.calls.length === 1 ? '3840x2160' : '1536x864');
    expect(request.quality).toBe(fetchImpl.mock.calls.length === 1 ? 'high' : 'medium');
    return response('png');
  });
  const inherited = await execute(config, { prompt: label, images: [blob()], size: undefined, quality: undefined, outputFormat: undefined, fetchImpl });
  expect(inherited.requested).toMatchObject({ size: '3840x2160', quality: 'high', output_format: 'png' });
  const explicit = await execute(config, { prompt: label, images: [blob()], size: '1536x864', quality: 'medium', fetchImpl });
  expect(explicit.requested).toMatchObject({ size: '1536x864', quality: 'medium' });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('generate_image工具不填写size时真实请求继承用户4K配置，不偷偷改为1024方图', async () => {
  const { createTools } = await import('../src/agent/tools.js');
  const fetchImpl = vi.fn(async (url, init) => {
    expect(JSON.parse(init.body)).toMatchObject({ size: '3840x2160', quality: 'high' });
    return response('png');
  });
  const config = { ...cfg, imageOptions: { size: '3840x2160', quality: 'high' } };
  const tool = createTools({ imageGen: options => generateImage(config, { ...options, fetchImpl }) }).find(item => item.name === 'generate_image');
  const receipt = JSON.parse(await tool.run({ prompt: '用户配置尺寸回归' }));
  expect(receipt).toMatchObject({ requested: { size: '3840x2160', quality: 'high' }, actual: { width: 1, height: 1 }, sizeMatch: false, readback: 'passed' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('下载后的WebP按实际格式核验且不把模型凭据发给下载地址', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/result.png' }] })));
  const download = vi.fn(async (url, options) => {
    expect(options.headers).toBeUndefined();
    expect(options.credentials).toBe('omit');
    return new Response(bytes('webp'), { headers: { 'content-type': 'image/png' } });
  });
  const result = await generateImage(cfg, { prompt: '无字素材', size: 'auto', outputFormat: 'png', fetchImpl, download });
  expect(result.actual).toMatchObject({ width: 1, height: 1, format: 'webp' });
  expect(result.formatMatch).toBe(false);
  expect(Buffer.from(await result.blob.arrayBuffer())).toEqual(bytes('webp'));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(download).toHaveBeenCalledTimes(1);
});

it('未知格式保留下载原件并明确像素未核实，不重生成', async () => {
  const original = Buffer.from('unrecognized bytes');
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: original.toString('base64') }] })));
  const result = await generateImage(cfg, { prompt: '未知返回', size: '3840x2160', fetchImpl });
  expect(result.actual).toMatchObject({ format: 'unknown', dimensions: 'unknown', width: null, height: null });
  expect(result.sizeMatch).toBeNull();
  expect(Buffer.from(await result.blob.arrayBuffer())).toEqual(original);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('交付读回真实字节，回执不沿用伪造尺寸或包含图片正文', async () => {
  const image = blob();
  const onFileChanged = vi.fn(), onImage = vi.fn();
  const receipt = await deliverGeneratedImage({ blob: image, model: 'gpt-image-2', requested: { size: '3840x2160', quality: 'high' }, actual: { width: 3840, height: 2160 } }, { path: '保真测试/原文件.png', onFileChanged, onImage });
  expect(receipt).toMatchObject({ status: 'saved', path: '保真测试/原文件.png', actual: { width: 1, height: 1 }, sizeMatch: false, readback: 'passed', visual: 'not_checked' });
  expect(receipt.notes.join('')).toContain('与请求尺寸不一致');
  expect(await (await ws.readBlob(receipt.path)).arrayBuffer()).toEqual(await image.arrayBuffer());
  expect(JSON.stringify(receipt)).not.toMatch(/base64|iVBOR|"blob"/);
  expect(onFileChanged).toHaveBeenCalledWith(receipt.path);
  expect(onImage).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), receipt.path);
  URL.revokeObjectURL(onImage.mock.calls[0][0]);
});

it('写入后读回变化不得标记完成，停止前不能写文件', async () => {
  const onFileChanged = vi.fn();
  vi.spyOn(ws, 'readBlob').mockResolvedValue(new Blob(['changed']));
  await expect(deliverGeneratedImage({ blob: blob() }, { path: '保真测试/变更.png', onFileChanged })).rejects.toMatchObject({ code: 'IMAGE_READBACK' });
  expect(onFileChanged).not.toHaveBeenCalled();
  const writer = vi.spyOn(ws, 'write');
  const controller = new AbortController(); controller.abort();
  await expect(deliverGeneratedImage({ blob: blob() }, { path: '保真测试/停止.png', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(writer).not.toHaveBeenCalled();
});

it('cover按较大缩放比例计算，4K画布不等于底图细节提升', () => {
  const actual = { width: 1536, height: 864, dimensions: 'verified' };
  expect(imageCoverReceipt(actual, 3840, 2160)).toMatchObject({ width: 1536, height: 864, scale: 2.5, upscaled: true, cropped: false, detail: 'not_checked' });
  expect(imageCoverReceipt(actual, 2160, 3840)).toMatchObject({ scale: 3840 / 864, upscaled: true, cropped: true });
  expect(imageSizeMatch({ size: '1536x864' }, actual)).toBe(true);
  expect(imageRequestReceipt('gpt-image-2', { quality: 'invented', output_format: 'svg', prompt: 'private' })).toEqual({ model: 'gpt-image-2', size: null, quality: null, output_format: null, background: null });
});
