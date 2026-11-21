/** 用户 2026-11-05：三页 PPT 连试三次都被“联网预算”挡住——联网到点只该停联网，不能连生成文档也挡掉 */
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { createExecutionReview } from '../src/agent/executionReview.js';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'closing-output-')); useBackend(createFileStore(root)); });
afterEach(() => { useBackend(null); fs.rmSync(root, { recursive: true, force: true }); });

it('普通查询联网已收尾：生成文档照常执行，联网工具仍被挡', async () => {
  const retrieval = createRetrievalBudget('南京一共几条地铁');
  expect(retrieval.extensive).toBe(false);
  retrieval.begin(); retrieval.close('本轮联网检索已达到时间预算');
  const run = vi.fn(async () => '已生成 三页.pptx');
  const search = vi.fn(async () => '结果');
  const tools = new Map([['create_document', { name: 'create_document', input_schema: { type: 'object', properties: {} }, run }], ['web_search', { name: 'web_search', input_schema: { type: 'object', properties: {} }, run: search }]]);
  const context = { loader: { get: name => tools.get(name) }, emit: vi.fn(), seen: new Map(), review: createExecutionReview('做三页PPT'), webTools: new Set(['web_search']), parallelSafe: new Set(), retrieval, checkpoint: vi.fn(), closing: true, allowWebSearch: true };
  const [doc] = await executeToolCalls([{ id: 'a', name: 'create_document', args: {} }], context);
  expect(doc.ok).toBe(true);
  expect(run).toHaveBeenCalled();
  const [web] = await executeToolCalls([{ id: 'b', name: 'web_search', args: {} }], context);
  expect(web.ok).toBe(false);
  expect(search).not.toHaveBeenCalled();
});
