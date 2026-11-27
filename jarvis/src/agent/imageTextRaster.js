/** 浏览器/桌面/安卓直接Canvas排字；不创建SVG，也不调用生图或清晰化。 */
import { checkBrowserPosterFonts, posterWait } from './posterFonts.js';
import { createImageTextEngine } from './imageTextEngine.js';
import { throwControl } from '../core/networkRequest.js';
import { canvasError } from './imageTextInput.js';

export const canvasFamilies = (family) =>
  family === 'serif'
    ? ['Noto Serif CJK SC', 'SimSun', 'Songti SC', 'Noto Serif SC', 'Source Han Serif SC']
    : [
        'Noto Sans CJK SC',
        'Microsoft YaHei',
        'PingFang SC',
        'Noto Sans SC',
        'Source Han Sans SC',
        'Droid Sans Fallback'
      ];
export const canvasFontRequest = (design) => ({
  text: design.entries.map((e) => e.title + e.body).join('\n'),
  families: canvasFamilies(design.fontFamily),
  weights: ['400', '700']
});

async function browserImage(blob, signal) {
  throwControl(null, signal);
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function')
    throw canvasError('当前环境缺少Canvas图片解码能力', 'CANVAS_UNAVAILABLE');
  return posterWait(createImageBitmap(blob), signal);
}
export async function inspectCanvasImage(blob, { signal } = {}) {
  const image = await browserImage(blob, signal),
    canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, 768 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      width: image.width,
      height: image.height,
      frame: {
        width: canvas.width,
        height: canvas.height,
        data: context.getImageData(0, 0, canvas.width, canvas.height).data
      }
    };
  } finally {
    image.close();
    canvas.width = canvas.height = 0;
  }
}
export async function renderCanvasImageText(blob, design, { signal } = {}) {
  throwControl(null, signal);
  const fontCheck = await checkBrowserPosterFonts(canvasFontRequest(design), { signal });
  const image = await browserImage(blob, signal),
    canvas = document.createElement('canvas');
  try {
    canvas.width = design.width;
    canvas.height = design.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, design.width, design.height);
    const engine = createImageTextEngine();
    const before = context.getImageData(0, 0, design.width, design.height).data;
    const layout = engine.colorRows(context, design, engine.plan(context, design, fontCheck.family), before);
    throwControl(null, signal);
    if (!engine.paint(context, layout, fontCheck.family)) return { layout, fontCheck };
    const backgroundCheck = engine.verifyBackground(
      before,
      context.getImageData(0, 0, design.width, design.height).data,
      design,
      layout
    );
    const png = await posterWait(new Promise((resolve) => canvas.toBlob(resolve, 'image/png')), signal);
    if (!png) throw canvasError('Canvas未返回PNG', 'CANVAS_RENDER_FAILED');
    const preview = document.createElement('canvas');
    preview.width = layout.previewWidth;
    preview.height = Math.ceil((design.height * preview.width) / design.width);
    preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
    const previewBlob = await posterWait(new Promise((resolve) => preview.toBlob(resolve, 'image/png')), signal);
    preview.width = preview.height = 0;
    return { blob: png, previewBlob, layout, fontCheck, backgroundCheck };
  } finally {
    image.close();
    canvas.width = canvas.height = 0;
  }
}
export const browserCanvasRenderer = { inspect: inspectCanvasImage, render: renderCanvasImageText };
