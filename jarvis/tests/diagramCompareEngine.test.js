/** 假Office/子进程只隔离环境；PNG解析、像素比较与原通过门槛实际执行。 */
import { it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
const mocked = vi.hoisted(() => ({ office: vi.fn(), raster: vi.fn() }));
vi.mock('../server/officeRender.mjs', () => ({ renderOffice: mocked.office }));
vi.mock('../server/diagramPdfRaster.mjs', () => ({ rasterizeDiagramPdf: mocked.raster }));
import { compareDiagramPpt } from '../server/diagramCompare.mjs';

function png(width, height, channel = 255) {
  const chunk = (type, content) => {
    const result = Buffer.alloc(content.length + 12); result.writeUInt32BE(content.length); result.write(type, 4); content.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, channel);
  for (let row = 0; row < height; row++) rows[row * (width * 3 + 1)] = 0;
  return new Blob([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))], { type: 'image/png' });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocked.office.mockResolvedValue({ available: true, blob: new Blob(['%PDF-1.4 synthetic']) });
});
const render = candidate => mocked.raster.mockImplementation(async directory => {
  await fs.writeFile(path.join(directory, 'slide.png'), new Uint8Array(await candidate.arrayBuffer())); return 'pdftocairo';
});

it('同像素但错误宽高比仍拒绝，mismatch不得重渲染或切换引擎', async () => {
  render(png(4, 2));
  const result = await compareDiagramPpt(new Blob(['synthetic pptx']), png(2, 2));
  expect(result).toMatchObject({ passed: false, state: 'mismatch', meanChannelError: 0, aspectError: 1, engine: 'pdftocairo' });
  expect(mocked.raster).toHaveBeenCalledTimes(1); expect(mocked.office).toHaveBeenCalledTimes(1);
});
it('通道差大于1.2%仍拒绝；通过记录固定引擎，长边不超过2048', async () => {
  render(png(2, 2, 0));
  expect(await compareDiagramPpt(new Blob(['synthetic']), png(2, 2))).toMatchObject({ passed: false, state: 'mismatch', meanChannelError: 1, engine: 'pdftocairo' });
  expect(mocked.raster).toHaveBeenCalledTimes(1);
  mocked.raster.mockClear(); render(png(2048, 1));
  expect(await compareDiagramPpt(new Blob(['synthetic']), png(4096, 2))).toMatchObject({ passed: true, engine: 'pdftocairo' });
  expect(mocked.raster.mock.calls[0][1]).toBe('2048'); expect(mocked.raster).toHaveBeenCalledTimes(1);
});
it('引擎真实失败保留错误与引擎，不比较空文件、不另选引擎', async () => {
  mocked.raster.mockRejectedValue(Object.assign(new Error('render failed'), { code: 'DIAGRAM_COMPARE', rasterEngine: 'pdftocairo' }));
  expect(await compareDiagramPpt(new Blob(['synthetic']), png(2, 2))).toMatchObject({ passed: false, state: 'not_checked', code: 'DIAGRAM_COMPARE', engine: 'pdftocairo' });
  expect(mocked.raster).toHaveBeenCalledTimes(1);
});
