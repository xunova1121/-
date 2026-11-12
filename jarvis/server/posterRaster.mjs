import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { POSTER_LIMITS, validatePosterSvg, posterGlyphs, lockPosterFont, posterError } from '../src/agent/posterSvg.js';
import { imageInfo } from '../src/agent/imageInfo.js';
import { throwControl } from '../src/core/networkRequest.js';

let active = 0;

/** 固定命令和参数；不接收路径、URL或shell。每个子进程有超时、输出上限及取消。 */
function execute(command, args, { signal, input, cwd, spawnImpl = spawn, maxBytes = POSTER_LIMITS.outputBytes, timeout = 15000 } = {}) {
  throwControl(null, signal);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let ended = false, count = 0;
    const chunks = [];
    const finish = error => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); }
      else resolve(Buffer.concat(chunks));
    };
    const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(posterError('海报渲染超时', 'POSTER_RENDER_TIMEOUT', 'timeout')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', finish);
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      if (ended) return;
      count += chunk.length;
      if (count > maxBytes) finish(posterError('海报渲染输出超过限额', 'POSTER_RENDER_SIZE', 'api'));
      else chunks.push(chunk);
    });
    child.on('close', (code, terminationSignal) => finish(code !== 0 || terminationSignal || !count ? posterError('海报渲染进程失败', 'POSTER_RENDER', 'api') : null));
    if (signal?.aborted) return abort();
    child.stdin.end(input);
  });
}

export function fontCharsetCovers(charset, glyphs) {
  const ranges = String(charset).trim().split(/\s+/).map(value => value.split('-').map(hex => Number.parseInt(hex, 16)));
  return glyphs.every(ch => {
    const point = ch.codePointAt(0);
    return ranges.some(([first, last = first]) => Number.isFinite(first) && point >= first && point <= last);
  });
}

/** fc-match可能悄悄替换缺失字体，所以同时核对真实family及全文字形覆盖，不只检测lang=zh。 */
export async function checkPosterFonts(checked, { signal, run = execute } = {}) {
  const glyphs = posterGlyphs(checked.text);
  let found = false;
  for (const family of checked.families) {
    let covered = true;
    for (const svgWeight of checked.weights) {
      const weight = { 100: '0', 200: '40', 300: '50', 400: '80', 500: '100', 600: '180', 700: '200', 800: '205', 900: '210' }[svgWeight];
      throwControl(null, signal);
      let output;
      try {
        output = String(await run('fc-match', ['-f', '%{family}\n%{charset}\n', `${family}:weight=${weight}`], { signal, maxBytes: 128000, timeout: 3000 }));
      } catch (error) {
        throwControl(error, signal);
        if (error.code === 'ENOENT') throw posterError('缺少fontconfig，无法验证海报中文字体；未输出最终PNG', 'POSTER_FONT_CHECK_UNAVAILABLE', 'capability');
        throw error;
      }
      const [actualFamily, charset] = output.split('\n');
      if (!actualFamily?.split(',').map(value => value.trim()).includes(family)) { covered = false; break; }
      found = true;
      if (!fontCharsetCovers(charset, glyphs)) { covered = false; break; }
    }
    if (covered) return { status: 'passed', family, method: 'fontconfig-charset', glyphCount: glyphs.length };
  }
  throw posterError(found ? '现有中文字体不能覆盖海报全文，需安装支持所用字符的字体；未输出最终PNG' : '缺少海报所需中文字体，请安装Noto Sans/Serif CJK SC；未输出最终PNG', found ? 'POSTER_FONT_GLYPHS_MISSING' : 'POSTER_FONT_MISSING', 'capability');
}

async function renderPixels(svg, checked, { signal, spawnImpl }) {
  try {
    return await execute('rsvg-convert', ['--format=png', `--width=${checked.width}`, `--height=${checked.height}`], { signal, input: svg, spawnImpl });
  } catch (error) {
    throwControl(error, signal);
    if (error.code !== 'ENOENT') throw error;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-poster-'));
  try {
    throwControl(null, signal);
    await writeFile(path.join(directory, 'source.svg'), svg);
    return await execute('ffmpeg', ['-v', 'error', '-max_alloc', '67108864', '-max_pixels', String(POSTER_LIMITS.pixels), '-threads', '1', '-width', String(checked.width), '-height', String(checked.height), '-keep_ar', '1', '-i', 'source.svg', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { signal, cwd: directory, spawnImpl });
  } catch (error) {
    throwControl(error, signal);
    if (error.code === 'ENOENT') throw posterError('服务器缺少rsvg-convert和ffmpeg，无法导出最终海报PNG', 'POSTER_RENDER_UNAVAILABLE', 'capability');
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  }
}

/** 独立的海报内部入口，最多两并发；无Office缩放降级，PNG尺寸必须逐字节核对。 */
export async function renderPoster(svg, { signal, spawnImpl = spawn, fontProbe = checkPosterFonts } = {}) {
  throwControl(null, signal);
  const checked = validatePosterSvg(svg);
  if (active >= 2) throw posterError('海报渲染繁忙，请稍后再试', 'POSTER_RENDER_BUSY', 'api');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(posterError('海报渲染超时', 'POSTER_RENDER_TIMEOUT', 'timeout')), 20000);
  const renderSignal = controller.signal;
  active++;
  try {
    const fontCheck = await fontProbe(checked, { signal: renderSignal });
    throwControl(null, renderSignal);
    const bytes = await renderPixels(lockPosterFont(checked.svg, fontCheck.family), checked, { signal: renderSignal, spawnImpl });
    throwControl(null, renderSignal);
    const actual = imageInfo(bytes);
    const complete = bytes.length >= 67 && bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
    if (!complete || actual?.type !== 'png' || actual.width !== checked.width || actual.height !== checked.height)
      throw posterError('海报渲染结果不是原尺寸PNG，未登记为完成', 'POSTER_RENDER_INVALID', 'api');
    return { blob: new Blob([bytes], { type: 'image/png' }), fontCheck, width: actual.width, height: actual.height };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    active--;
  }
}
