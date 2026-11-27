/** 原创受控七卡槽像素样张，非用户照片、非真实新闻，用于验证定位和底图保护。 */
import { createCanvas } from '@napi-rs/canvas';
export const canvasCopy = [
  ['城市观察', '让信息清楚地进入卡槽'],
  ['绿色发展', '保留原图的光影与装饰'],
  ['服务升级', '中文保持真实字体'],
  ['产业协作', '每段文案完整保留'],
  ['数字生活', '手机整图仍然可读'],
  ['开放交流', '图标不会被文字覆盖'],
  ['未来视角', '改字继续复用原底图']
].map(([title, body]) => ({ title, body }));
export function canvasFixture({ width = 1000, height = 1500, count = 7, shift = 0, left = 0.15 } = {}) {
  const canvas = createCanvas(width, height),
    ctx = canvas.getContext('2d'),
    protections = [];
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#B4DCF5');
  bg.addColorStop(1, '#8DC1F1');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  // 抽象主体保护区不代表生成了或使用了用户人像。
  ctx.fillStyle = '#408BCC';
  ctx.beginPath();
  ctx.ellipse(width * 0.77, height * 0.25, width * 0.17, height * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  protections.push({ id: 'subject', x: 0.6, y: 0.06, w: 0.34, h: 0.37 });
  for (let i = 0; i < count; i++) {
    const y = 0.47 + shift + i * 0.066,
      h = 0.055,
      x = left - 0.1;
    ctx.fillStyle = '#EAF7FF';
    ctx.beginPath();
    ctx.roundRect(x * width, y * height, (0.95 - x) * width, h * height, width * 0.024);
    ctx.fill();
    ctx.fillStyle = '#246BCE';
    ctx.beginPath();
    ctx.ellipse((left - 0.05) * width, (y + h / 2) * height, width * 0.046, h * height * 0.47, 0, 0, Math.PI * 2);
    ctx.fill();
    protections.push({ id: 'icon-' + (i + 1), x: left - 0.098, y: y + 0.002, w: 0.096, h: h - 0.004 });
  }
  return {
    bytes: canvas.toBuffer('image/png'),
    frame: { width, height, data: ctx.getImageData(0, 0, width, height).data },
    protections
  };
}
