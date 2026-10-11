/**
 * 人脸 Worker 的出站网络守卫。
 *
 * MediaPipe Tasks 会无条件创建一个使用统计上报器，定期 POST 到 odml.pa.googleapis.com/v1/log
 * （内容是任务类型、运行模式、耗时统计，不含画面，但仍属于数据外发，且没有公开的关闭选项）。
 * 需求 5.3 承诺“人脸检测在本机完成”，所以在 Worker 里只放行 GET（下载 WASM / 模型），
 * 其余一律拒绝。上报器失败后会自行停掉定时器，不再重试。
 */
const realFetch = self.fetch.bind(self);

self.fetch = (input, init = {}) => {
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return Promise.reject(new TypeError(`[face worker] 已拦截出站 ${method} 请求`));
  }
  return realFetch(input, init);
};

if (self.XMLHttpRequest) {
  const open = self.XMLHttpRequest.prototype.open;
  self.XMLHttpRequest.prototype.open = function (method, ...rest) {
    if (!/^(GET|HEAD)$/i.test(method)) throw new TypeError(`[face worker] 已拦截出站 ${method} 请求`);
    return open.call(this, method, ...rest);
  };
}
if (self.navigator?.sendBeacon) self.navigator.sendBeacon = () => false;
