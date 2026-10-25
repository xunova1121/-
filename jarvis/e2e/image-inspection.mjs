/** 浏览器真实裁剪，不调用模型；验证区域尺寸、边界与用户停止。 */
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const moduleCode = await fs.readFile('src/agent/imageRegion.js');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/region.js' ? 'application/javascript' : 'text/html');
  res.end(req.url === '/region.js' ? moduleCode : '<!doctype html><title>图片局部复核</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  const result = await page.evaluate(async () => {
    const { cropImageRegion } = await import('/region.js');
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const painter = canvas.getContext('2d');
    painter.fillStyle = '#ff0000';
    painter.fillRect(0, 0, 200, 200);
    painter.fillStyle = '#0000ff';
    painter.fillRect(200, 0, 200, 200);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const cropped = await cropImageRegion(blob, { x: 0.5, y: 0, width: 0.5, height: 1 });
    const bitmap = await createImageBitmap(cropped);
    const target = document.createElement('canvas');
    target.width = bitmap.width;
    target.height = bitmap.height;
    const context = target.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const pixel = [...context.getImageData(300, 300, 1, 1).data];
    const shape = bitmap.width === 600 && bitmap.height === 600;
    bitmap.close();
    let invalid = false;
    let stopped = false;
    try { await cropImageRegion(blob, { x: 0.9, y: 0, width: 0.5, height: 1 }); } catch (error) { invalid = error.code === 'IMAGE_REGION'; }
    const controller = new AbortController();
    controller.abort();
    try { await cropImageRegion(blob, { x: 0, y: 0, width: 1, height: 1 }, { signal: controller.signal }); } catch (error) { stopped = error.name === 'AbortError'; }
    return { shape, blueRegion: pixel[0] === 0 && pixel[2] === 255, invalid, stopped };
  });
  for (const [label, passed] of Object.entries(result)) {
    console.log((passed ? '✓ ' : '✗ ') + label);
    if (!passed) throw new Error(label);
  }
  console.log('图片局部裁剪4/4通过');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
