import { it, expect } from 'vitest';
import { rasterizeSvg, svgRasterDimensions } from '../server/svgRaster.mjs';
import { pngPixels } from '../src/agent/diagramPng.js';
it('SVG直接按目标尺寸栅格化，不走无法解码的管道或事后二次缩放', async () => {
  const blob = await rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="440"><rect width="1440" height="440" fill="#ffffff"/><text x="40" y="80" font-size="32">合成测试</text></svg>');
  const pixels = await pngPixels(blob);
  expect([pixels.width, pixels.height]).toEqual([2048, 626]);
  expect(blob.size).toBeGreaterThan(1000);
});
it('目标分辨率保持原2048上限，停止和不安全SVG不能进入解码器', async () => {
  expect(svgRasterDimensions(1440, 440)).toEqual({ width: 2048, height: 626 });
  expect(svgRasterDimensions(1440, 4000)).toEqual({ width: 737, height: 2048 });
  await expect(rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>bad</script></svg>')).rejects.toThrow();
  const ctrl = new AbortController(); ctrl.abort();
  await expect(rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="10" height="10" fill="#ffffff"/></svg>', { signal: ctrl.signal })).rejects.toHaveProperty('name', 'AbortError');
});
