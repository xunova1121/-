/** 2026-11-12 复审：渐变海报按真实像素量文字背后的对比度；不够在标题高度加深遮罩并复测，仍不够明确报部分完成 */
import { describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePngRgba, measureTextContrast, withoutText, contrastMinimum } from '../src/agent/posterContrast.js';
import { createPosterDeliveryTool } from '../src/agent/posterDeliveryTool.js';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(name, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(name, 4, 'ascii'); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc(Buffer.concat([Buffer.from(name, 'ascii'), Buffer.from(data)])), 8 + data.length);
  return out;
}
/** 生成真实 PNG：pixel(x,y)→[r,g,b]；按行轮换 0/1/2/3/4 五种过滤方式，覆盖解码器全部分支 */
function makePng(width, height, pixel, channels = 3) {
  const rows = [];
  let previous = Buffer.alloc(width * channels);
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(width * channels);
    for (let x = 0; x < width; x++) { const [r, g, b] = pixel(x, y); line[x * channels] = r; line[x * channels + 1] = g; line[x * channels + 2] = b; if (channels === 4) line[x * channels + 3] = 255; }
    const filter = y % 5, out = Buffer.alloc(line.length);
    for (let i = 0; i < line.length; i++) {
      const left = i >= channels ? line[i - channels] : 0, up = previous[i], corner = i >= channels ? previous[i - channels] : 0;
      const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      const predictor = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter];
      out[i] = (line[i] - predictor) & 255;
    }
    rows.push(Buffer.from([filter]), out); previous = line;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
}

describe('PNG 像素解码', () => {
  it.each([3, 4])('%i 通道、五种行过滤都能还原原像素', async channels => {
    const pixel = (x, y) => [(x * 37 + y) & 255, (y * 53) & 255, (x * y) & 255];
    const image = await decodePngRgba(makePng(23, 17, pixel, channels));
    expect([image.width, image.height]).toEqual([23, 17]);
    for (const [x, y] of [[0, 0], [5, 3], [22, 16], [11, 9]]) expect([...image.data.subarray((y * 23 + x) * 4, (y * 23 + x) * 4 + 3)]).toEqual(pixel(x, y));
  });
  it('不认识的格式返回 null（标未检查，不冒充通过）', async () => {
    expect(await decodePngRgba(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('按真实像素量对比度', () => {
  it('白字在浅色底上不达标、在深色底上达标；大字按4.5、小字按7', () => {
    const image = (rgb) => ({ width: 10, height: 10, data: new Uint8Array(400).map((_, i) => (i % 4 === 3 ? 255 : rgb[i % 4])) });
    const box = [{ role: 'title', fontSize: 60, x: 0, y: 0, w: 10, h: 10 }];
    expect(measureTextContrast(image([210, 190, 160]), box, '#FFFFFF').ok).toBe(false);
    expect(measureTextContrast(image([60, 50, 40]), box, '#FFFFFF').ok).toBe(true);
    expect([contrastMinimum(30), contrastMinimum(16)]).toEqual([4.5, 7]);
    expect(withoutText('<svg><rect/><text x="1">秋</text><text>日</text></svg>')).toBe('<svg><rect/><g opacity="0"><text x="1">秋</text></g><g opacity="0"><text>日</text></g></svg>');
  });
});

describe('海报工具：标题处对比不足自动加深遮罩并复测', () => {
  const bright = [215, 195, 165], dark = [70, 55, 45];
  const renderer = (decide) => vi.fn(async (svg) => {
    const [, w, h] = /width="(\d+)" height="(\d+)"/.exec(svg);
    return { blob: new Blob([makePng(Number(w), Number(h), () => decide(svg))], { type: 'image/png' }), fontCheck: { status: 'passed' } };
  });

  it('加了中间色标后复测通过：成品带加深渐变，回执写明已加深并通过', async () => {
    const renderVisualScene = renderer(svg => (/stop-opacity="0\.(45|65|85)"/.test(svg.replace('stop-opacity="0.85"/></linearGradient>', '')) ? dark : bright));
    const out = JSON.parse(await createPosterDeliveryTool({ renderVisualScene }).run({ title: '秋日暖汤', subtitle: '让温暖融入每个日常', width: 360, height: 480, text_style: 'gradient', path: '对比度/加深.png' }));
    expect(out.gradient.contrast).toBe('passed');
    expect(out.gradient.boosted.opacity).toBe(0.45);
    expect(out.notes.join('')).toContain('已在标题高度加深遮罩');
    expect(out.status).toBe('complete');
    const finalSvg = renderVisualScene.mock.calls.map(c => c[0]).find(svg => svg.includes('<text') && !svg.includes('<g opacity="0">'));
    expect(finalSvg).toContain('stop-opacity="0.45"');
  });

  it('加深三档仍不达标：标部分完成并说明原因，不谎称通过', async () => {
    const out = JSON.parse(await createPosterDeliveryTool({ renderVisualScene: renderer(() => bright) }).run({ title: '秋日暖汤', width: 360, height: 480, text_style: 'gradient', path: '对比度/失败.png' }));
    expect(out.gradient.contrast).toBe('failed');
    expect(out.status).toBe('partial');
    expect(out.errors.map(e => e.code)).toContain('POSTER_CONTRAST_LOW');
  });

  it('本来就够深：不加深、不多渲染', async () => {
    const renderVisualScene = renderer(() => dark);
    const out = JSON.parse(await createPosterDeliveryTool({ renderVisualScene }).run({ title: '秋日暖汤', width: 360, height: 480, text_style: 'gradient', path: '对比度/够深.png' }));
    expect(out.gradient).toMatchObject({ contrast: 'passed' });
    expect(out.gradient.boosted).toBeUndefined();
    expect(renderVisualScene).toHaveBeenCalledTimes(2);
  });
});
