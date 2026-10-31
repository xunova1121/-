/**
 * 文字识别（OCR）：把图片、扫描版 PDF 里的字和表格原样抄出来（Markdown）。
 *
 *   用谁    能力表“文字识别”那一项（见 abilities.js），目前只认智谱 GLM-OCR
 *   接口    智谱“文档解析” POST {接口地址}/layout_parsing，{ model, file }；file 用 base64（data: 开头）
 *           结果在 md_results（字段名来自智谱文档，未用真 Key 核对）
 *   和看图的区别：看图模型看懂画面、回答问题；OCR 只抄字，大段文字、复杂表格更准、更便宜
 */
import { abilityLines, cfgForLine } from './abilities.js';
import { providerEndpoint } from './images.js';

export const OCR_LIMITS = { maxBytes: 10 * 1024 * 1024, timeoutMs: 90_000, maxChars: 60_000 };

/** 这份配置能不能做文字识别（返回用哪条线路） */
export function ocrLine(cfg) {
  const line = abilityLines(cfg, 'ocr').main;
  return line?.provider === 'zhipu' ? line : null;
}

const toBase64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * @param {object} cfg
 * @param {{ blob?: Blob, mime?: string, data?: string }} file  文件（Blob），或已有的 base64（data + mime）
 * @returns {Promise<{ text: string, model: string }>}
 */
export async function recognizeText(cfg, file, { gateway = null, fetchImpl = globalThis.fetch, signal } = {}) {
  const line = ocrLine(cfg);
  if (!line) throw Object.assign(new Error('还没有能做文字识别的服务商：在模型页填上智谱的 Key（会自动用 GLM-OCR）'), { code: 'OCR_UNAVAILABLE', kind: 'api' });
  const mime = file.mime || file.blob?.type || 'image/png';
  if (file.blob && file.blob.size > OCR_LIMITS.maxBytes) throw Object.assign(new Error('文件超过 10MB，先压缩或分页再识别'), { kind: 'api' });
  const data = file.data ?? (await toBase64(file.blob));
  const { base, headers } = providerEndpoint(cfgForLine(cfg, line), gateway);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OCR_LIMITS.timeoutMs);
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  let res;
  try {
    res = await fetchImpl(`${base}/layout_parsing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ model: line.model, file: `data:${mime};base64,${data}` }),
      signal: ctrl.signal
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw Object.assign(new Error(ctrl.signal.aborted ? '文字识别超时（90 秒没回应）' : '连不上文字识别服务'), { kind: ctrl.signal.aborted ? 'timeout' : 'network', cause: e });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
  const raw = await res.text();
  let j = {};
  try {
    j = JSON.parse(raw);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) throw Object.assign(new Error(`文字识别失败（${line.model}，HTTP ${res.status}）：${String(j.error?.message || j.message || raw).slice(0, 200)}`), { status: res.status, kind: 'api' });
  const md = j.md_results ?? j.data?.md_results ?? j.result?.md_results ?? '';
  const text = (Array.isArray(md) ? md.join('\n\n') : String(md || '')).trim();
  if (!text) throw Object.assign(new Error(`文字识别没有返回内容（${line.model}）`), { kind: 'api' });
  return { text: text.slice(0, OCR_LIMITS.maxChars), model: line.model };
}
