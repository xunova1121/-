import { it, expect, beforeEach } from 'vitest';
import { collection } from '../src/agent/store.js';
import { recordWorkAttempt, createWorkRecordsTool, workHistoryBlock } from '../src/agent/workLedger.js';
beforeEach(async () => {
  await collection('kv').clear();
  await collection('sessions').clear();
});
it('成果默认查询不代表未调用；可以按本段对话查到失败及底稿阶段，成功计数不混入', async () => {
  for (const sessionId of ['本段', '别段']) {
    await collection('sessions').put({ id: sessionId, messages: [] });
    await recordWorkAttempt({
      tool: 'create_diagram',
      args: { path: '不存在.svg' },
      ok: false,
      sessionId,
      callId: 'failed',
      failure: { code: 'ARCHITECTURE_PROJECTION', diagnostics: [{ stage: 'review', field: 'architecturePath' }], message: '不保存整段敏感正文' }
    });
  }
  await recordWorkAttempt({
    tool: 'plan_architecture',
    args: { title: '合成底稿' },
    output: '{"semantic":"not_checked"}',
    ok: true,
    sessionId: '本段',
    callId: 'plan'
  });
  const tool = createWorkRecordsTool();
  const successes = JSON.parse(await tool.run({ kind: 'diagram', sessionId: '本段' }));
  expect(successes.total).toBe(0);
  expect(successes.statusFilter).toBe('success');
  expect(successes.queryScope).toContain('不代表没有失败调用');
  const all = JSON.parse(await tool.run({ kind: 'diagram', sessionId: '本段', status: 'all' }));
  expect(all.total).toBe(2);
  expect(all.items.every((record) => record.sessionId === '本段')).toBe(true);
  expect(all.items.find((record) => record.tool === 'create_diagram')).toMatchObject({
    status: 'failed',
    failure: { code: 'ARCHITECTURE_PROJECTION', fields: [{ stage: 'review', field: 'architecturePath' }] }
  });
  expect(all.items.find((record) => record.tool === 'plan_architecture').status).toBe('unverified');
  expect(JSON.stringify(all)).not.toContain('敏感正文');
  const failed = JSON.parse(await tool.run({ status: 'failed', sessionId: '本段' }));
  expect(failed.total).toBe(1);
  const context = await workHistoryBlock('架构图卡在哪里，为什么失败', '本段');
  expect(context).toContain('create_diagram');
  expect(context).toContain('ARCHITECTURE_PROJECTION');
  expect(context).not.toContain('别段');
  expect(await workHistoryBlock('你好', '本段')).toBe('');
});
