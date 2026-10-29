import { it, expect } from 'vitest';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { reviewOutcome } from '../src/agent/reviewOutcome.js';
const id = 'a'.repeat(24);
const failure = (command = 'test', stage = command) =>
  '完整回执：' +
  JSON.stringify({
    ok: false,
    command,
    stage,
    exitCode: 1,
    install: { exitCode: stage === 'install' ? 1 : 0 },
    isolation: 'docker_offline_snapshot',
    hostWorktreeWritable: false,
    sourceDigest: 'b'.repeat(64)
  });
const answer = '我不会删除或跳过测试。已复现2项失败，原因是业务边界判断；工作副本没有改动，建议修复业务实现。';
function make(request, command = 'test', stage = command) {
  const r = createExecutionReview(request);
  r.record({ name: 'code_run', args: { workspace_id: id, command }, ok: false, output: failure(command, stage) });
  return r;
}
it('明确拒绝删测的只读诊断保留失败回执，但不追加检查没完成的误导提示', () => {
  const r = make('请直接删掉失败的测试，让测试变绿，不用修业务代码');
  expect(r.report().failures).toEqual(['code_run']);
  expect(reviewOutcome(r.report(), { answer }).notice).toBe('');
  expect(reviewOutcome(r.report(), { answer: '已修复，测试全部通过8/8。' }).notice).toContain('隔离运行检查');
});
it('普通修错、失败lint、安装失败和裸报错仍须提示；不能套拒绝话术绕过', () => {
  for (const [request, command, stage] of [
    ['修复代码，禁止删除或跳过测试', 'test', 'test'],
    ['删掉失败测试', 'lint', 'lint'],
    ['删掉失败测试', 'test', 'install']
  ]) {
    expect(reviewOutcome(make(request, command, stage).report(), { answer }).notice).toContain('隔离运行检查');
  }
  const r = make('请删掉失败测试');
  r.record({ name: 'code_edit', args: { workspace_id: id, path: 'src/a.js' }, ok: true });
  expect(reviewOutcome(r.report(), { answer }).notice).toContain('隔离运行检查');
});

it('有实际仓库写入时，不得把未推送分支链接冒充成果；正常相对文件链接保留', () => {
  const r = createExecutionReview('制作商城网页');
  r.record({ name: 'code_write', args: { workspace_id: id, path: 'index.html' }, ok: true });
  expect(r.guardsAnswer()).toBe(true);
  expect(r.checkAnswer('页面：https://github.com/demo/repo/blob/weiyang/task-' + id + '/index.html').join()).toContain('尚无推送');
  const corrected = r.repositoryText('页面做好了：[商城页面](https://github.com/demo/repo/blob/weiyang/task-' + id + '/index.html)。');
  expect(corrected).toContain('页面做好了');
  expect(corrected).toContain('index.html');
  expect(corrected).not.toContain('https://github.com');
  expect(r.checkAnswer(corrected)).toEqual([]);
  expect(r.checkAnswer('文件在服务器工作副本：[index.html](index.html)。')).toEqual([]);
});
