import { EventEmitter } from 'node:events';
import { it, expect, vi } from 'vitest';
import { validatePosterSvg, lockPosterFont, POSTER_LIMITS } from '../src/agent/posterSvg.js';
import { validateSvg } from '../src/agent/svgPreview.js';
import { renderPoster, checkPosterFonts, fontCharsetCovers } from '../server/posterRaster.mjs';
import { imageInfo } from '../src/agent/imageInfo.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X0AAAAASUVORK5CYII=';
const svg = (text = '秋季养生汤', extra = '', size = [1024, 1536]) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size[0]}" height="${size[1]}" viewBox="0 0 ${size[0]} ${size[1]}"><rect width="${size[0]}" height="${size[1]}" fill="#123456"/>${extra}<text x="40" y="100" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="60" font-weight="700" fill="#ffffff">${text}</text></svg>`;
const fontCheck = { status: 'passed', family: 'Noto Sans CJK SC', method: 'fontconfig-charset', glyphCount: 5 };
const fakeFont = async () => fontCheck;

it('海报允许内嵌位图且严格保留1024×1536，通用SVG仍拒绝同样图片', () => {
  const source = svg('秋季养生汤', `<image x="0" y="0" width="1024" height="1536" href="data:image/png;base64,${pixel}" preserveAspectRatio="xMidYMid slice"/>`);
  const checked = validatePosterSvg(source);
  expect([checked.width, checked.height]).toEqual([1024, 1536]);
  expect(checked.svg).toContain('width="1024"');
  expect(checked.text).toBe('秋季养生汤');
  expect(() => validateSvg(source)).toThrow();
});

it('锁定实际字体只改属性，正文中的同名代码和引号保持原文', () => {
  const checked = validatePosterSvg(svg('代码 font-family=&quot;Microsoft YaHei&quot; 与 &lt;text&gt; 均保留'));
  const locked = validatePosterSvg(lockPosterFont(checked.svg, 'Noto Sans CJK SC'));
  expect(locked.text).toBe(checked.text);
  expect(locked.text).toContain('font-family="Microsoft YaHei"');
  expect(locked.families).toEqual(['Noto Sans CJK SC']);
});

it('海报白名单拒绝远程/本地图片、SVG伪装底图、活动内容、CSS与命名空间绕过', () => {
  const bad = [
    '<image href="https://example.com/a.png"/>', '<image href="file:///etc/passwd"/>',
    '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>', '<image href="data:image/png;base64,PHN2Zy8+"/>',
    '<script>alert(1)</script>', '<rect style="fill:red"/>', '<rect fill="url(#x)"/>',
    '<foreignObject/>', '<image href="data:image/png;base64,AAAA" onload="alert(1)"/>',
    '<x:text xmlns:x="http://www.w3.org/2000/svg">中</x:text>', '<g><rect/></g>', '<rect xml:base="https://example.com"/>',
    '<rect fill="red"/><use href="#x"/>', '<text>&#x4e2d;</text>'
  ];
  for (const element of bad) expect(() => validatePosterSvg(svg('中', element)), element).toThrow();
  expect(() => validatePosterSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + svg())).toThrow();
  for (const tag of ['constructor', 'toString', '__proto__']) expect(() => validatePosterSvg(svg('中', `<${tag}/>`))).toThrow();
  expect(() => validatePosterSvg(svg().replace('Noto Sans CJK SC, Microsoft YaHei, sans-serif', 'Microsoft YaHei, '.repeat(100) + 'sans-serif'))).toThrow();
  expect(() => validatePosterSvg(svg('中', '<rect>'.repeat(10000) + '</rect>'.repeat(10000)))).toThrow();
});

it('海报限制画布、节点、文字和位图像素，拒绝不匹配viewBox与错误图片标记', () => {
  expect(() => validatePosterSvg(svg('中', '', [4097, 100]))).toThrow();
  expect(() => validatePosterSvg(svg().replace('viewBox="0 0 1024 1536"', 'viewBox="0 0 512 768"'))).toThrow();
  expect(() => validatePosterSvg(svg('中', '<rect/>'.repeat(POSTER_LIMITS.nodes)))).toThrow();
  expect(() => validatePosterSvg(svg('中'.repeat(POSTER_LIMITS.text + 1)))).toThrow();
  expect(() => validatePosterSvg(svg('中', `<image href="data:image/jpeg;base64,${pixel}"/>`))).toThrow();
  const huge = Buffer.from(pixel, 'base64');
  huge.writeUInt32BE(12000, 16); huge.writeUInt32BE(12000, 20);
  expect(() => validatePosterSvg(svg('中', `<image href="data:image/png;base64,${huge.toString('base64')}"/>`))).toThrow();
  expect(() => validatePosterSvg(svg('中', `<image href="data:image/png;base64,${pixel}"/>`.repeat(5)))).toThrow();
});

it('WebP只接收静态且画布与真实帧尺寸一致的图片', () => {
  const base = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  const source = bytes => svg('中', `<image href="data:image/webp;base64,${bytes.toString('base64')}"/>`);
  expect(validatePosterSvg(source(base)).width).toBe(1024);
  const extended = Buffer.concat([base.subarray(0, 12), Buffer.from('565038580a00000000000000000000000000', 'hex'), base.subarray(12)]);
  extended.writeUInt32LE(extended.length - 8, 4);
  expect(validatePosterSvg(source(extended)).width).toBe(1024);
  extended[20] = 2;
  expect(() => validatePosterSvg(source(extended))).toThrow();
  extended[20] = 0; extended[24] = 9;
  expect(() => validatePosterSvg(source(extended))).toThrow();
});

it('字体检查覆盖全文和粗体，不能把fc-match静默替代或仅部分中文字形当成功', async () => {
  const checked = validatePosterSvg(svg('中文A'));
  const run = vi.fn(async () => Buffer.from('Noto Sans CJK SC\n20-7e 4e2d 6587\n'));
  await expect(checkPosterFonts(checked, { run })).resolves.toMatchObject({ status: 'passed', glyphCount: 3 });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[0][1].at(-1)).toBe('Noto Sans CJK SC:weight=80');
  expect(run.mock.calls[1][1].at(-1)).toBe('Noto Sans CJK SC:weight=200');
  await expect(checkPosterFonts(checked, { run: async () => 'DejaVu Sans\n20-7e 4e2d 6587\n' })).rejects.toHaveProperty('code', 'POSTER_FONT_MISSING');
  await expect(checkPosterFonts(checked, { run: async () => 'Noto Sans CJK SC\n20-7e 4e2d\n' })).rejects.toHaveProperty('code', 'POSTER_FONT_GLYPHS_MISSING');
  expect(fontCharsetCovers('20-7e 20000-20002', ['A', '\u{20001}'])).toBe(true);
  expect(fontCharsetCovers('20-7e 20000-20002', ['\u{20003}'])).toBe(false);
});

it('字体检测缺命令与权限失败保留不同类型，用户停止不降级', async () => {
  const checked = validatePosterSvg(svg());
  await expect(checkPosterFonts(checked, { run: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } })).rejects.toHaveProperty('code', 'POSTER_FONT_CHECK_UNAVAILABLE');
  await expect(checkPosterFonts(checked, { run: async () => { throw Object.assign(new Error('permission'), { code: 'EACCES' }); } })).rejects.toHaveProperty('code', 'EACCES');
  const controller = new AbortController(); controller.abort();
  const spawnImpl = vi.fn();
  await expect(renderPoster(svg(), { signal: controller.signal, spawnImpl, fontProbe: fakeFont })).rejects.toHaveProperty('name', 'AbortError');
  expect(spawnImpl).not.toHaveBeenCalled();
});

function fakeChild({ output, error, started } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = vi.fn();
  child.stdin.end = () => queueMicrotask(() => {
    started?.(child);
    if (error) child.emit('error', Object.assign(new Error('renderer'), { code: error }));
    else if (output) { child.stdout.emit('data', output); child.emit('close', 0); }
  });
  return child;
}

it('渲染尺寸不符、不可用和权限异常不能登记为成功', async () => {
  await expect(renderPoster(svg(), { fontProbe: fakeFont, spawnImpl: () => fakeChild({ output: Buffer.from(pixel, 'base64') }) })).rejects.toHaveProperty('code', 'POSTER_RENDER_INVALID');
  await expect(renderPoster(svg(), { fontProbe: fakeFont, spawnImpl: () => fakeChild({ error: 'ENOENT' }) })).rejects.toHaveProperty('code', 'POSTER_RENDER_UNAVAILABLE');
  const denied = vi.fn(() => fakeChild({ error: 'EACCES' }));
  await expect(renderPoster(svg(), { fontProbe: fakeFont, spawnImpl: denied })).rejects.toHaveProperty('code', 'EACCES');
  expect(denied).toHaveBeenCalledTimes(1);
});

it('渲染过程中用户停止会杀死子进程并向上传播', async () => {
  const controller = new AbortController();
  let child;
  const pending = renderPoster(svg(), { signal: controller.signal, fontProbe: fakeFont, spawnImpl: () => (child = fakeChild({ started: () => controller.abort() })) });
  await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('进程异常终止或code0输出半截PNG均不能冒充完成', async () => {
  const header = Buffer.from(pixel, 'base64').subarray(0, 24);
  for (const [code, terminationSignal] of [[null, 'SIGKILL'], [0, null]]) {
    const spawnImpl = () => fakeChild({ started: child => {
      child.stdout.emit('data', header);
      child.emit('close', code, terminationSignal);
    } });
    await expect(renderPoster(svg('中', '', [1, 1]), { fontProbe: fakeFont, spawnImpl })).rejects.toMatchObject({ code: code === null ? 'POSTER_RENDER' : 'POSTER_RENDER_INVALID' });
  }
});

it('真实服务端渲染按原尺寸输出PNG，全文中文字体检测通过', async () => {
  const result = await renderPoster(svg());
  const actual = imageInfo(new Uint8Array(await result.blob.arrayBuffer()));
  expect(actual).toMatchObject({ type: 'png', width: 1024, height: 1536 });
  expect(result.blob.size).toBeGreaterThan(10000);
  expect(result.fontCheck).toMatchObject({ status: 'passed', method: 'fontconfig-charset', glyphCount: 5 });
}, 20000);
