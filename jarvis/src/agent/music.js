/**
 * 唱歌：把歌词和曲风交给 fal.ai 上的 MiniMax 音乐模型，生成一首带人声和伴奏的歌，存进工作区。
 *
 *   - 走 fal 的排队接口：提交 → 隔几秒查一次状态 → 取结果里的音频地址 → 下载
 *   - 密钥只发给 queue.fal.run；状态、结果地址也必须在这个域名下（防止返回的地址把密钥带到别处）
 *   - 音频地址只认 https；下载时不带密钥
 *   - 按次收费（Music 2.0 约 0.03 美元一首，以 fal 页面为准）；填了 fal Key 就算同意，服务器模式不能弹确认框
 *   - 最多等 6 分钟；用户点停止立即结束
 *   - 国内服务器连 fal 不稳：查状态、取结果、下载时偶尔断一下就隔几秒重试（已经付了钱，不能因为一次断网整首作废）；
 *     提交不重试（可能已经提交成功，重试会重复扣费）
 *   - 每次请求都有等待上限：被拦时请求不报错、一直挂着，以前要等到“10 分钟没有进展”才中断
 */
import * as ws from './workspace.js';
import { sleep } from '../llm/openai.js';

export const MUSIC_MODEL = 'fal-ai/minimax-music/v2';
const QUEUE = 'https://queue.fal.run/';
export const MUSIC_LIMITS = { style: [10, 300], lyrics: [10, 3000], waitMs: 6 * 60_000, pollMs: 3000, maxBytes: 30 * 1024 * 1024, retries: 5, timeouts: { submit: 30_000, poll: 20_000, download: 90_000 } };

const failure = (message, extra = {}) => Object.assign(new Error(message), { kind: 'api', ...extra });

/** 曲风描述按接口要求截到 10～300 字 */
export function styleText(style) {
  let s = String(style ?? '').replace(/\s+/g, ' ').trim();
  if ([...s].length < MUSIC_LIMITS.style[0]) s = `${s ? `${s}，` : ''}流行歌曲，温柔女声`;
  return [...s].slice(0, MUSIC_LIMITS.style[1]).join('');
}

/** 状态、结果地址只认 fal 的排队域名：密钥只发给它 */
export function queueUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'queue.fal.run' ? u.href : null;
  } catch {
    return null;
  }
}

/** 结果里的音频地址（不同版本字段不完全一样） */
export function audioUrlOf(data) {
  const url = data?.audio?.url ?? data?.audio_file?.url ?? data?.output?.audio?.url ?? (typeof data?.audio === 'string' ? data.audio : null);
  try {
    return url && new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const reasonOf = (status) =>
  status === 401 || status === 403 ? 'fal Key 无效或没有权限' : status === 402 ? 'fal 账户余额不足' : status === 422 ? '歌词或曲风不符合接口要求' : status === 429 ? '请求太频繁，稍后再试' : '接口暂不可用';

/**
 * @param {{ falKey?: string, fetchViaGateway?: Function, fetchImpl?: Function, onFileChanged?: Function, onAudio?: Function, now?: () => number }} ctx
 */
export function createSongTool(ctx = {}) {
  const get = (url, init) => (ctx.fetchViaGateway ?? ctx.fetchImpl ?? globalThis.fetch)(url, init);
  const now = ctx.now ?? Date.now;

  /** fal 报错时带上它给的原因（如 422 说哪个字段不对），截短，不含密钥 */
  async function detailOf(res) {
    try {
      const text = await res.text();
      let d;
      try {
        d = JSON.parse(text)?.detail;
      } catch {
        d = text;
      }
      d = Array.isArray(d) ? d.map((x) => x?.msg ?? x).join('；') : typeof d === 'string' ? d : d ? JSON.stringify(d) : '';
      return d.replace(/\s+/g, ' ').trim().slice(0, 160);
    } catch {
      return '';
    }
  }

  /** 用户的停止信号 + 这次请求的等待上限 */
  function limited(signal, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms);
    const stop = () => ctrl.abort(signal.reason);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    return { signal: ctrl.signal, done: () => (clearTimeout(timer), signal?.removeEventListener('abort', stop)) };
  }

  /**
   * retries：断网、超时、fal 临时出错（5xx、429）时隔几秒再试几次
   * wait：这次请求（连同读完内容）最多等多久；read：怎么读内容（json / blob）
   */
  async function call(url, init, signal, { retries = 0, wait = MUSIC_LIMITS.timeouts.poll, read = (res) => res.json() } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      const limit = limited(signal, wait);
      try {
        res = await get(url, { ...init, signal: limit.signal });
        if (res.ok) return await read(res);
      } catch (e) {
        if (signal?.aborted) throw e;
        if (attempt < retries) {
          await sleep(MUSIC_LIMITS.pollMs * (attempt + 1), signal);
          continue;
        }
        const timedOut = limit.signal.aborted;
        throw failure(
          timedOut
            ? `连不上 fal.ai：等了 ${Math.round(wait / 1000)} 秒没有回应（fal 是海外服务，国内服务器访问常被拦）`
            : '连不上 fal.ai（海外服务，国内网络可能不稳定）',
          { kind: timedOut ? 'timeout' : 'network', cause: e }
        );
      } finally {
        limit.done();
      }
      if (attempt < retries && (res.status >= 500 || res.status === 429)) {
        await res.body?.cancel?.();
        await sleep(MUSIC_LIMITS.pollMs * (attempt + 1), signal);
        continue;
      }
      const detail = await detailOf(res);
      throw failure(`fal.ai：${reasonOf(res.status)}（${res.status}）${detail ? `：${detail}` : ''}`, { status: res.status });
    }
  }

  return {
    name: 'sing_song',
    description:
      '唱歌：把歌词谱成一首有人声、有伴奏的歌，保存到工作区并在对话里播放。用户让你唱歌、把写好的歌唱出来、给歌词配上音乐时使用。先在回答里写好歌词（用 [Verse] [Chorus] [Bridge] 标段落），再调用；style 按歌词的情景写：曲风、情绪、速度、主要乐器、人声（如“温柔女声，慢板钢琴民谣，治愈，夜晚”）。一首要一两分钟，按次收费。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '歌名（用作文件名）' },
        lyrics: { type: 'string', description: '完整歌词，用 [Verse] [Chorus] [Bridge] [Outro] 标段落，每句一行' },
        style: { type: 'string', description: '曲风描述：曲风、情绪、速度、乐器、人声，10～300 字' }
      },
      required: ['lyrics', 'style'],
      additionalProperties: false
    },
    run: async ({ title, lyrics, style }, { signal, progress } = {}) => {
      const key = String(ctx.falKey ?? '').trim();
      if (!key) throw failure('还没填 fal.ai 的 Key：设置 → 模型 → 唱歌（fal.ai）里填上后再试', { code: 'FAL_KEY_MISSING' });
      const words = String(lyrics ?? '').trim();
      if ([...words].length < MUSIC_LIMITS.lyrics[0]) throw failure('歌词太短，至少写几句');
      if ([...words].length > MUSIC_LIMITS.lyrics[1]) throw failure(`歌词太长（最多 ${MUSIC_LIMITS.lyrics[1]} 字），删短一些`);
      const auth = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };

      progress?.('正在提交给作曲模型…');
      const submitted = await call(QUEUE + MUSIC_MODEL, { method: 'POST', headers: auth, body: JSON.stringify({ prompt: styleText(style), lyrics_prompt: words }) }, signal, { wait: MUSIC_LIMITS.timeouts.submit });
      const statusUrl = queueUrl(submitted?.status_url);
      const resultUrl = queueUrl(submitted?.response_url);
      if (!statusUrl || !resultUrl) throw failure('fal.ai 返回的任务地址不对，已停止（不把密钥发到别的地址）');

      // 排队、生成：隔几秒查一次
      const started = now();
      for (;;) {
        const s = await call(statusUrl, { headers: { Authorization: auth.Authorization } }, signal, { retries: MUSIC_LIMITS.retries });
        if (s?.status === 'COMPLETED') break;
        if (s?.status && !['IN_QUEUE', 'IN_PROGRESS'].includes(s.status)) throw failure(`fal.ai 生成失败（${s.status}）`);
        if (now() - started > MUSIC_LIMITS.waitMs) throw failure('作曲超过 6 分钟还没好，先停下；可以稍后再试', { kind: 'timeout' });
        progress?.(s?.status === 'IN_QUEUE' ? `排队中${Number.isFinite(s.queue_position) ? `（前面还有 ${s.queue_position} 个）` : ''}…` : '正在作曲、演唱…');
        await sleep(MUSIC_LIMITS.pollMs, signal);
      }
      const data = await call(resultUrl, { headers: { Authorization: auth.Authorization } }, signal, { retries: MUSIC_LIMITS.retries });
      const audioUrl = audioUrlOf(data);
      if (!audioUrl) throw failure('fal.ai 的结果里没有音频地址');

      progress?.('正在下载歌曲…');
      const blob = await call(audioUrl, {}, signal, { retries: MUSIC_LIMITS.retries, wait: MUSIC_LIMITS.timeouts.download, read: (res) => res.blob() });
      if (!blob.size) throw failure('下载到的歌曲是空的');
      if (blob.size > MUSIC_LIMITS.maxBytes) throw failure('歌曲文件太大，没有保存');
      const ext = /wav/.test(blob.type) ? 'wav' : /flac/.test(blob.type) ? 'flac' : 'mp3';
      const name = String(title || words.split('\n').find((l) => l.trim() && !/^\[/.test(l.trim())) || '歌曲').replace(/[\\/:*?"<>|\s[\]]+/g, '').slice(0, 20) || '歌曲';
      const w = await ws.write(`音乐/${name}-${now().toString(36)}.${ext}`, blob.type ? blob : new Blob([blob], { type: 'audio/mpeg' }));
      ctx.onFileChanged?.(w.path);
      ctx.onAudio?.(URL.createObjectURL(blob), w.path);
      return `已经唱好了，保存在工作区 ${w.path}，对话里可以直接播放（fal.ai · MiniMax Music 2.0，这次按一次计费）。`;
    }
  };
}
