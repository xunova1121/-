import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evidenceDownloader } from '../evals/joint-evidence.mjs';
import { judgePrompt, parseJudgement } from '../evals/joint-rubric.mjs';

it('同名文件修改后，各轮保留独立原件且同轮只下载一次', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'joint-evidence-'));
  let contents = Buffer.from('第一版'), calls = 0;
  const download = async () => { calls++; return contents; };
  try {
    const first = evidenceDownloader(download, path.join(root, '1'));
    await first('报告.docx');
    contents = Buffer.from('第二版');
    expect((await first('报告.docx')).toString()).toBe('第一版');
    const next = evidenceDownloader(download, path.join(root, '2'));
    await next('报告.docx');
    expect(calls).toBe(2);
    expect(first.artifact('报告.docx').sha256).not.toBe(next.artifact('报告.docx').sha256);
    expect(await fs.readFile(path.join(root, '1', first.artifact('报告.docx').file), 'utf8')).toBe('第一版');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('旧报告也从timing补记内置搜索，正文截断须明示', () => {
  const p = judgePrompt({ id: 'x', rubric: ['引用来源'] }, { turns: [{ timing: { nativeSearchCalls: 2 } }], evidence: [{ tools: [], files: [{ text: '甲'.repeat(13000) }] }] });
  expect(p.prompt).toContain('"nativeSearchCalls":2');
  expect(p.prompt).toContain('"judgeTextTruncated":true');
});
it('证据说应判过但布尔值为否，记评审错误而非自动通过；过度承诺不能过', () => {
  const data = { scores: { onPoint: 5, factual: 5, natural: 5, deliverable: 5 }, checkpoints: [{ passed: false, evidence: '数字正确，应判过' }], pass: false };
  expect(parseJudgement(JSON.stringify(data), { rubric: ['x'] }).error).toMatch(/矛盾/);
  data.checkpoints = [{ passed: true, evidence: '全部检查符合' }];
  data.pass = true; data.overclaim = true;
  expect(parseJudgement(JSON.stringify(data), { rubric: ['x'] }).pass).toBe(false);
});
it('服务器任务失败保留错误类型，不再导出failure:null，也不复制服务商错误正文', async () => {
  const { runJointOnce } = await import('../evals/joint.mjs');
  const api = async route => route === '/api/tasks' ? { id: 't', sessionId: 's' } : route === '/api/tasks/t' ? { status: 'error', errorKind: 'timeout', error: '不应导出的服务商正文', files: [] } : { messages: [] };
  const result = await runJointOnce(api, { id: 'fixture', requires: [], checks: {}, prompt: '写PPT', targetMs: 1000, timeoutMs: 5000 }, { download: async () => null, runId: 'x', attempt: 1 });
  expect(result.turns[0].failure).toEqual({ phase: 'server_task', kind: 'timeout' });
  expect(JSON.stringify(result)).not.toContain('不应导出');
});
