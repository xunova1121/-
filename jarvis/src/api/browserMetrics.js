/**
 * 没有网关时（单文件版）的“本机指标”：浏览器能拿到的近似值，结构与 GET /api/local/metrics 相同。
 *   cpu      页面主线程繁忙度：这次读取时 100ms 定时器的延迟占比（主线程越忙，定时器越晚触发）
 *   memory   JS 堆占用（仅 Chromium 有 performance.memory），否则为 null
 *   network  navigator.onLine 与 Network Information API 估计的下行带宽
 */
function sampleLag(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('已取消采样', 'AbortError'));
    const start = performance.now();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve(Math.max(0, performance.now() - start - 100));
    }, 100);
    function abort() {
      clearTimeout(timer);
      reject(new DOMException('已取消采样', 'AbortError'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function browserMetrics(signal) {
  const lag = await sampleLag(signal);
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
