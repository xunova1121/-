/**
 * 本机指标轮询（需求 7.2）：页面可见时每 3 秒一次，隐藏时暂停。
 * 数据只用于仪表展示，不反馈到渲染参数。
 */
import { API } from '../config.js';

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
      const res = await fetch(this.url, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.onData?.(await res.json());
    } catch (err) {
      if (err.name !== 'AbortError') this.onError?.(err);
    } finally {
      if (this.inflight === ctrl) this.inflight = null;
    }
    if (this.running) this.timer = setTimeout(() => this.#poll(), this.interval);
  }
}
