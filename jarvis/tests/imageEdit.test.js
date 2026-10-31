import { it, expect, vi } from 'vitest';
import { editImage } from '../src/llm/imageEdit.js';
import { createTools } from '../src/agent/tools.js';
import * as workspace from '../src/agent/workspace.js';
const cfg = { provider: 'custom', baseURLs: { custom: 'https://images.example/v1' }, keys: { custom: 'fixture-key' }, imageModel: 'gpt-image-1' };
it('真实原图进入multipart编辑接口，下载不带模型凭据', async () => {
  const blob = new Blob(['original'], { type: 'image/png' });
  const fetchImpl = vi.fn(async (url, options) => {
    expect(url).toBe('https://images.example/v1/images/edits');
    expect(options.headers.Authorization).toBe('Bearer fixture-key');
    expect(options.headers['Content-Type']).toBeUndefined();
    expect(await options.body.get('image').text()).toBe('original');
    return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/result.png' }] }));
  });
  const download = vi.fn(async (url, options) => { expect(url).toBe('https://cdn.example/result.png'); expect(options.headers).toBeUndefined(); return new Response('image', { headers: { 'content-type': 'image/png' } }); });
  const result = await editImage(cfg, { prompt: '只改背景', images: [blob], fetchImpl, download });
  expect(await result.blob.text()).toBe('image');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('编辑接口不支持明确失败，不退化为generations；停止不重试', async () => {
  const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
  await expect(editImage(cfg, { prompt: '改图', images: [new Blob(['x'])], fetchImpl })).rejects.toMatchObject({ status: 404 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  controller.abort();
  await expect(editImage(cfg, { prompt: '改图', images: [new Blob(['x'])], signal: controller.signal, fetchImpl })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('工具读取指定参考图再编辑，并转发停止信号，不凭旧描述重画', async () => {
  await workspace.write('编辑参考.png', new Blob(['real-original'], { type: 'image/png' }));
  const imageGen = vi.fn();
  const imageEdit = vi.fn(async ({ images, signal }) => { expect(await images[0].text()).toBe('real-original'); expect(signal).toBeDefined(); return { blob: new Blob(['result'], { type: 'image/png' }), model: 'fixture' }; });
  const tool = createTools({ imageGen, imageEdit }).find(tool => tool.name === 'generate_image');
  const controller = new AbortController();
  const result = await tool.run({ prompt: '只改背景，保留主体', referencePaths: ['编辑参考.png'] }, { signal: controller.signal });
  expect(result).toContain('已生成图片');
  expect(imageGen).not.toHaveBeenCalled();
  expect(imageEdit).toHaveBeenCalledTimes(1);
});
