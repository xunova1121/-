/**
 * 没有网关时（单文件版）的“本机指标”：浏览器能拿到的近似值，结构与 GET /api/local/metrics 相同。
 *   cpu      页面主线程繁忙度：100ms 定时器的平均延迟占比（主线程越忙，定时器越晚触发）
 *   memory   JS 堆占用（仅 Chromium 有 performance.memory），否则为 null
 *   network  navigator.onLine 与 Network Information API 估计的下行带宽
 */
let lagSamples = [];
let timer = 0;
let last = 0;

function startSampler() {
  if (timer) return;
  last = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    lagSamples.push(Math.max(0, now - last - 100));
    if (lagSamples.length > 30) lagSamples.shift();
    last = now;
  }, 100);
}

export async function browserMetrics() {
  startSampler();
  const lag = lagSamples.length ? lagSamples.reduce((a, b) => a + b, 0) / lagSamples.length : 0;
  const mem = performance.memory;
  const conn = navigator.connection;
  const downKBps = conn?.downlink ? Math.round(conn.downlink * 125) : null;
  return {
    source: 'browser',
    time: new Date().toISOString(),
    cpu: { percent: Math.min(100, Math.round((lag / 100) * 1000) / 10) },
    memory: mem
      ? {
        percent: Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 1000) / 10,
        usedMB: Math.round(mem.usedJSHeapSize / 2 ** 20),
        totalMB: Math.round(mem.jsHeapSizeLimit / 2 ** 20)
      }
      : { percent: null },
    network: { online: navigator.onLine, rxKBps: downKBps, txKBps: 0 }
  };
}
