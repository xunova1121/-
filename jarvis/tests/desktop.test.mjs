import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOps, resolvePath, isProtected, userPaths, runShell } from '../desktop/ops.mjs';
import { encodeWav, resolveStt, transcribe, cleanTranscript } from '../src/perception/stt.js';
import { toolName, normalizeSchema, mcpTools } from '../src/agent/mcpClient.js';
import { parseArgs, parsePairs } from '../src/ui/mcpPanel.js';

describe('桌面版：路径与保护', () => {
  const p = userPaths('/home/u');
  it('中文别名、~、相对路径', () => {
    expect(resolvePath('桌面/报告.docx', p)).toBe(path.resolve('/home/u/Desktop/报告.docx'));
    expect(resolvePath('下载', p)).toBe(path.resolve('/home/u/Downloads'));
    expect(resolvePath('~/a.txt', p)).toBe(path.resolve('/home/u/a.txt'));
    expect(resolvePath('notes/x.md', p)).toBe(path.resolve('/home/u/notes/x.md'));
    expect(resolvePath('"/tmp/引号.txt"', p)).toBe(path.resolve('/tmp/引号.txt'));
    expect(() => resolvePath('', p)).toThrow();
  });
  it('系统目录受保护', () => {
    expect(isProtected('/etc/hosts', 'linux')).toBe(true);
    expect(isProtected('/usr/local/bin/x', 'linux')).toBe(true);
    expect(isProtected('/home', 'linux')).toBe(true);
    expect(isProtected('/home/u/Desktop/a.txt', 'linux')).toBe(false);
    expect(isProtected('C:\\Windows\\System32\\x.dll', 'win32')).toBe(true);
    expect(isProtected('C:\\', 'win32')).toBe(true);
    expect(isProtected('D:\\资料\\a.docx', 'win32')).toBe(false);
  });
});

describe('桌面版：文件操作（临时目录）', () => {
  let dir;
  let ops;
  const trashed = [];
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ops-'));
    fs.mkdirSync(path.join(dir, 'sub/deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub/deep/年度报告.txt'), '内容');
    ops = createOps({ shell: { trashItem: async (f) => { trashed.push(f); fs.rmSync(f); } }, clipboard: { readText: () => '剪贴板', writeText: () => {} } });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('列目录（文件夹在前）、搜索、读写', async () => {
    await ops.writeFile({ path: path.join(dir, 'a.md'), text: '# 标题' });
    const l = await ops.listDir({ path: dir });
    expect(l.entries.map((e) => e.name)).toEqual(['sub', 'a.md']);
    expect((await ops.search({ dir, keyword: '报告' })).hits).toEqual([path.join(dir, 'sub/deep/年度报告.txt')]);
    const r = await ops.readFile({ path: path.join(dir, 'a.md') });
    expect(Buffer.from(r.base64, 'base64').toString()).toBe('# 标题');
    await ops.writeFile({ path: path.join(dir, 'new/b.bin'), base64: Buffer.from([1, 2, 3]).toString('base64') });
    expect([...fs.readFileSync(path.join(dir, 'new/b.bin'))]).toEqual([1, 2, 3]);
  });

  it('移动 / 复制不覆盖已有文件；回收站走系统接口', async () => {
    await ops.copy({ from: path.join(dir, 'a.md'), to: path.join(dir, 'a2.md') });
    await expect(ops.copy({ from: path.join(dir, 'a.md'), to: path.join(dir, 'a2.md') })).rejects.toThrow(/已存在/);
    await ops.move({ from: path.join(dir, 'a2.md'), to: path.join(dir, 'moved/a3.md') });
    expect(fs.existsSync(path.join(dir, 'moved/a3.md'))).toBe(true);
    await expect(ops.move({ from: path.join(dir, 'a.md'), to: path.join(dir, 'moved/a3.md') })).rejects.toThrow(/已存在/);
    await ops.trash({ path: path.join(dir, 'moved/a3.md') });
    expect(trashed).toEqual([path.join(dir, 'moved/a3.md')]);
    await expect(ops.writeFile({ path: process.platform==='win32'?path.join(process.env.SystemRoot||'C:/Windows','jarvis-test'):'/etc/jarvis', text: 'x' })).rejects.toThrow(/系统目录/);
    expect(await ops.clipboardRead()).toEqual({ text: '剪贴板' });
  });

  it.skipIf(process.platform === 'win32')('运行命令：返回输出与退出码，超时终止', async () => {
    expect(await runShell('echo hi && exit 3', dir, process.platform)).toMatchObject({ code: 3, stdout: 'hi', timedOut: false });
    const r = await runShell('sleep 5', dir, process.platform, 300);
    expect(r.timedOut).toBe(true);
  });
});

describe('云端语音识别', () => {
  it('WAV 编码头部正确', async () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16000);
    const b = new DataView(await wav.arrayBuffer());
    expect(wav.size).toBe(44 + 8);
    expect(b.getUint32(24, true)).toBe(16000);
    expect(b.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff));
  });
  it('自动选择：网页版用浏览器识别；桌面版按密钥选云端', () => {
    const cfg = (keys, engine = 'auto') => ({ keys, stt: { engine } });
    expect(resolveStt(cfg({}), { browserSupported: true })).toBe('browser');
    expect(resolveStt(cfg({}), { browserSupported: false })).toBe('none');
    expect(resolveStt(cfg({ openai: 'k' }), { browserSupported: false })).toBe('openai');
    expect(resolveStt(cfg({ siliconflow: 'k', openai: 'k' }), { browserSupported: false, gateway: { keys: [] } })).toBe('siliconflow');
    expect(resolveStt(cfg({}, 'browser'), { browserSupported: false })).toBe('none');
  });
  it('请求格式：multipart、模型、经网关', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ text: '<|zh|><|NEUTRAL|>你好 贾维斯' }) }; };
    const text = await transcribe('siliconflow', { keys: { siliconflow: 'k' } }, new Blob(['x']), { fetchImpl, gateway: { origin: 'http://127.0.0.1:18787', keys: [] } });
    expect(text).toBe('你好 贾维斯');
    expect(calls[0].url).toBe('http://127.0.0.1:18787/api/llm/siliconflow/audio/transcriptions');
    expect(calls[0].init.body.get('model')).toBe('FunAudioLLM/SenseVoiceSmall');
    expect(calls[0].init.headers.authorization).toBe('Bearer k');
    await expect(transcribe('openai', { keys: {} }, new Blob(['x']), { fetchImpl })).rejects.toThrow(/API Key/);
    expect(cleanTranscript('<|en|>hi')).toBe('hi');
  });
});

describe('MCP 工具包装', () => {
  it('工具名符合大模型接口要求（ASCII，≤64）', () => {
    expect(toolName('echo', 'echo')).toBe('mcp_echo__echo');
    expect(toolName('文件系统', 'read_file')).toMatch(/^mcp_s[a-z0-9]+__read_file$/);
    expect(toolName('x'.repeat(40), 'y'.repeat(60)).length).toBeLessThanOrEqual(64);
    expect(toolName('a', 'b.c/d')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('schema 规范化与确认规则', async () => {
    expect(normalizeSchema({ $schema: 'x', type: 'object', properties: { a: {} } })).toEqual({ type: 'object', properties: { a: {} } });
    expect(normalizeSchema(null)).toEqual({ type: 'object', properties: {} });
    const servers = [
      { id: 'a', name: 'A', status: 'ready', autoApprove: false, tools: [{ name: 't1', description: 'd', inputSchema: { type: 'object' } }] },
      { id: 'b', name: 'B', status: 'ready', autoApprove: true, tools: [{ name: 't2', description: 'd' }] },
      { id: 'c', name: 'C', status: 'error', tools: [{ name: 't3' }] }
    ];
    const tools = mcpTools('http://x', servers);
    expect(tools.map((t) => t.name)).toEqual(['mcp_a__t1', 'mcp_b__t2']);
    expect(tools[0].approval({ q: 1 })).toMatchObject({ key: 'mcp:a', title: expect.stringContaining('A') });
    expect(tools[1].approval).toBeNull();
    expect(tools[0].description).toMatch(/^\[MCP · A\]/);
  });
  it('表单解析：参数与键值对', () => {
    expect(parseArgs('-y @pkg "D:\\我的 资料" \'x y\'')).toEqual(['-y', '@pkg', 'D:\\我的 资料', 'x y']);
    expect(parsePairs('A=1\nB = 2=3\nbad', '=')).toEqual({ A: '1', B: '2=3' });
    expect(parsePairs('Authorization: Bearer x:y', ':')).toEqual({ Authorization: 'Bearer x:y' });
  });
});
