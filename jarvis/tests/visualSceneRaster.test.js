import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { renderPoster } from '../server/posterRaster.mjs';
import { imageInfo } from '../src/agent/imageInfo.js';
import { visualRasterPng, visualRasterImageTag } from './fixtures/visualRasterImages.js';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X0AAAAASUVORK5CYII=', 'base64');
const fontCheck = { status: 'passed', family: 'Noto Sans CJK SC', method: 'fontconfig-charset', glyphCount: 6 };
const fontProbe = async () => fontCheck;
const never = () => new Promise(() => {});
const text = '<text x="40" y="100" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="30" font-weight="700" fill="#ffffff">中文视觉场景</text>';
const sceneSvg = (width = 640, height = 360) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#123456"/><stop offset="1" stop-color="#abcdef"/></linearGradient></defs><g><rect width="${width}" height="${height}" fill="url(#sky)"/><path d="M0 100 L640 120" stroke="#ffffff" fill="none"/>${text}</g></svg>`;
const posterSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">${text}</svg>`;

function fakeChild({ output, started, error } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = vi.fn();
  child.stdin.end = vi.fn(() => queueMicrotask(() => {
    started?.(child);
    if (error) child.emit('error', Object.assign(new Error('fixture'), { code: error }));
    else if (output) { child.stdout.emit('data', output); child.emit('close', 0); }
  }));
  return child;
}

afterEach(() => vi.useRealTimers());

it('场景真实渲染渐变、路径、分组与中文，按1920×1080输出PNG并核验全文字形', async () => {
  const result = await renderVisualScene(sceneSvg(1920, 1080));
  expect(imageInfo(new Uint8Array(await result.blob.arrayBuffer()))).toMatchObject({ type: 'png', width: 1920, height: 1080 });
  expect(result.blob.size).toBeGreaterThan(10000);
  expect(result.fontCheck).toMatchObject({ status: 'passed', method: 'fontconfig-charset', glyphCount: 6 });
}, 20000);

it('共享渲染机制不能扩大原海报入口白名单，非法场景也在启动进程前拒绝', async () => {
  const spawnImpl = vi.fn();
  const probe = vi.fn(fontProbe);
  await expect(renderPoster(sceneSvg(), { spawnImpl, fontProbe: probe, validate: value => value })).rejects.toHaveProperty('code', 'POSTER_UNSAFE');
  for (const unsafe of ['<image href="https://example.com/a.png"/>', '<script>alert(1)</script>', '<path d="M0 0" onload="alert(1)"/>']) {
    await expect(renderVisualScene(sceneSvg().replace('</g>', unsafe + '</g>'), { spawnImpl, fontProbe: probe })).rejects.toBeInstanceOf(Error);
  }
  expect(spawnImpl).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
});

it('渲染命令与参数固定，通过stdin传已锁定字体SVG，不接收用户命令或路径', async () => {
  const child = fakeChild({ output: pixel });
  const spawnImpl = vi.fn(() => child);
  await expect(renderVisualScene(sceneSvg(), { fontProbe, spawnImpl, command: 'sh', path: '/tmp/ignored' })).rejects.toHaveProperty('code', 'POSTER_RENDER_INVALID');
  expect(spawnImpl).toHaveBeenCalledTimes(1);
  expect(spawnImpl).toHaveBeenCalledWith('rsvg-convert', ['--format=png', '--width=640', '--height=360'], { cwd: undefined, stdio: ['pipe', 'pipe', 'ignore'] });
  expect(child.stdin.end.mock.calls[0][0]).toContain('font-family="Noto Sans CJK SC"');
  expect(child.stdin.end.mock.calls[0][0]).toContain('url(#sky)');
});

it('字体失败与缺字不会继续渲染，也不会把fontconfig回退当作成功', async () => {
  const spawnImpl = vi.fn();
  const failure = Object.assign(new Error('字体不覆盖全文'), { code: 'POSTER_FONT_GLYPHS_MISSING', kind: 'capability' });
  await expect(renderVisualScene(sceneSvg(), { spawnImpl, fontProbe: async () => { throw failure; } })).rejects.toBe(failure);
  expect(spawnImpl).not.toHaveBeenCalled();
});

it('用户在场景渲染中停止会杀死子进程，取消后不会启动备用渲染', async () => {
  const controller = new AbortController();
  const child = fakeChild({ started: () => controller.abort() });
  const spawnImpl = vi.fn(() => child);
  await expect(renderVisualScene(sceneSvg(), { signal: controller.signal, fontProbe, spawnImpl })).rejects.toHaveProperty('name', 'AbortError');
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(spawnImpl).toHaveBeenCalledTimes(1);
});

it('场景与海报合计最多两并发，字体等待也占额度，取消后释放', async () => {
  const controllers = [new AbortController(), new AbortController()];
  const pending = [renderVisualScene(sceneSvg(), { signal: controllers[0].signal, fontProbe: never }), renderPoster(posterSvg, { signal: controllers[1].signal, fontProbe: never })];
  const settled = Promise.allSettled(pending);
  try {
    await expect(renderVisualScene(sceneSvg(), { fontProbe })).rejects.toHaveProperty('code', 'POSTER_RENDER_BUSY');
  } finally {
    controllers.forEach(controller => controller.abort());
    const result = await settled;
    expect(result.every(item => item.status === 'rejected' && item.reason.name === 'AbortError')).toBe(true);
  }
  await expect(renderVisualScene(sceneSvg(), { fontProbe, spawnImpl: () => fakeChild({ output: pixel }) })).rejects.toHaveProperty('code', 'POSTER_RENDER_INVALID');
});

it('整段20秒截止涵盖不返回的字体探测，超时后不启动渲染器', async () => {
  vi.useFakeTimers();
  const spawnImpl = vi.fn();
  const pending = renderVisualScene(sceneSvg(), { fontProbe: never, spawnImpl });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'POSTER_RENDER_TIMEOUT', kind: 'timeout' });
  await vi.advanceTimersByTimeAsync(20000);
  await rejected;
  expect(spawnImpl).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('场景拒绝半截PNG、错误尺寸与超限输出，异常进程被终止', async () => {
  for (const output of [pixel.subarray(0, 24), pixel]) {
    await expect(renderVisualScene(sceneSvg(), { fontProbe, spawnImpl: () => fakeChild({ output }) })).rejects.toHaveProperty('code', 'POSTER_RENDER_INVALID');
  }
  const child = fakeChild({ output: Buffer.alloc(24000001) });
  await expect(renderVisualScene(sceneSvg(), { fontProbe, spawnImpl: () => child })).rejects.toHaveProperty('code', 'POSTER_RENDER_SIZE');
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('场景先真实解码内嵌底图，正确底图保留，而坏CRC或有效CRC的坏像素都失败', async () => {
  const source = bytes => sceneSvg().replace('</g>', visualRasterImageTag(bytes) + '</g>');
  const valid = await renderVisualScene(source(visualRasterPng()));
  expect(valid).toMatchObject({ width: 640, height: 360 });
  expect(imageInfo(new Uint8Array(await valid.blob.arrayBuffer()))).toMatchObject({ type: 'png', width: 640, height: 360 });
  for (const options of [{ badCrc: true }, { badData: true }]) {
    await expect(renderVisualScene(source(visualRasterPng(options)))).rejects.toHaveProperty('code', 'VISUAL_IMAGE_DECODE_INVALID');
  }
}, 20000);

it('底图实解码缺ffmpeg、取消或尺寸不符均不继续渲染SVG', async () => {
  const source = sceneSvg().replace('</g>', visualRasterImageTag(visualRasterPng()) + '</g>');
  const missing = vi.fn(() => fakeChild({ error: 'ENOENT' }));
  await expect(renderVisualScene(source, { fontProbe, spawnImpl: missing })).rejects.toHaveProperty('code', 'VISUAL_IMAGE_DECODE_UNAVAILABLE');
  expect(missing).toHaveBeenCalledTimes(1);
  const wrongSize = vi.fn(() => fakeChild({ output: Buffer.from('#dimensions 0: 20x20\n0, 0, 0, 1, 600, 0x12345678\n') }));
  await expect(renderVisualScene(source, { fontProbe, spawnImpl: wrongSize })).rejects.toHaveProperty('code', 'VISUAL_IMAGE_DECODE_INVALID');
  expect(wrongSize).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  const child = fakeChild({ started: () => controller.abort() });
  const stopped = vi.fn(() => child);
  await expect(renderVisualScene(source, { signal: controller.signal, fontProbe, spawnImpl: stopped })).rejects.toHaveProperty('name', 'AbortError');
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(stopped.mock.calls[0][0]).toBe('ffmpeg');
  expect(stopped.mock.calls[0][1]).toContain('pipe:0');
  expect(child.stdin.end.mock.calls[0][0]).toEqual(new Uint8Array(visualRasterPng()));
});

it('字体和底图实解码共用20秒总预算，进入下一阶段不重置截止', async () => {
  vi.useFakeTimers();
  const source = sceneSvg().replace('</g>', visualRasterImageTag(visualRasterPng()) + '</g>');
  const child = fakeChild();
  const spawnImpl = vi.fn(() => child);
  const pending = renderVisualScene(source, { fontProbe: () => new Promise(resolve => setTimeout(() => resolve(fontCheck), 10000)), spawnImpl });
  const rejected = expect(pending).rejects.toHaveProperty('code', 'POSTER_RENDER_TIMEOUT');
  await vi.advanceTimersByTimeAsync(20000);
  await rejected;
  expect(spawnImpl).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(vi.getTimerCount()).toBe(0);
});

it('元数据里的尖括号与引号经规范序列化，不妨碍锁定实际字体或改写正文', async () => {
  const source = sceneSvg().replace('<text x=', '<text data-label="a&gt;b &quot;font-family&quot;" x=').replace('中文视觉场景', '正文 font-family=&quot;Microsoft YaHei&quot;');
  const child = fakeChild({ output: pixel });
  await expect(renderVisualScene(source, { fontProbe, spawnImpl: () => child })).rejects.toHaveProperty('code', 'POSTER_RENDER_INVALID');
  const submitted = child.stdin.end.mock.calls[0][0];
  expect(submitted).toContain('data-label="a&gt;b &quot;font-family&quot;"');
  expect(submitted).toContain('font-family="Noto Sans CJK SC"');
  expect(submitted).toContain('正文 font-family="Microsoft YaHei"');
});
