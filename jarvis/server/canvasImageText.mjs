/** 原生库隔离到可杀死的子进程；不在线程间共享Skia字体状态，原生故障不拖垮服务器。 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPosterFonts } from './posterRaster.mjs';
import { canvasFontFiles } from './canvasFontFile.mjs';
import { canvasFontRequest } from '../src/agent/imageTextRaster.js';
import { canvasError } from '../src/agent/imageTextInput.js';
import { throwControl } from '../src/core/networkRequest.js';
let active = 0;
async function work(blob, data, signal) {
  throwControl(null, signal);
  if (active >= 2) throw canvasError('填字处理繁忙，请稍后再试', 'CANVAS_BUSY');
  active++;
  try {
    const bytes = await blob.arrayBuffer();
    if (bytes.byteLength > (data.action === 'svg' ? 16e6 : 10e6)) throw canvasError(data.action === 'svg' ? '场景超过16MB' : '原图超过10MB');
    return await new Promise((resolve, reject) => {
      const script = fileURLToPath(new URL('./canvasImageTextWorker.mjs', import.meta.url)).replace(
        /\.asar([\\/])/,
        '.asar.unpacked$1'
      );
      const worker = fork(script, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        windowsHide: true,
        ...(process.versions.electron && { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }),
        execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type'))
      });
      let ended = false;
      const finish = (error, result) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        worker.kill('SIGKILL');
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => finish(signal.reason || new DOMException('停止', 'AbortError'));
      const timer = setTimeout(() => finish(canvasError('Canvas填字超时', 'CANVAS_TIMEOUT')), 20000);
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', (result) =>
        finish(result.error ? canvasError('Canvas无法解码原图或加载已核验字体', 'CANVAS_RENDER_FAILED') : null, result)
      );
      worker.once('error', () => finish(canvasError('Canvas进程未完成', 'CANVAS_RENDER_FAILED')));
      worker.once('exit', () => {
        if (!ended) finish(canvasError('Canvas进程提前结束', 'CANVAS_RENDER_FAILED'));
      });
      if (signal?.aborted) abort();
      else
        worker.send({ ...data, bytes }, (error) => {
          if (error) finish(canvasError('Canvas进程启动失败', 'CANVAS_RENDER_FAILED'));
        });
    });
  } finally {
    active--;
  }
}
export const inspectCanvasImage = (blob, { signal } = {}) => work(blob, { action: 'inspect' }, signal);
/** 只供已校验场景的内部渲染入口使用，字体、取消与子进程隔离沿用现有机制。 */
export async function renderCanvasSvg(svg, family, { signal } = {}) {
  const fonts = await canvasFontFiles(family, signal);
  return work(new Blob([svg]), { action: 'svg', family, fonts }, signal);
}
export async function renderCanvasImageText(blob, design, { signal } = {}) {
  const fontCheck = await checkPosterFonts(canvasFontRequest(design), { signal });
  const fonts = await canvasFontFiles(fontCheck.family, signal);
  const result = await work(blob, { action: 'render', design, family: fontCheck.family, fonts }, signal);
  return {
    ...result,
    ...(result.bytes && { blob: new Blob([result.bytes], { type: 'image/png' }) }),
    ...(result.previewBytes && { previewBlob: new Blob([result.previewBytes], { type: 'image/png' }) }),
    fontCheck: { ...fontCheck, method: 'fontconfig-charset+native-face' }
  };
}
export const serverCanvasRenderer = { inspect: inspectCanvasImage, render: renderCanvasImageText };
