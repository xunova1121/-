import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { createBusinessTools } from '../src/agent/businessIntelligence.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';
import * as sessions from '../src/agent/sessions.js';

it('真实服务器任务按注册表调用新工具，保存所属对话与表单，密钥不进模型提示', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-runner-'));
  useBackend(createFileStore(dir));
  const calls = [];
  const listing = fs.readFileSync(new URL('./fixtures/business-ccgp-list-20261111.html', import.meta.url), 'utf8');
  const adapter = { stream: async options => {
    calls.push(options);
    if (calls.length === 1) return { text: '', toolCalls: [{ id: 'tender-one', name: 'search_tenders', args: { query: 'GPU', period: 'today' } }], stop: 'tool_use' };
    const text = '查到GPU相关公告。类型包含中标和废标，不能当作仍在招标；原文来源：中国政府采购网。';
    options.onText?.(text); return { text, toolCalls: [], stop: 'end_turn' };
  } };
  const runner = createTaskRunner({
    getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock', qibookAccessKey: 'fixture-never-model', qibookBaseUrl: 'https://skill.qibook.com' }),
    makeAdapter: () => ({ adapter, model: 'fixture-only' }),
    makeTools: ctx => createBusinessTools({ ...ctx, now: () => Date.parse('2026-11-11T20:00:00+08:00'), fetchViaGateway: async () => new Response(listing) }, null)
  });
  try {
    const task = await runner.start({ text: '查询今天GPU招投标公告', agentId: 'business-intelligence', agentForm: { region: '全国', period: '今天', company_source: '公开来源' } });
    const start = Date.now();
    while (!['done', 'error'].includes(runner.get(task.id).status)) {
      if (Date.now() - start > 10000) throw new Error('任务未收尾');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(runner.get(task.id).status).toBe('done');
    const session = await sessions.get(task.sessionId);
    expect(session.agentId).toBe('business-intelligence');
    expect(session.agentForm.region).toBe('全国');
    const prompt = JSON.stringify(calls[0].system);
    expect(prompt).toContain('当前智能体：企业与招投标');
    expect(prompt).not.toContain('fixture-never-model');
    const toolOutput = calls.flatMap(row => row.messages || []).find(message => message.role === 'tool' && message.name === 'search_tenders');
    expect(JSON.stringify(toolOutput)).toContain('GPU');
    expect(calls[0].tools.map(row => row.name)).toContain('search_tenders');
    expect(calls[0].tools.map(row => row.name)).not.toContain('computer_run');
  } finally {
    for (const task of runner.list()) runner.stop(task.id);
    await runner.settled(); useBackend(null); fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
