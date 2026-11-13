import { spawn } from 'node:child_process';
import { validateSvg } from '../src/agent/svgPreview.js';
import { imageFormat } from '../src/agent/imageFormat.js';
import { rasterizeSvg } from './svgRaster.mjs';
import { throwControl } from '../src/core/networkRequest.js';
import { renderOffice } from './officeRender.mjs';

let active = 0;
/** 只接受静态SVG子集，固定stdin/stdout参数；最多2并发、10秒、12MB输出。 */
export async function renderSvg(svg, { signal } = {}) {
  const checked = validateSvg(svg);
  throwControl(null, signal);
  if (active >= 2) throw Object.assign(new Error('SVG渲染繁忙'), { code: 'SVG_RENDER_BUSY', kind: 'api' });
  active++;
  try {
    let blob;
    try {
      blob = await runRenderer(checked, signal);
    } catch (error) {
      throwControl(error, signal);
      if (error.code !== 'ENOENT') throw error;
      try {
        blob = await rasterizeSvg(checked.svg, { signal });
      } catch (fallbackError) {
        throwControl(fallbackError, signal);
        // 复用原部署脚本已有的LibreOffice，不新增npm依赖或另装浏览器。
        const office = await renderOffice(new Blob([checked.svg], { type: 'image/svg+xml' }), 'svg', { signal });
        if (!office.available)
          throw Object.assign(new Error('服务器缺少rsvg-convert' + (fallbackError.code === 'SVG_RENDER_FFMPEG_MISSING' ? '、缺 ffmpeg' : '，ffmpeg备用栅格化失败') + '，LibreOffice也不可用；源文件已保留'), {
            code: 'SVG_RENDER_UNAVAILABLE',
            kind: 'capability',
            cause: fallbackError
          });
        blob = office.blob;
      }
    }
    if ((await imageFormat(blob))?.ext !== 'png') throw Object.assign(new Error('SVG渲染器未返回真正PNG'), { code: 'SVG_RENDER_INVALID', kind: 'api' });
    return blob;
  } finally {
    active--;
  }
}

function runRenderer(checked, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('rsvg-convert', ['--format=png', '--width=' + checked.width, '--height=' + checked.height], { stdio: ['pipe', 'pipe', 'ignore'] });
    let ended = false;
    let size = 0;
    const chunks = [];
    const finish = (error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(new Blob(chunks, { type: 'image/png' }));
    };
    const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(Object.assign(new Error('SVG渲染超时'), { code: 'SVG_RENDER_TIMEOUT', kind: 'timeout' })), 10000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', finish);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 12e6) finish(Object.assign(new Error('SVG预览超过12MB'), { code: 'SVG_RENDER_SIZE', kind: 'api' }));
      else chunks.push(chunk);
    });
    child.on('close', (code) => finish(code || !size ? Object.assign(new Error('SVG渲染进程失败'), { code: 'SVG_RENDER', kind: 'api' }) : null));
    if (signal?.aborted) return abort();
    child.stdin.end(checked.svg);
  });
}
