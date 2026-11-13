import { afterEach, expect, it, vi } from 'vitest';
import { renderVisualScene } from '../src/agent/visualSceneRaster.js';
import { renderPoster } from '../src/agent/posterRaster.js';
import { visualRasterPng, visualRasterImageTag } from './fixtures/visualRasterImages.js';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X0AAAAASUVORK5CYII=', 'base64');
const fontCheck = { status: 'passed', family: 'Noto Sans CJK SC', method: 'browser-glyph-render', glyphCount: 2 };
const fontProbe = async () => fontCheck;
const never = () => new Promise(() => {});
const content = '<text x="40" y="80" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="30" fill="#ffffff">中文</text>';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><g>${content}</g></svg>`;
const posterSvg = svg.replace('<g>', '').replace('</g>', '');

function browserFixture({ output, decode = true, toBlob = true, imageError = false, imageWidth = 2 } = {}) {
  const bytes = Buffer.from(pixel);
  // 模拟浏览器编码结果；真实字体及像素渲染另由浏览器验收覆盖。
  bytes.writeUInt32BE(640, 16);
  bytes.writeUInt32BE(360, 20);
  const drawImage = vi.fn();
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage })), toBlob: vi.fn(callback => { if (toBlob) callback(output || new Blob([bytes], { type: 'image/png' })); }) };
  const images = [];
  class FixtureImage {
    constructor() { images.push(this); }
    set src(value) {
      this.source = value;
      this.naturalWidth = imageWidth;
      this.naturalHeight = 2;
      if (value && decode) queueMicrotask(() => value.startsWith('data:') && imageError ? this.onerror?.() : this.onload?.());
    }
    get src() { return this.source; }
  }
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  vi.stubGlobal('Image', FixtureImage);
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture-svg');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return { canvas, drawImage, images, create, revoke };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('浏览器场景核验字体后按原尺寸绘制PNG，释放图像URL和Canvas', async () => {
  const fixture = browserFixture();
  const result = await renderVisualScene(svg, { fontProbe });
  expect(result).toMatchObject({ width: 640, height: 360, fontCheck });
  expect(result.blob.type).toBe('image/png');
  expect(fixture.drawImage).toHaveBeenCalledWith(fixture.images[0], 0, 0, 640, 360);
  expect(await fixture.create.mock.calls[0][0].text()).toContain('font-family="Noto Sans CJK SC"');
  expect(fixture.revoke).toHaveBeenCalledWith('blob:fixture-svg');
  expect(fixture.images[0].src).toBe('');
  expect([fixture.canvas.width, fixture.canvas.height]).toEqual([0, 0]);
});

it('浏览器的旧海报入口仍拒绝场景分组，调用参数不能替换校验器', async () => {
  const fixture = browserFixture();
  await expect(renderPoster(svg, { fontProbe, validate: () => ({ svg, width: 640, height: 360 }) })).rejects.toHaveProperty('code', 'POSTER_UNSAFE');
  expect(fixture.create).not.toHaveBeenCalled();
});

it('浏览器场景不会将错误尺寸或缺少IEND的PNG记为完成', async () => {
  for (const bytes of [pixel, pixel.subarray(0, 24)]) {
    const fixture = browserFixture({ output: new Blob([bytes], { type: 'image/png' }) });
    await expect(renderVisualScene(svg, { fontProbe })).rejects.toHaveProperty('code', 'POSTER_RENDER_INVALID');
    expect(fixture.revoke).toHaveBeenCalledWith('blob:fixture-svg');
    vi.restoreAllMocks();
  }
});

it('浏览器在图像解码中取消会立即清理资源，不绘制迟到图像', async () => {
  const fixture = browserFixture({ decode: false });
  const controller = new AbortController();
  const pending = renderVisualScene(svg, { signal: controller.signal, fontProbe });
  const rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError');
  await vi.waitFor(() => expect(fixture.create).toHaveBeenCalledTimes(1));
  controller.abort();
  await rejected;
  fixture.images[0].onload?.();
  expect(fixture.drawImage).not.toHaveBeenCalled();
  expect(fixture.revoke).toHaveBeenCalledWith('blob:fixture-svg');
});

it('浏览器20秒截止涵盖字体探测和PNG编码的等待', async () => {
  vi.useFakeTimers();
  for (const waitingForFont of [true, false]) {
    const fixture = browserFixture({ toBlob: false });
    const pending = renderVisualScene(svg, { fontProbe: waitingForFont ? never : fontProbe });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'POSTER_RENDER_TIMEOUT', kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect([fixture.canvas.width, fixture.canvas.height]).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
  }
});

it('浏览器场景和海报共用两并发额度，取消字体等待即释放额度', async () => {
  browserFixture();
  const controllers = [new AbortController(), new AbortController()];
  const pending = [renderVisualScene(svg, { signal: controllers[0].signal, fontProbe: never }), renderPoster(posterSvg, { signal: controllers[1].signal, fontProbe: never })];
  const settled = Promise.allSettled(pending);
  try {
    await expect(renderVisualScene(svg, { fontProbe })).rejects.toHaveProperty('code', 'POSTER_RENDER_BUSY');
  } finally {
    controllers.forEach(controller => controller.abort());
    expect((await settled).every(item => item.status === 'rejected' && item.reason.name === 'AbortError')).toBe(true);
  }
  await expect(renderVisualScene(svg, { fontProbe })).resolves.toMatchObject({ width: 640, height: 360 });
});

it('浏览器场景先单独解码底图并核对尺寸，坏CRC、解码失败或尺寸不符不能省略底图交付', async () => {
  const source = bytes => svg.replace('</g>', visualRasterImageTag(bytes) + '</g>');
  for (const config of [{}, { badCrc: true }, { imageError: true }, { imageWidth: 20 }]) {
    const fixture = browserFixture(config);
    const pending = renderVisualScene(source(visualRasterPng(config)), { fontProbe });
    if (Object.keys(config).length) {
      await expect(pending).rejects.toHaveProperty('code', 'VISUAL_IMAGE_DECODE_INVALID');
      expect(fixture.create).not.toHaveBeenCalled();
      expect(fixture.drawImage).not.toHaveBeenCalled();
    } else {
      await expect(pending).resolves.toMatchObject({ width: 640, height: 360 });
      expect(fixture.images).toHaveLength(2);
      expect(fixture.create).toHaveBeenCalledTimes(1);
    }
    expect(fixture.images.every(item => item.src === '')).toBe(true);
    vi.restoreAllMocks();
  }
});

it('浏览器底图解码无回执时仍在20秒退出并清理独立图像', async () => {
  vi.useFakeTimers();
  const fixture = browserFixture({ decode: false });
  const source = svg.replace('</g>', visualRasterImageTag(visualRasterPng()) + '</g>');
  const pending = renderVisualScene(source, { fontProbe });
  const rejected = expect(pending).rejects.toHaveProperty('code', 'POSTER_RENDER_TIMEOUT');
  await vi.advanceTimersByTimeAsync(20000);
  await rejected;
  expect(fixture.images).toHaveLength(2);
  expect(fixture.images.every(item => item.src === '')).toBe(true);
  expect(fixture.create).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
