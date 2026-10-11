import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
