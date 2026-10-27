import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderOffice } from './officeRender.mjs';
import { comparePng, pngPixels } from '../src/agent/diagramPng.js';
import { throwControl } from '../src/core/networkRequest.js';

let active = 0;
/** 可编辑PPT必须经真实Office→PDF→PNG后与共享PNG比较；缺环境只返回未核实。 */
export async function compareDiagramPpt(pptx, reference, { signal } = {}) {
  throwControl(null, signal);
  if (active >= 2) return { passed: false, state: 'not_checked', note: '图形对照繁忙' };
  active++;
  let directory;
  try {
    const dimensions = await pngPixels(reference);
    const resolution = String(Math.max(dimensions.width, dimensions.height));
    const pdf = await renderOffice(pptx, 'pptx', { signal });
    if (!pdf.available) return { passed: false, state: 'not_checked', note: pdf.reason };
    directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-diagram-compare-'));
    await writeFile(path.join(directory, 'slide.pdf'), new Uint8Array(await pdf.blob.arrayBuffer()));
    await new Promise((resolve, reject) => {
      const child = spawn('pdftoppm', ['-singlefile', '-f', '1', '-scale-to', resolution, '-png', 'slide.pdf', 'slide'], { cwd: directory, stdio: 'ignore' });
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) {
          child.kill('SIGKILL');
          reject(error);
        } else resolve();
      };
      const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(() => finish(Object.assign(new Error('PPT渲染比较超时'), { code: 'DIAGRAM_COMPARE_TIMEOUT', kind: 'timeout' })), 20000);
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', finish);
      child.on('close', (code) => finish(code ? Object.assign(new Error('PDF渲染未完成'), { code: 'DIAGRAM_COMPARE', kind: 'api' }) : null));
      if (signal?.aborted) abort();
    });
    if ((await stat(path.join(directory, 'slide.png'))).size > 12e6)
      throw Object.assign(new Error('PPT对照图片超过12MB'), { code: 'DIAGRAM_SIZE', kind: 'input' });
    const rendered = new Blob([await readFile(path.join(directory, 'slide.png'))], { type: 'image/png' });
    const difference = await comparePng(reference, rendered);
    return { ...difference, state: difference.passed ? 'render_compared' : 'mismatch', note: '均值像素通道差≤1.2%、宽高比差<0.01才通过；不是业务内容验收' };
  } catch (error) {
    throwControl(error, signal);
    return { passed: false, state: 'not_checked', code: error.code || error.name, note: '未完成真实PPT对照，不能声称各格式一致' };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    active--;
  }
}
