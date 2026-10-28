import { it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { rasterizeDiagramPdf } from '../server/diagramPdfRaster.mjs';

afterEach(() => vi.useRealTimers());
function processes(results) {
  return vi.fn(() => {
    const child = new EventEmitter(); child.kill = vi.fn();
    const result = results.shift();
    queueMicrotask(() => {
      if (result instanceof Error) child.emit('error', result);
      else if (result !== 'pending') child.emit('close', result || 0);
    });
    return child;
  });
}

it('固定Cairo优先且长边保持2048；仅缺二进制时兼容原pdftoppm', async () => {
  const cairo = processes([0]);
  expect(await rasterizeDiagramPdf('/tmp/synthetic-pdf', 2048, { spawnImpl: cairo })).toBe('pdftocairo');
  expect(cairo).toHaveBeenCalledTimes(1);
  expect(cairo.mock.calls[0].slice(0, 2)).toEqual(['pdftocairo', ['-singlefile', '-f', '1', '-scale-to', '2048', '-png', 'slide.pdf', 'slide']]);
  const missing = processes([Object.assign(new Error('missing'), { code: 'ENOENT' }), 0]);
  expect(await rasterizeDiagramPdf('/tmp/synthetic-pdf', 2048, { spawnImpl: missing })).toBe('pdftoppm');
  expect(missing.mock.calls.map(call => call[0])).toEqual(['pdftocairo', 'pdftoppm']);
});

it('真实渲染失败、权限错误和超时都不能换引擎凑通过', async () => {
  for (const value of [1, Object.assign(new Error('permission'), { code: 'EACCES' })]) {
    const spawnImpl = processes([value, 0]);
    await expect(rasterizeDiagramPdf('/tmp/synthetic-pdf', 2048, { spawnImpl })).rejects.toMatchObject({ rasterEngine: 'pdftocairo' });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  }
  vi.useFakeTimers();
  const spawnImpl = processes(['pending']);
  const promise = rasterizeDiagramPdf('/tmp/synthetic-pdf', 2048, { spawnImpl });
  const rejected = expect(promise).rejects.toMatchObject({ code: 'DIAGRAM_COMPARE_TIMEOUT', rasterEngine: 'pdftocairo' });
  await vi.advanceTimersByTimeAsync(20000); await rejected;
  expect(spawnImpl).toHaveBeenCalledTimes(1); expect(spawnImpl.mock.results[0].value.kill).toHaveBeenCalledWith('SIGKILL');
});

it('取消/预算信号不能触发旧引擎；非法分辨率不启动子进程', async () => {
  const controller = new AbortController(), spawnImpl = processes(['pending', 0]);
  const promise = rasterizeDiagramPdf('/tmp/synthetic-pdf', 2048, { spawnImpl, signal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' }); expect(spawnImpl).toHaveBeenCalledTimes(1);
  const budget = Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' }), stopped = processes([budget, 0]);
  await expect(rasterizeDiagramPdf('/tmp/synthetic-pdf', 2048, { spawnImpl: stopped })).rejects.toBe(budget);
  expect(stopped).toHaveBeenCalledTimes(1);
  const never = processes([]);
  for (const resolution of [0, 2049, '2048;run', NaN]) await expect(rasterizeDiagramPdf('/tmp/synthetic-pdf', resolution, { spawnImpl: never })).rejects.toMatchObject({ code: 'DIAGRAM_COMPARE_RESOLUTION' });
  expect(never).not.toHaveBeenCalled();
});
