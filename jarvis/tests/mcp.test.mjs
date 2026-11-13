import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpManager, resultToText, slug } from '../server/mcp.mjs';
import { createServer } from '../server/server.mjs';
import { MockAgent } from '../server/agents.mjs';

const FIXTURE = path.resolve(__dirname, '../e2e/fixtures/mcp-echo.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-'));
const echo = { name: 'Echo 测试', type: 'stdio', command: process.execPath, args: [FIXTURE] };

describe('MCP 管理', () => {
  const mcp = createMcpManager({ configPath: path.join(dir, 'a.json') });
  afterAll(() => mcp.closeAll());

  it('连接 stdio 服务、列出工具、调用、保存配置', async () => {
    const s = await mcp.upsert(echo);
    expect(s).toMatchObject({ id: 'echo-测试', status: 'ready', autoApprove: false });
    expect(s.tools.map((t) => t.name).sort()).toEqual(['add', 'echo', 'fail']);
    expect(s.tools.find((t) => t.name === 'echo').inputSchema.properties.message.type).toBe('string');
    expect(await mcp.call('echo-测试', 'echo', { message: '你好' })).toEqual({ isError: false, text: '回显：你好' });
    expect(await mcp.call('echo-测试', 'add', { a: 2, b: 3 })).toEqual({ isError: false, text: '5' });
    expect((await mcp.call('echo-测试', 'fail', {})).isError).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'));
    expect(saved.servers[0]).toMatchObject({ command: process.execPath, args: [FIXTURE] });
  }, 30000);

  it('重新加载配置后自动连接；停用即断开', async () => {
    const m2 = createMcpManager({ configPath: path.join(dir, 'a.json') });
    await m2.startAll();
    expect(m2.list()[0].status).toBe('ready');
    await m2.upsert({ ...echo, enabled: false });
    expect(m2.list()[0]).toMatchObject({ status: 'off', tools: [] });
    await expect(m2.call('echo-测试', 'echo', { message: 'x' })).rejects.toThrow(/未连接/);
    await m2.closeAll();
  }, 30000);

  it('命令不存在时报错但不崩溃', async () => {
    const s = await mcp.upsert({ name: 'bad', type: 'stdio', command: 'definitely-not-a-command-xyz' });
    expect(s.status).toBe('error');
    expect(s.error).toBeTruthy();
    await mcp.remove('bad');
    expect(mcp.list().some((x) => x.id === 'bad')).toBe(false);
  }, 30000);

  it('配置校验与结果转换', async () => {
    await expect(mcp.upsert({ name: '', command: 'x' })).rejects.toThrow(/名称/);
    await expect(mcp.upsert({ name: 'h', type: 'http', url: 'not a url' })).rejects.toThrow(/地址/);
    expect(slug('My Server!')).toBe('my-server');
    expect(resultToText({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] })).toMatch(/^a\n\[图片 image\/png/);
    expect(resultToText({ content: [], structuredContent: { x: 1 } })).toContain('"x": 1');
  });
});

describe('网关 MCP 接口只允许本机页面调用', () => {
  let server, base, port;
  const mcp = createMcpManager({ configPath: path.join(dir, 'b.json') });
  beforeAll(async () => {
    server = createServer({ agent: new MockAgent({ charDelayMs: 0 }), staticDir: '/nonexistent', mcp });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { server.close(); await mcp.closeAll(); });
  const H = { 'x-jarvis-client': '1', 'content-type': 'application/json' };

  it('同源页面：增删改查与调用', async () => {
    const put = await fetch(`${base}/api/mcp/servers/echo`, { method: 'PUT', headers: { ...H, Origin: base }, body: JSON.stringify(echo) });
    expect((await put.json()).status).toBe('ready');
    const list = await (await fetch(`${base}/api/mcp`, { headers: H })).json();
    expect(list.servers[0]).toMatchObject({ id: 'echo', name: 'Echo 测试' });
    const call = await fetch(`${base}/api/mcp/call`, { method: 'POST', headers: H, body: JSON.stringify({ server: 'echo', tool: 'echo', arguments: { message: 'hi' } }) });
    expect(await call.json()).toEqual({ isError: false, text: '回显：hi' });
    expect((await fetch(`${base}/api/mcp/servers/echo`, { method: 'DELETE', headers: H })).status).toBe(200);
  }, 30000);

  it('拒绝：其他网站、缺少自定义请求头、单文件版（Origin: null）、非本机 Host', async () => {
    const body = JSON.stringify({ name: 'evil', command: 'calc' });
    expect((await fetch(`${base}/api/mcp/servers/evil`, { method: 'PUT', headers: { ...H, Origin: 'https://evil.example' }, body })).status).toBe(403);
    expect((await fetch(`${base}/api/mcp/servers/evil`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body })).status).toBe(403);
    expect((await fetch(`${base}/api/mcp`, { headers: { ...H, Origin: 'null' } })).status).toBe(403);
    const http = await import('node:http');
    const status = await new Promise((r) => http.get({ host: '127.0.0.1', port, path: '/api/mcp', headers: { ...H, Host: `evil.example:${port}` } }, (res) => { res.resume(); r(res.statusCode); }));
    expect(status).toBe(403);
    expect(mcp.list()).toEqual([]);
  });

  it('健康检查报告 MCP 可用；未启用 MCP 的网关返回 404', async () => {
    expect((await (await fetch(`${base}/api/health`)).json()).mcp).toBe(true);
    const s2 = createServer({ agent: new MockAgent({ charDelayMs: 0 }), staticDir: '/nonexistent' });
    await new Promise((r) => s2.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/mcp`, { headers: H });
    expect(r.status).toBe(404);
    s2.close();
  });
});

describe('MCP 配置文件损坏时恢复', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-cfg-'));
  const file = path.join(d, 'mcp.json');
  const off = (name) => ({ name, type: 'stdio', command: 'x', enabled: false });

  it('保存时留备份；文件坏了从备份恢复，坏文件改名留底，不会被空配置覆盖', async () => {
    const logs = [];
    const m = createMcpManager({ configPath: file });
    await m.upsert(off('甲'));
    await m.upsert(off('乙')); // 第二次保存时，第一次的内容成为备份
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
    fs.writeFileSync(file, '{"servers": [ {"name": "甲"'); // 写到一半断电
    const m2 = createMcpManager({ configPath: file, log: (t) => logs.push(t) });
    expect(m2.list().map((s) => s.name)).toEqual(['甲']);
    expect(logs.join()).toMatch(/已从上次的备份恢复/);
    expect(fs.readdirSync(d).some((f) => f.startsWith('mcp.json.broken-'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).servers.map((s) => s.name)).toEqual(['甲']);
  });

  it('没有备份时当作空配置，但坏文件保留', () => {
    const f2 = path.join(d, 'other.json');
    fs.writeFileSync(f2, 'not json');
    const m = createMcpManager({ configPath: f2 });
    expect(m.list()).toEqual([]);
    expect(fs.readdirSync(d).some((f) => f.startsWith('other.json.broken-'))).toBe(true);
  });
});

describe('MCP 意外断开后自动重连', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-flaky-'));
  /** 一个会崩的服务：前 crashTimes 次启动后 1.5 秒自己退出（留足连上的时间：机器忙时启动 Node 进程要好几百毫秒） */
  function flaky(name, crashTimes) {
    const counter = path.join(d, `${name}.count`);
    const script = path.join(d, `${name}.mjs`);
    fs.writeFileSync(script, `import fs from 'node:fs';
const n = (Number(fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, 'utf8') : 0) || 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
if (n <= ${crashTimes}) setTimeout(() => process.exit(1), 1500);
await import(${JSON.stringify(pathToFileURL(FIXTURE).href)});
`);
    return { name, type: 'stdio', command: process.execPath, args: [script], starts: () => Number(fs.readFileSync(counter, 'utf8')) };
  }
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };

  it('进程崩了自动重连，工具恢复可用', async () => {
    const s = flaky('once', 1);
    const m = createMcpManager({ configPath: path.join(d, 'a.json'), reconnectDelays: [100, 100, 100] });
    await m.upsert(s);
    await until(() => s.starts() >= 2 && m.list()[0].status === 'ready');
    expect(await m.call('once', 'echo', { message: '回来了' })).toEqual({ isError: false, text: '回显：回来了' });
    await m.closeAll();
  }, 20000);

  it('一直崩：重连几次后停下（不死循环），手动重连重新计数', async () => {
    const s = flaky('always', 99);
    const m = createMcpManager({ configPath: path.join(d, 'b.json'), reconnectDelays: [50, 50] });
    await m.upsert(s);
    await until(() => /已暂停/.test(m.list()[0].error || ''));
    const n = s.starts();
    expect(n).toBe(3); // 第一次 + 自动重连 2 次
    await new Promise((r) => setTimeout(r, 2000));
    expect(s.starts()).toBe(n); // 停下后不再启动
    await m.restart('always');
    expect(m.list()[0].status).toBe('ready');
    await until(() => /已暂停/.test(m.list()[0].error || ''));
    expect(s.starts()).toBe(n + 3);
    await m.closeAll();
  }, 20000);

  it('用户停用或删除后不再重连', async () => {
    const s = flaky('removed', 99);
    const m = createMcpManager({ configPath: path.join(d, 'c.json'), reconnectDelays: [400, 400] });
    await m.upsert(s);
    await until(() => /秒后自动重连/.test(m.list()[0].error || ''));
    await m.remove('removed');
    const n = s.starts();
    await new Promise((r) => setTimeout(r, 2500));
    expect(s.starts()).toBe(n);
    await m.closeAll();
  }, 20000);
});
