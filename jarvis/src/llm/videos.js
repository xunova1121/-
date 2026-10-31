/**
 * 生成视频：视频模型（sora / veo / kling / 海螺 / seedance…）都是“提交任务 → 轮询进度 → 下载成片”。
 * 先按 OpenAI 的 /videos 接口提交；中转站不支持（404 / 405）时改用中转站常见的 /video/generations。
 * 视频模型和聊天模型分开，不能用来对话。
 */
import { modelKind, providerEndpoint } from './images.js';

/** 用哪个视频模型：用户选过的 → 模型列表里的视频模型（优先 sora / veo） */
export function videoModelOf(cfg) {
  if (cfg.videoModel) return cfg.videoModel;
  const vids = Object.values(cfg.modelLists || {}).flatMap((l) => l.ids || []).filter((id) => modelKind(id) === 'video');
  return vids.find((id) => /sora/.test(id)) || vids.find((id) => /veo/.test(id)) || vids[0] || '';
}

const pick = (j, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), j);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};
const DONE = /^(completed|succeeded|success|succeed|finished|done)$/i;
const FAILED = /^(failed|failure|error|cancelled|canceled|expired)$/i;

/** 从任务回应里读出：状态、进度、成片地址、失败原因（兼容 OpenAI 和几种中转站格式） */
export function readTask(j) {
  const status = String(pick(j, 'status', 'data.status', 'task_status', 'data.task_status', 'state', 'data.state') || '');
  const url = pick(j, 'url', 'video_url', 'data.url', 'data.video_url', 'output.url', 'output.video_url', 'data.output.url',
    'result.url', 'result.video_url', 'data.result.url', 'data.result.video_url', 'result_url', 'data.0.url', 'videos.0.url', 'data.videos.0.url');
  const err = pick(j, 'error.message', 'error', 'fail_reason', 'data.fail_reason', 'message', 'data.error');
  const progress = Number(pick(j, 'progress', 'data.progress'));
  return {
    id: pick(j, 'id', 'task_id', 'data.task_id', 'data.id'),
    done: DONE.test(status) || (Boolean(url) && !FAILED.test(status) && typeof url === 'string'),
    failed: FAILED.test(status),
    url: typeof url === 'string' ? url : '',
    error: typeof err === 'string' ? err : err ? JSON.stringify(err) : '',
    progress: Number.isFinite(progress) ? Math.round(progress > 0 && progress <= 1 ? progress * 100 : progress) : null,
    status
  };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

async function call(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  return { res, j, text };
}

/**
 * @param {object} cfg 模型设置
 * @param {{ prompt: string, seconds?: number, size?: string, gateway?: object|null, fetchImpl?: typeof fetch, signal?: AbortSignal,
 *   onProgress?: (text: string) => void, pollMs?: number, timeoutMs?: number }} o
 * @returns {Promise<{ blob: Blob, model: string }>}
 */
export async function generateVideo(cfg, { prompt, seconds, size, gateway = null, fetchImpl = globalThis.fetch, signal, onProgress, pollMs = 5000, timeoutMs = 15 * 60e3 } = {}) {
  const { base, headers } = providerEndpoint(cfg, gateway);
  const model = videoModelOf(cfg);
  if (!model) throw new Error('还没有视频模型：点输入框里的模型名，在“视频模型”里选一个（服务商的模型列表里要有 sora / veo / kling 之类的模型）');
  const json = { 'Content-Type': 'application/json', ...headers };
  const body = { model, prompt, ...(seconds && { seconds: String(seconds), duration: Number(seconds) }), ...(size && { size }) };

  // 1) OpenAI 格式；2) 中转站格式
  let style = 'openai';
  let r = await call(fetchImpl, `${base}/videos`, { method: 'POST', headers: json, body: JSON.stringify(body), signal });
  if (r.res.status === 404 || r.res.status === 405) {
    style = 'relay';
    r = await call(fetchImpl, `${base}/video/generations`, { method: 'POST', headers: json, body: JSON.stringify(body), signal });
  }
  if (!r.res.ok) throw new Error(`生成视频失败（${model}，HTTP ${r.res.status}）：${String(readTask(r.j).error || r.text).slice(0, 200)}`);

  let task = readTask(r.j);
  const statusURL = (id) => (style === 'openai' ? `${base}/videos/${encodeURIComponent(id)}` : `${base}/video/generations/${encodeURIComponent(id)}`);
  const t0 = Date.now();
  onProgress?.('已提交，视频生成一般要一到几分钟…');
  while (!task.done) {
    if (task.failed) throw new Error(`生成视频失败（${model}）：${task.error || task.status}`);
    if (!task.id) throw new Error(`生成视频失败：服务商没有返回任务编号（${model}）`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`生成视频超过 ${Math.round(timeoutMs / 60e3)} 分钟还没完成，任务编号 ${task.id}，可以稍后再问我结果`);
    await sleep(pollMs, signal);
    const id = task.id;
    const p = await call(fetchImpl, statusURL(id), { headers, signal });
    if (!p.res.ok && p.res.status < 500) throw new Error(`查询视频进度失败（HTTP ${p.res.status}）：${String(readTask(p.j).error || p.text).slice(0, 200)}`);
    if (!p.res.ok) continue; // 中转站临时故障：下一轮再查
    task = { ...readTask(p.j), id: readTask(p.j).id || id };
    const secs = Math.round((Date.now() - t0) / 1000);
    onProgress?.(`生成中${task.progress !== null ? ` ${task.progress}%` : ''} · 已等 ${secs} 秒`);
  }

  onProgress?.('生成完成，正在下载…');
  const url = task.url || (style === 'openai' ? `${base}/videos/${encodeURIComponent(task.id)}/content` : '');
  if (!url) throw new Error(`生成视频完成，但服务商没有返回视频地址（${model}）`);
  const own = url.startsWith(base);
  const v = await fetchImpl(url, { ...(own && { headers }), signal });
  if (!v.ok) throw new Error(`下载生成的视频失败（HTTP ${v.status}）`);
  const blob = await v.blob();
  return { blob: blob.type.startsWith('video/') ? blob : new Blob([blob], { type: 'video/mp4' }), model };
}
