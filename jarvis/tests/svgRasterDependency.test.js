import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { rasterizeSvg } from '../server/svgRaster.mjs';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ffffff"/></svg>';
const missing = code => () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn failure'), { code })));
  return child;
};
it('缺ffmpeg给出确切能力错误，权限错误不能冒称未安装', async () => {
  await expect(rasterizeSvg(svg, { spawnImpl: missing('ENOENT') })).rejects.toMatchObject({ code: 'SVG_RENDER_FFMPEG_MISSING', kind: 'capability', message: expect.stringContaining('缺 ffmpeg') });
  await expect(rasterizeSvg(svg, { spawnImpl: missing('EACCES') })).rejects.toMatchObject({ code: 'EACCES' });
});
