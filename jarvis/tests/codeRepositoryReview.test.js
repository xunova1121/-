import { it, expect } from 'vitest';
import { createExecutionReview } from '../src/agent/executionReview.js';
const a = 'a'.repeat(24),
  b = 'b'.repeat(24);
const output = (command = 'test') =>
  JSON.stringify({
    ok: true,
    command,
    stage: command,
    exitCode: 0,
    install: { exitCode: 0 },
    sourceDigest: 'c'.repeat(64),
    isolation: 'docker_offline_snapshot',
    hostWorktreeWritable: false
  });
function write(review, id = a) {
  review.record({ name: 'code_edit', args: { workspace_id: id, path: 'src/a.js' }, ok: true });
  review.record({ name: 'code_read', args: { workspace_id: id, path: 'src/a.js' }, ok: true });
}
function run(review, id = a, command = 'test', ok = true, payload = output(command)) {
  review.record({ name: 'code_run', args: { workspace_id: id, command }, ok, output: payload });
}
it('lint不能冒充测试；失败test不能被lint清除；测试通过后再改就失效', () => {
  const review = createExecutionReview('修改仓库代码并跑测试');
  write(review);
  run(review, a, 'test', false, 'assert failed');
  run(review, a, 'lint');
  expect(review.report()).toMatchObject({ codeExecution: 'not_run', failures: ['code_run'], pendingReadback: [] });
  run(review);
  expect(review.report()).toMatchObject({ codeExecution: 'executed_scope_needs_review', failures: [] });
  write(review);
  expect(review.report().codeExecution).toBe('not_run');
  run(review);
  expect(review.report().codeExecution).toBe('executed_scope_needs_review');
});
it('工作副本之间不串测试/失败回执，相同相对路径也须分别验证', () => {
  const review = createExecutionReview('修改两个代码工作副本');
  write(review, a);
  write(review, b);
  run(review, a, 'test', false, 'failed');
  run(review, b);
  expect(review.report().codeExecution).toBe('not_run');
  expect(review.report().failures).toContain('code_run');
  run(review, a);
  expect(review.report()).toMatchObject({ codeExecution: 'executed_scope_needs_review', failures: [] });
});
it('裸ok或跑别的片段不能冒充受管仓库测试，只有实际结构化回执才计入', () => {
  const review = createExecutionReview('修改仓库并测试');
  write(review);
  run(review, a, 'test', true, '{"ok":true,"exitCode":0}');
  review.record({ name: 'run_javascript', args: { code: '1+1' }, ok: true });
  expect(review.report().codeExecution).toBe('not_run');
  run(review);
  expect(review.report().codeExecution).toBe('executed_scope_needs_review');
});
it('纯README修改读回后不误报代码没测，避免给文档编辑硬加npm测试门槛', () => {
  const review = createExecutionReview('把代码仓库README里的项目称呼改一下');
  review.record({ name: 'code_edit', args: { workspace_id: a, path: 'README.md' }, ok: true });
  expect(review.report().pendingReadback).toEqual(['README.md']);
  review.record({ name: 'code_read', args: { workspace_id: a, path: 'README.md' }, ok: true });
  expect(review.report()).toMatchObject({ codeExecution: 'not_required', pendingReadback: [], failures: [] });
  expect(review.guidance()).not.toContain('没有实际运行记录');
});
