import { beforeEach, afterEach, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../src/agent/tools.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { task, draft, fixture, review } from './helpers/documentWorkflowCases.js';

let directory;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-professional-'));
  useBackend(createFileStore(directory));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(directory, { recursive: true, force: true });
});

it('真实工具组完成底稿、起草、审查及Markdown落盘，正文不在工具返回中', async () => {
  const responses = [fixture(), draft, review()];
  let calls = 0;
  const tools = createTools({
    llm: async () => {
      calls++;
      const value = responses.shift();
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
  });
  const tool = tools.find((item) => item.name === 'write_professional_document');
  const result = await tool.run({ task, format: 'md', path: '方案.md' }, { sessionId: 'document-test' });
  expect(calls).toBe(3);
  expect(await ws.readText('方案.md')).toContain('电子秤自动称重');
  expect(result).not.toContain(draft);
  const report = JSON.parse(await ws.readText('文档检查/方案-md.json'));
  expect(report.contentReview.business).toBe('model_reviewed');
  expect(report.visual).toBe('not_checked');
  const state = JSON.parse(await ws.readText(report.contentReview.workflowFile));
  expect(state.sessionId).toBe('document-test');
  expect(state.original).toBe(draft);
});

it('模型未配置时不伪造专业工作流成功', async () => {
  const tool = createTools({}).find((item) => item.name === 'write_professional_document');
  await expect(tool.run({ task, path: '方案.docx' })).rejects.toMatchObject({ code: 'DOCUMENT_MODEL_REQUIRED' });
  expect(await ws.exists('方案.docx')).toBe(false);
});

it('超过材料限制直接拒绝，不静默删除要求', async () => {
  const tool = createTools({ llm: async () => '不能调用' }).find((item) => item.name === 'write_professional_document');
  await expect(tool.run({ task, path: '方案.md', material: 'x'.repeat(48001) })).rejects.toMatchObject({ code: 'DOCUMENT_INPUT' });
});

it('生成器失败后恢复已审查正文，不再次调用模型，并能明确选择Word模板', async () => {
  const responses = [fixture(), draft, review()];
  let calls = 0;
  const tool = createTools({
    llm: async () => {
      calls++;
      const value = responses.shift();
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
  }).find((item) => item.name === 'write_professional_document');
  let stateFile;
  try {
    await tool.run({ task, format: 'docx', path: '恢复方案.docx', template: '不存在.docx' }, { sessionId: 'recover-generator' });
    throw new Error('应当因模板不存在失败');
  } catch (error) {
    expect(error.code).toBe('DOCUMENT_TEMPLATE');
    expect(error.message).toContain('正文已保存');
    stateFile = error.stateFile;
  }
  await tool.run({ state_file: stateFile, path: '恢复方案.docx', template: 'none' }, { sessionId: 'recover-generator' });
  expect(calls).toBe(3);
  expect((await ws.readBlob('恢复方案.docx')).size).toBeGreaterThan(1000);
});
