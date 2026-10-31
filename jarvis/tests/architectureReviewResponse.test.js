import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { architectureReviewInput, parseArchitectureReview } from '../src/agent/architectureReviewResponse.js';
import { reviewArchitecture } from '../src/agent/architectureReview.js';
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-reply-')); useBackend(createFileStore(root)); });
afterEach(() => { useBackend(null); fs.rmSync(root, { recursive: true, force: true }); });
const plan = () => ({
  entities: [{ id: 'a', title: '受理', kind: 'application', inputs: [], outputs: ['事项'] }, { id: 'b', title: '办理', kind: 'application', inputs: ['事项'], outputs: [] }],
  relations: [{ from: 'a', to: 'b', type: 'workflow' }], requirements: [{ text: '原文需求' }]
});
it('审查输入由程序标目标编号，不改原底稿；有效意见仍只能指向真实对象/关系', () => {
  const value = plan(), before = structuredClone(value), input = architectureReviewInput(value);
  expect(input.entities[0].reviewTarget).toBe('entity:a');
  expect(input.relations[0].reviewTarget).toBe('relation:0');
  expect(input.requirements[0].reviewTarget).toBe('requirement:0');
  expect(value).toEqual(before);
  expect(parseArchitectureReview('{"passed":false,"issues":[{"target":"relation:0","kind":"flow","detail":"具体意见"}]}', value).passed).toBe(false);
});
it('字段错误精确定位；原12000字符/16项/240字与有效目标/枚举门槛不松', () => {
  const issue = { target: 'relation:0', kind: 'flow', detail: '具体意见' };
  const cases = [
    ['bad', 'response.json'],
    [JSON.stringify({ passed: 'true', issues: [] }), 'review.passed'],
    [JSON.stringify({ passed: true, issues: Array(17).fill(issue) }), 'review.issues'],
    [JSON.stringify({ passed: true, issues: [{ ...issue, target: 'relation:999' }] }), 'review.issues[0].target'],
    [JSON.stringify({ passed: false, issues: [{ ...issue, kind: 'flow/coverage' }] }), 'review.issues[0].kind'],
    [JSON.stringify({ passed: true, issues: [{ ...issue, detail: '甲'.repeat(241) }] }), 'review.issues[0].detail'],
    [' '.repeat(12001), 'response.length']
  ];
  for (const [text, field] of cases) {
    let error; try { parseArchitectureReview(text, plan()); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'ARCHITECTURE_REVIEW_FORMAT', diagnostics: [{ field, stage: 'format' }] });
  }
  expect(() => parseArchitectureReview('{"passed":true,"issues":[]}', plan(), 'length')).toThrow();
});
it('真实回复解析前保存，明确字段/停止类型；不写配置和headers，不吞停止或预算', async () => {
  const raw = '{"passed":false,"issues":[{"target":"relation:0","kind":"flow/coverage","detail":"原始意见不能删除"}]}';
  const llm = vi.fn(async args => {
    expect(args.returnDetails).toBe(true);
    const input = JSON.parse(args.prompt);
    expect(input.plan.entities[0].reviewTarget).toBe('entity:a');
    expect(args.system).not.toContain('"kind":"classification/ownership');
    return { text: raw, stop: 'end_turn', headers: { authorization: 'private-fixture' } };
  });
  const result = await reviewArchitecture({ llm }, plan(), { reviewPath: '文档检查/架构底稿/unit.review.json' });
  expect(result).toMatchObject({ semantic: 'not_checked', errorCode: 'ARCHITECTURE_REVIEW_FORMAT', diagnostics: [{ field: 'review.issues[0].kind' }] });
  expect(await ws.readText(result.responsePath)).toBe(raw);
  const meta = JSON.parse(await ws.readText(result.responseMetaPath));
  expect(meta).toMatchObject({ stop: 'end_turn', receivedText: true, captureTruncated: false });
  expect(JSON.stringify(meta)).not.toContain('private-fixture');
  expect(result).not.toHaveProperty('headers');
  for (const error of [new DOMException('停止', 'AbortError'), Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' })])
    await expect(reviewArchitecture({ llm: async () => { throw error; } }, plan())).rejects.toBe(error);
});
it('超限/截断回复保留有界原文，拒绝而不删意见换通过', async () => {
  const text = '甲'.repeat(12001);
  const result = await reviewArchitecture({ llm: async () => ({ text, stop: 'max_tokens' }) }, plan(), { reviewPath: '文档检查/架构底稿/limit.review.json' });
  expect(result.semantic).toBe('not_checked');
  expect((await ws.readText(result.responsePath)).length).toBe(12000);
  expect(JSON.parse(await ws.readText(result.responseMetaPath))).toMatchObject({ chars: 12001, capturedChars: 12000, captureTruncated: true });
});
