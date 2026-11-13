/** 仅代理固定DeepSeek工具端点：登录令牌与上游Key分开，断开时取消，正文有界。 */
import { webBody } from '../src/agent/webBody.js';

export async function proxyDeepseekTool(req, res, kind, { serverMode = false, fetchImpl = globalThis.fetch, json }) {
  if (req.method !== 'POST') return json(res, 405, { error: '只支持POST' });
  const key = serverMode ? String(req.headers['x-jarvis-search-key'] || '') : String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!key || key.length > 512) return json(res, 400, { error: '请配置DeepSeek官方搜索Key' });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  const timer = setTimeout(cancel, 10000);
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32768) return json(res, 413, { error: '搜索请求超过大小限制' });
      chunks.push(chunk);
    }
    const upstream = await fetchImpl('https://api.deepseek.com/v1/tools/' + kind, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: Buffer.concat(chunks)
    });
    const bytes = await webBody(upstream, 2 * 1024 * 1024, controller.signal);
    res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(Buffer.from(bytes));
  } catch (error) {
    if (res.destroyed) return;
    json(res, controller.signal.aborted ? 504 : 502, { error: 'DeepSeek搜索代理未完成请求', code: error.code || 'DEEPSEEK_PROXY_ERROR' });
  } finally {
    clearTimeout(timer);
    res.off('close', cancel);
  }
}
