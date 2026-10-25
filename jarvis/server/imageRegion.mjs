import { spawn } from 'node:child_process';
import { visualRegion } from '../src/agent/imageRegion.js';

let active = 0;
/** 可选系统ffmpeg，仅接受有界图片和归一化坐标；无任意参数/路径，不联网，最多并发2次。 */
export async function cropImageRegion(blob, value, { signal } = {}) {
  const region = visualRegion(value);
  if (!region) return blob;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (blob.size > 10e6) throw Object.assign(new Error('图片超过10MB'), { code: 'IMAGE_SIZE', kind: 'input' });
  if (active >= 2) throw Object.assign(new Error('图片裁剪繁忙，请稍后重试'), { code: 'IMAGE_CROP_BUSY', kind: 'api' });
  active++;
  try {
    const input = new Uint8Array(await blob.arrayBuffer());
    return await new Promise((resolve, reject) => {
      const filter = `crop=iw*${region.width}:ih*${region.height}:iw*${region.x}:ih*${region.y},scale=w='min(2048,iw*3)':h='min(2048,ih*3)':force_original_aspect_ratio=decrease`;
      const child = spawn('ffmpeg', ['-v', 'error', '-max_alloc', '67108864', '-max_pixels', '25000000', '-threads', '1', '-i', 'pipe:0', '-vf', filter, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let settled = false;
      let size = 0;
      const chunks = [];
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) { child.kill('SIGKILL'); reject(error); }
        else resolve(new Blob(chunks, { type: 'image/png' }));
      };
      const abort = () => finish(new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(() => finish(Object.assign(new Error('图片裁剪超时'), { code: 'IMAGE_CROP_TIMEOUT', kind: 'timeout' })), 10000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      child.on('error', error => finish(Object.assign(new Error('服务器未提供可用的图片裁剪环境'), { code: error.code === 'ENOENT' ? 'IMAGE_CROP_UNAVAILABLE' : 'IMAGE_CROP', kind: 'capability' })));
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 12e6) finish(Object.assign(new Error('裁剪结果超过12MB'), { code: 'IMAGE_SIZE', kind: 'input' }));
        else chunks.push(chunk);
      });
      child.on('close', code => finish(code || !size ? Object.assign(new Error('图片无法解码或裁剪'), { code: 'IMAGE_CROP', kind: 'api' }) : null));
      child.stdin.end(input);
    });
  } finally {
    active--;
  }
}
