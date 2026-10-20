import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor, maskConfig, mergeConfig } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';
import { createServer as httpServer } from 'node:http';

let dir, server, base, mode;
const PASS = 'test-password-123';
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-srv-'));
  mode = createServerMode({ dataDir: dir, password: PASS });
  server = createServer({ serverMode: mode, ollama: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });

const auth = { Authorization: `Bearer ${tokenFor(PASS)}` };
const api = (p, init = {}) => fetch(base + p, { ...init, headers: { ...auth, ...(init.body && typeof init.body === 'string' && { 'Content-Type': 'application/json' }), ...init.headers } });

/** 读 SSE：收集事件直到连接结束 */
async function readSse(res) {
  const text = await res.text();
  return text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
}

describe('服务器模式接口', () => {
  it('服务器自行拉取模型：使用服务器密钥，不接受手机传入的地址和密钥', async () => {
    const configFile=path.join(dir,'config.json');
    const previous=fs.existsSync(configFile)?fs.readFileSync(configFile):null;
    let seenKey='';
    const upstream=httpServer((req,res)=>{seenKey=req.headers.authorization;res.setHeader('Content-Type','application/json');if(seenKey==='Bearer bad-key'){res.writeHead(401);res.end('{}');return;}res.end(JSON.stringify({data:[{id:'same-model'},{id:'model-2'}]}));});
    await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
    try {
      await api('/api/server/config',{method:'PUT',body:JSON.stringify({provider:'custom',keys:{custom:'server-private-key'},baseURLs:{custom:`http://127.0.0.1:${upstream.address().port}/v1`}})});
      const result=await api('/api/server/models',{method:'POST',body:JSON.stringify({provider:'custom',key:'phone-key',baseURL:'https://must-not-use.invalid'})});
      const payload=await result.json();
      expect(payload.ids).toEqual(['same-model','model-2']);
      expect(seenKey).toBe('Bearer server-private-key');
      expect(JSON.stringify(payload)).not.toContain('server-private-key');
      const proxy=await api('/api/llm/relay-2/v1/models',{headers:{'x-jarvis-upstream':`http://127.0.0.1:${upstream.address().port}`,Authorization:auth.Authorization,'x-api-key':'relay-key'}});
      expect(proxy.status).toBe(200);
      expect((await proxy.json()).data[0].id).toBe('same-model');
      expect((await fetch(base+'/api/server/models',{method:'POST',body:'{"provider":"custom"}'})).status).toBe(401);
      expect((await api('/api/server/models',{method:'POST',body:'{"provider":"unknown"}'})).status).toBe(400);
      await api('/api/server/config',{method:'PUT',body:'{"keys":{"custom":"bad-key"}}'});
      const invalidKey=await api('/api/server/models',{method:'POST',body:'{"provider":"custom"}'});
      expect(invalidKey.status).toBe(502);
      expect(await invalidKey.json()).toMatchObject({code:'CATALOG_API',kind:'api',upstreamStatus:401});
    } finally {
      await new Promise(resolve=>upstream.close(resolve));
      if(previous)fs.writeFileSync(configFile,previous);else fs.rmSync(configFile,{force:true});
    }
  });
  it('没登录一律拒绝；密码错了不给令牌，对了给', async () => {
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/api/llm/openai/models`)).status).toBe(401); // 模型转发也要登录
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const bad = await fetch(`${base}/api/server/login`, { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
    expect(bad.status).toBe(401);
    const ok = await (await fetch(`${base}/api/server/login`, { method: 'POST', body: JSON.stringify({ password: PASS }) })).json();
    expect(ok.token).toBe(tokenFor(PASS));
  });

  it('发任务 → 关掉连接 → 重新连上补发进度 → 结果在对话里；文件能上传下载', async () => {
    const put = await api(`/api/files/raw?path=${encodeURIComponent('资料/原文.txt')}`, { method: 'PUT', body: '三季度营收 1860 万' });
    expect(put.status).toBe(200);
    const { id, sessionId } = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify({ text: '你好' }) })).json();
    // 只连一下就断开（模拟手机切走），任务照样做完
    const ctrl = new AbortController();
    await api(`/api/tasks/${id}/events`, { signal: ctrl.signal }).catch(() => {});
    ctrl.abort();
    const t0 = Date.now();
    while ((await (await api(`/api/tasks/${id}`)).json()).status !== 'done') { if (Date.now() - t0 > 10000) throw new Error('超时'); await new Promise((r) => setTimeout(r, 50)); }
    const events = await readSse(await api(`/api/tasks/${id}/events?after=0`));
    expect(events.at(-1)).toMatchObject({ type: 'task_state', status: 'done' });
    const tail = await readSse(await api(`/api/tasks/${id}/events?after=${events.at(-2).seq}`));
    expect(tail).toHaveLength(1);
    const list = await (await api('/api/sessions')).json();
    expect(list[0]).toMatchObject({ id: sessionId, count: 2, taskId: null });
    expect(list[0].messages).toBeUndefined();
    const one = await (await api(`/api/sessions/${sessionId}`)).json();
    expect(one.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const files = await (await api('/api/files')).json();
    expect(files.map((f) => f.path)).toContain('资料/原文.txt');
    const raw = await api(`/api/files/raw?path=${encodeURIComponent('资料/原文.txt')}`);
    expect(await raw.text()).toBe('三季度营收 1860 万');
    expect(raw.headers.get('content-disposition')).toContain(encodeURIComponent('原文.txt'));
  });

  it('模型设置：密钥只显示后 4 位，保存时没改的密钥沿用', async () => {
    await api('/api/server/config', { method: 'PUT', body: JSON.stringify({ provider: 'deepseek', keys: { deepseek: 'sk-abcdef123456' } }) });
    const got = await (await api('/api/server/config')).json();
    expect(got.keys.deepseek).toBe('••••3456');
    await api('/api/server/config', { method: 'PUT', body: JSON.stringify({ ...got, models: { deepseek: 'deepseek-chat' } }) });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(saved.keys.deepseek).toBe('sk-abcdef123456');
    expect(saved.models.deepseek).toBe('deepseek-chat');
    expect(fs.statSync(path.join(dir, 'config.json')).mode & 0o077).toBe(0); // 只有运行未央的账号能读
    expect(maskConfig({ keys: {} }).tavilyKey).toBe('');
    expect(mergeConfig({ keys: { a: 'x' } }, { keys: { a: '' } }).keys.a).toBe('x');
  });

  it('密码太短不让开启', () => {
    expect(() => createServerMode({ dataDir: dir, password: '123' })).toThrow(/至少 8 位/);
  });
});

describe('服务器模式：手机 App 跨域调用', () => {
  it('预检请求放行；带令牌的跨域请求能拿到结果；本机网关的其他接口不开放跨域', async () => {
    const pre = await fetch(`${base}/api/tasks`, { method: 'OPTIONS', headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    const r = await fetch(`${base}/api/sessions`, { headers: { Origin: 'https://localhost', ...auth } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const other = await fetch(`${base}/api/fetch?url=https://example.com`, { headers: { Origin: 'https://evil.example', ...auth } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('服务器模式：把本机的对话传上去', () => {
  it('没有的存进去，已有的不覆盖；图片缩略图之类的多余字段不存', async () => {
    const one = { id: 'clocal1', title: '以前的对话', titleSet: true, createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: '你好', ts: 1, thumbs: ['data:image/png;base64,xxx'] }, { role: 'assistant', content: '你好呀', ts: 2, tools: ['web_search'] }, { role: 'system', content: '不该存' }] };
    const a = await (await api('/api/sessions/import', { method: 'POST', body: JSON.stringify(one) })).json();
    expect(a).toMatchObject({ imported: true });
    const b = await (await api('/api/sessions/import', { method: 'POST', body: JSON.stringify({ ...one, title: '改过' }) })).json();
    expect(b).toMatchObject({ skipped: true });
    const got = await (await api('/api/sessions/clocal1')).json();
    expect(got.title).toBe('以前的对话');
    expect(got.messages).toMatchObject([{ role: 'user', content: '你好', ts: 1 }, { role: 'assistant', content: '你好呀', ts: 2, tools: ['web_search'] }]);
    expect(got.messages[0].thumbs).toBeUndefined();
    expect(got.messages).toHaveLength(2); // system 那条没存
    expect((await api('/api/sessions/import', { method: 'POST', body: JSON.stringify({ id: '../x', messages: [] }) })).status).toBe(400);
  });
});

describe('服务器模式：手机原生网络传文件', () => {
  it('Base64 上传、原样下载，Word 这类二进制文件不坏', async () => {
    const { createServerClient } = await import('../src/core/serverClient.js');
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x7f]); // zip 文件头 + 非文字字节
    const seen = [];
    const c = createServerClient({ base, token: tokenFor(PASS), fetchImpl: (u, init) => { seen.push(init); return fetch(u, init); } });
    await c.upload('报告/测试.docx', new Blob([bytes]));
    const back = new Uint8Array(await (await c.download('报告/测试.docx')).arrayBuffer());
    expect([...back]).toEqual([...bytes]);
    expect(seen.at(-1).binary).toBe(true); // 下载时告诉原生网络按字节读
  });
});

describe('服务器模式：内置技能', () => {
  it('启动时装上内置技能（做 PPT、Word 的步骤和规范），和手机 / 电脑上一样', async () => {
    const packs = await import('../src/agent/skillPacks.js');
    const t0 = Date.now();
    while (!(await packs.get('briefing-deck')) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    expect(await packs.get('briefing-deck')).toMatchObject({ source: '内置' });
    expect(fs.readdirSync(path.join(dir, 'store', 'packs')).length).toBeGreaterThan(5);
  });
});

describe('服务器模式：立即更新', () => {
  it('没装自动更新时说明怎么装；装了就留下更新请求，状态里能看到版本和上次结果', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-upd-'));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-app-'));
    fs.writeFileSync(path.join(app, 'VERSION'), '1.0.140\n');
    const unit = path.join(d, 'jarvis-update.path');
    const m = createServerMode({ dataDir: d, password: PASS, appDir: app, updateUnit: unit });
    const srv = createServer({ serverMode: m, ollama: null });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const at = (p, init = {}) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { ...init, headers: auth });
    try {
      expect((await at('/api/server/update', { method: 'POST' })).status).toBe(409);
      expect(await (await at('/api/server/update')).json()).toMatchObject({ version: '1.0.140', auto: false, last: null });
      fs.writeFileSync(unit, '');
      fs.writeFileSync(path.join(d, 'update-status.json'), JSON.stringify({ state: 'latest', message: '已经是最新版 1.0.140', at: '2026-10-18 04:20:00' }));
      expect((await at('/api/server/update', { method: 'POST' })).status).toBe(200);
      expect(fs.existsSync(path.join(d, 'update-request'))).toBe(true);
      expect(await (await at('/api/server/update')).json()).toMatchObject({ auto: true, requested: true, last: { state: 'latest' } });
    } finally {
      await new Promise((r) => srv.close(r));
      useBackend(createFileStore(path.join(dir, 'store')));
      fs.rmSync(d, { recursive: true, force: true });
      fs.rmSync(app, { recursive: true, force: true });
    }
  });
});

describe('服务器模式：编辑重发、本机那一轮记回来、按内容搜', () => {
  it('截断到某条之前；追加消息（没有这段就新建）；内容搜索带摘录', async () => {
    await api('/api/sessions/import', { method: 'POST', body: JSON.stringify({ id: 'cut1', title: '季度汇报', titleSet: true, messages: [{ role: 'user', content: '帮我写三季度汇报' }, { role: 'assistant', content: '好的，三季度营收增长了百分之十八。' }, { role: 'user', content: '再加一页风险' }, { role: 'assistant', content: '已加' }] }) });
    expect((await api('/api/sessions/cut1/truncate', { method: 'POST', body: JSON.stringify({ keep: 2 }) })).status).toBe(200);
    expect((await (await api('/api/sessions/cut1')).json()).messages).toHaveLength(2);
    await api('/api/sessions/cut1/append', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: '在桌面建个文件夹' }, { role: 'assistant', content: '建好了' }, { role: 'system', content: '不该收' }] }) });
    expect((await (await api('/api/sessions/cut1')).json()).messages.map((m) => m.content).slice(-2)).toEqual(['在桌面建个文件夹', '建好了']);
    expect((await api('/api/sessions/brandnew1/append', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }) })).status).toBe(200);
    expect((await (await api('/api/sessions/brandnew1')).json()).messages).toHaveLength(1);
    const hits = await (await api('/api/sessions/search?q=百分之十八')).json();
    expect(hits).toEqual([expect.objectContaining({ id: 'cut1', title: '季度汇报', snippet: expect.stringContaining('百分之十八') })]);
  });
});

