/**
 * 本机指标轮询（需求 7.2）：页面可见时每 3 秒一次，隐藏时暂停。
 * 数据只用于仪表展示，不反馈到渲染参数。
 */
import { API, STANDALONE } from '../config.js';
import { browserMetrics } from './browserMetrics.js';

export class MetricsPoller {
  constructor({ onData, onError, url = API.metrics, interval = API.metricsIntervalMs } = {}) {
    Object.assign(this, { onData, onError, url, interval });
    this.timer = 0;
    this.running = false;
    this.inflight = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#poll();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = 0;
    this.inflight?.abort();
    this.inflight = null;
  }

  async #poll() {
    if (!this.running) return;
    const ctrl = new AbortController();
    this.inflight = ctrl;
    try {
      // 单文件版没有网关：直接用浏览器能拿到的近似指标；网关连不上时同样回退
      if (STANDALONE || this.fallback) {
        this.onData?.(await browserMetrics());
      } else {
        const res = await fetch(this.url, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.onData?.({ source: 'server', ...(await res.json()) });
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.fallback = true;
        this.onError?.(err);
      }
    } finally {
      if (this.inflight === ctrl) this.inflight = null;
    }
    if (this.running) this.timer = setTimeout(() => this.#poll(), this.interval);
  }
}
