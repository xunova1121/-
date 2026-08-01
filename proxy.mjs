/**
 * 百炼（DashScope）本地代理 —— 零依赖，Node 18+ 直接跑：
 *
 *     export DASHSCOPE_API_KEY=sk-xxxx
 *     node proxy.mjs
 *
 * 然后把演示页里 AI_CONFIG 改成：
 *     apiKey : 'unused'                                   // 密钥不再出现在前端
 *     baseUrl: 'http://127.0.0.1:8787/v1/chat/completions'
 *
 * 两个用途：
 *   1. 浏览器直连 dashscope 被 CORS 挡住时（尤其是 file:// 打开，Origin 是 null），
 *      走这里就通了；
 *   2. 更重要的是把 apiKey 收回服务端，页面本身不再携带密钥。
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const KEY = process.env.DASHSCOPE_API_KEY;
const UPSTREAM = process.env.DASHSCOPE_BASE_URL
  || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

if (!KEY) {
  console.error('缺少环境变量 DASHSCOPE_API_KEY');
  process.exit(1);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();
  if (req.method !== 'POST') return res.writeHead(405, CORS).end('Method Not Allowed');

  const chunks = [];
  for await (const c of req) chunks.push(c);

  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: Buffer.concat(chunks)
    });

    res.writeHead(upstream.status, {
      ...CORS,
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache'
    });

    // 流式转发，保住 SSE 的逐字效果
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (err) {
    console.error('转发失败:', err);
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' })
       .end(JSON.stringify({ error: { message: String(err) } }));
  }
}).listen(PORT, () => {
  console.log(`百炼代理已启动: http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log(`转发到: ${UPSTREAM}`);
});
