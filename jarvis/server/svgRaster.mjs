import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateSvg } from '../src/agent/svgPreview.js';
import { throwControl } from '../src/core/networkRequest.js';
/** 与旧图片备用路径同尺寸，但SVG直接栅格化到目标，不能先低分辨率解码再放大模糊像素。 */
export function svgRasterDimensions(width, height) {
  const factor = Math.min(3, 2048 / width, 2048 / height);
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}
export async function rasterizeSvg(svg, { signal } = {}) {
  const checked = validateSvg(svg);
  throwControl(null, signal);
  const size = svgRasterDimensions(checked.width, checked.height);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-svg-raster-'));
  try {
    await writeFile(path.join(directory, 'source.svg'), checked.svg);
    throwControl(null, signal);
    return await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-max_alloc', '67108864', '-max_pixels', '25000000', '-threads', '1', '-width', String(size.width), '-height', String(size.height), '-keep_ar', '1', '-i', 'source.svg', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { cwd: directory, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = []; let count = 0; let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); }
      else resolve(new Blob(chunks, { type: 'image/png' }));
    };
    const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(Object.assign(new Error('SVG栅格化超时'), { code: 'SVG_RENDER_TIMEOUT', kind: 'timeout' })), 10000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', finish);
    child.stdout.on('data', chunk => { count += chunk.length; if (count > 12e6) finish(Object.assign(new Error('SVG图片超过12MB'), { code: 'SVG_RENDER_SIZE', kind: 'input' })); else chunks.push(chunk); });
    child.on('close', code => finish(code || !count ? Object.assign(new Error('SVG直接栅格化失败'), { code: 'SVG_RENDER', kind: 'api' }) : null));
    if (signal?.aborted) abort();
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  }
}
