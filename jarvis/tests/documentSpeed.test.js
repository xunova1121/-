import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../src/agent/tools.js';
import { createFileStore } from '../server/fileStore.mjs';
import * as ws from '../src/agent/workspace.js';
import { useBackend } from '../src/agent/store.js';

const LONG = '# 方案\n\n## 一、背景\n\n' + '交易点按批次登记称重、检测、结算和对账记录，每一步记录操作人和时间。'.repeat(40) + '\n\n## 二、做法\n\n按流程执行。';

describe('文档生成少等：不重复自查、不重复生成', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-docspeed-')); useBackend(createFileStore(dir)); });
  afterEach(() => { useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });

  it('同一个文件：第一次请模型自查；改了内容再生成不再自查；内容一模一样直接用上次的结果', async () => {
    const calls = [];
    const reasonLlm = async (o) => { calls.push(o); return JSON.stringify({ problems: [], edits: [] }); };
    const tool = createTools({ reasonLlm }).find((t) => t.name === 'create_document');
    const args = { format: 'docx', path: '文件/方案.docx', content: LONG, requirements: '写一份方案' };
    const first = await tool.run(args);
    expect(calls).toHaveLength(1);
    expect(first).toMatch(/不需要再 read_file 核对或重新生成/);
    await tool.run({ ...args, content: LONG.replace('按流程执行', '按流程执行，每周复盘') });
    expect(calls).toHaveLength(1);
    const again = await tool.run({ ...args, content: LONG.replace('按流程执行', '按流程执行，每周复盘') });
    expect(again).toMatch(/内容和上次完全一样，没有重新生成/);
  });

  it('跨轮、要求改变或文件外部修改不能复用旧结果', async () => {
    const tool = createTools({}).find((t) => t.name === 'create_document');
    const args = { format: 'docx', path: '文件/隔离.docx', content: '# 报告\n\n按批次登记称重、检测、结算和对账记录，每一步记录操作人和处理结果。每周核对差异并安排整改。', requirements: '写报告' };
    const firstScope = {};
    await tool.run(args, { executionScope: firstScope });
    expect(await tool.run(args, { executionScope: firstScope })).toContain('没有重新生成');
    expect(await tool.run(args, { executionScope: {} })).not.toContain('没有重新生成');
    expect(await tool.run({ ...args, requirements: '改为正式报告' }, { executionScope: firstScope })).not.toContain('没有重新生成');
    await ws.write('文件/隔离.docx', new Blob(['外部修改']));
    expect(await tool.run(args, { executionScope: firstScope })).not.toContain('没有重新生成');
  });

  it('短文件（一千多字以内）规则检查没问题就不请模型自查', async () => {
    const calls = [];
    const tool = createTools({ reasonLlm: async (o) => { calls.push(o); return '{}'; } }).find((t) => t.name === 'create_document');
    await tool.run({ format: 'docx', path: '文件/周报.docx', content: '# 周报\n\n## 本周\n\n完成称重接口联调。', requirements: '写一份周报' });
    expect(calls).toHaveLength(0);
  });
});
