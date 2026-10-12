/**
 * 测试用的假 Ollama：版本 / 模型列表 / 分段下载进度 / 删除 / OpenAI 兼容对话与向量。
 *   node e2e/fixtures/fake-ollama.mjs [端口]   默认 11999
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export function startFakeOllama(port = 11999, { steps = 5, delay = 60 } = {}) {
  const models = new Map([['llama3.2:3b', 2_019_393_189]]);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* ignore */ }
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = req.url.split('?')[0];
    if (url === '/api/version') return json(200, { version: '0.12.3-fake' });
    if (url === '/api/tags') return json(200, { models: [...models].map(([name, size]) => ({ name, size, modified_at: new Date().toISOString(), details: { parameter_size: '3.2B', quantization_level: 'Q4_K_M', family: 'llama' } })) });
    if (url === '/api/delete') { models.delete(body.model) || models.delete(`${body.model}:latest`); return json(200, {}); }
    if (url === '/api/pull') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const line = (o) => res.write(`${JSON.stringify(o)}\n`);
      line({ status: 'pulling manifest' });
      if (/nope/.test(body.model)) { line({ error: 'pull model manifest: file does not exist' }); return res.end(); }
      const total = 1_200_000_000;
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, delay));
        if (res.destroyed) return;
        line({ status: 'pulling abc123', digest: 'sha256:abc123', total, completed: Math.round(total * i / steps) });
      }
      line({ status: 'verifying sha256 digest' });
      line({ status: 'writing manifest' });
      line({ status: 'success' });
      models.set(body.model.includes(':') ? body.model : `${body.model}:latest`, total);
      return res.end();
    }
    if (url === '/v1/embeddings') {
      const input = [].concat(body.input);
      return json(200, { data: input.map((t, index) => ({ index, embedding: [/差旅|出差|报销/.test(t) ? 1 : 0, /年假|请假/.test(t) ? 1 : 0, 0.01] })) });
    }
    if (url === '/v1/chat/completions') {
      if (/gemma3/.test(body.model) && body.tools?.length) return json(400, { error: { message: `registry.ollama.ai/library/${body.model} does not support tools` } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = `本机模型 ${body.model} 收到：${String(body.messages?.at(-1)?.content ?? '').slice(0, 20)}`;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, models, close: () => new Promise((r) => server.close(r)) })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.argv[2] || 11999);
  await startFakeOllama(port);
  console.log(`fake ollama on ${port}`);
}
