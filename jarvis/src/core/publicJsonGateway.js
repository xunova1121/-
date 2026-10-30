/** 公开JSON永远走匿名直读网关，不能因域名前缀复用模型/搜索/绘图的鉴权代理。 */
export function publicJsonGatewayFetch(url, init = {}, fetchImpl = (...args) => fetch(...args)) {
  return fetchImpl(`/api/fetch?url=${encodeURIComponent(url)}&publicJson=1`, {
    method: 'GET',
    credentials: 'omit',
    signal: init.signal
  });
}
