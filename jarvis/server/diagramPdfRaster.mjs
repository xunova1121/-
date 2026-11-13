import { spawn } from 'node:child_process';
import { throwControl } from '../src/core/networkRequest.js';

/** 固定Cairo引擎；只有二进制不存在时兼容旧Poppler，不按比较结果轮换引擎。 */
export async function rasterizeDiagramPdf(directory, resolution, { signal, spawnImpl = spawn } = {}) {
  if (!/^\d+$/.test(String(resolution)) || Number(resolution) < 1 || Number(resolution) > 2048)
    throw Object.assign(new Error('架构对照栅格长边需1～2048像素'), { code: 'DIAGRAM_COMPARE_RESOLUTION', kind: 'input' });
  try {
    await render('pdftocairo', directory, String(resolution), signal, spawnImpl);
    return 'pdftocairo';
  } catch (error) {
    throwControl(error, signal);
    if (error.code !== 'ENOENT') throw error;
    await render('pdftoppm', directory, String(resolution), signal, spawnImpl);
    return 'pdftoppm';
  }
}

function render(engine, directory, resolution, signal, spawnImpl) {
  throwControl(null, signal);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(engine, ['-singlefile', '-f', '1', '-scale-to', resolution, '-png', 'slide.pdf', 'slide'], { cwd: directory, stdio: 'ignore' });
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        child.kill('SIGKILL');
        reject(Object.assign(error, { rasterEngine: engine }));
      } else resolve();
    };
    const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(Object.assign(new Error('PPT渲染比较超时'), { code: 'DIAGRAM_COMPARE_TIMEOUT', kind: 'timeout' })), 20000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', finish);
    child.on('close', code => finish(code ? Object.assign(new Error('PDF渲染未完成'), { code: 'DIAGRAM_COMPARE', kind: 'api' }) : null));
    if (signal?.aborted) abort();
  });
}
