import { isPrivateHost } from '../../shared/providers.js';

/** 只在调用方所属工具实例内合并公网只读请求，不落盘、不跨账号/凭据/来源配置共享。 */
export function publicPageTtl(address) {
  try {
    const url = new URL(address);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || isPrivateHost(url.hostname) ||
      /\.(?:local|internal)\.?$/i.test(url.hostname) || !url.hostname.includes('.') ||
      /token|secret|key|auth|session|password|signature|credential/i.test(url.search) ||
      /\/(?:api|private|account|user|member|login|session|files?)(?:\/|$)/i.test(url.pathname)) return 0;
    if (/live|quote|weather|score|realtime|current|latest/i.test(url.pathname)) return 15_000;
    if (/\/$|index\.|\/search|\/list|\/news$/i.test(url.pathname) || url.search) return 60_000;
    return 15 * 60_000;
  } catch { return 0; }
}

const aborted = signal => signal?.reason || Object.assign(new Error('已停止读取'), { name: 'AbortError' });

/** 最多60份正文/32个在途请求；取消只影响订阅者，全员取消才终止底层请求。 */
export function createPublicReadCache({ now = Date.now, maxRows = 60, maxChars = 60_000 } = {}) {
  const rows = new Map(), pending = new Map();
  return {
    async read(key, load, { signal, ttlMs = publicPageTtl(key), progress } = {}) {
      if (signal?.aborted) throw aborted(signal);
      if (!ttlMs) return load(signal);
      const hit = rows.get(key);
      if (hit && now() >= hit.at && now() - hit.at < ttlMs) return hit.text;
      rows.delete(key);
      let job = pending.get(key);
      if (!job) {
        if (pending.size >= 32) return load(signal);
        const controller = new AbortController();
        job = { controller, users: new Set(), settled: false, startedAt: now() };
        pending.set(key, job);
        job.promise = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw aborted(controller.signal);
          return load(controller.signal);
        }).then(text => {
          if (!controller.signal.aborted && typeof text === 'string' && text.length <= maxChars) {
            while (rows.size >= maxRows) rows.delete(rows.keys().next().value);
            // TTL从真正取数开始算，慢请求不能再凭完成时刻获得一整段新鲜期。
            rows.set(key, { text, at: job.startedAt });
          }
          return text;
        }).finally(() => {
          job.settled = true;
          if (pending.get(key) === job) pending.delete(key);
        });
        job.promise.catch(() => {});
      } else progress?.('正在读取同一公开来源');
      const subscriber = {};
      job.users.add(subscriber);
      return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener('abort', stop);
          job.users.delete(subscriber);
          if (!job.users.size && !job.settled) {
            if (pending.get(key) === job) pending.delete(key);
            job.controller.abort(aborted(signal));
          }
          if (error) reject(error); else resolve(value);
        };
        const stop = () => finish(aborted(signal));
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
        job.promise.then(value => finish(null, value), error => finish(error));
      });
    }
  };
}
