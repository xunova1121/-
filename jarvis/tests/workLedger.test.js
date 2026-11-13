import { it, expect, beforeEach } from 'vitest';
import { collection } from '../src/agent/store.js';
import { recordWorkAttempt, listWorkRecords, removeWorkRecord, dropSessionWork, workQuestion } from '../src/agent/workLedger.js';
import { answerWorkHistory } from '../src/agent/workHistoryAnswer.js';
import { runAgent } from '../src/agent/agent.js';
import * as workspace from '../src/agent/workspace.js';
beforeEach(async () => {
  await collection('kv').clear();
  await collection('sessions').clear();
});
async function song(id, { ok = true, path = '音乐/示例.mp3', scope = {}, sessionId = 'c-ledger' } = {}) {
  if (!(await collection('sessions').get(sessionId))) await collection('sessions').put({ id: sessionId, messages: [] });
  if (ok) await workspace.write(path, new Blob(['audio']));
  return recordWorkAttempt({
    tool: 'sing_song',
    args: { title: '歌' + id, lyrics: '不得保存的歌词' },
    output: `已经唱好，保存在 ${path}`,
    ok,
    sessionId,
    scope,
    callId: id
  });
}
it('稳定生成ID去重，失败与口头承诺不计成功，记录没有歌词或凭据', async () => {
  const scope = {};
  await song('same', { scope });
  await song('same', { scope });
  await song('failed', { ok: false });
  await recordWorkAttempt({ tool: 'sing_song', args: { title: '口头' }, output: '正在排队', ok: true, sessionId: 'c-ledger', scope: {}, callId: 'pending' });
  const result = await listWorkRecords({ kind: 'song' });
  expect(result.total).toBe(1);
  expect(result.completeHistory).toBe(false);
  expect(result.items[0]).toMatchObject({ sessionId: 'c-ledger', status: 'success' });
  expect(JSON.stringify(await collection('kv').all())).not.toContain('不得保存的歌词');
});
it('真实文件不存在不冒充生成成功，跨对话同名不同生成仍分别计数', async () => {
  await collection('sessions').put({ id: 'c-ledger', messages: [] });
  await recordWorkAttempt({
    tool: 'sing_song',
    args: {},
    output: '已经唱好，保存在 音乐/不存在.mp3',
    ok: true,
    sessionId: 'c-ledger',
    scope: {},
    callId: 'missing'
  });
  await song('one', { sessionId: 'c-one' });
  await song('two', { sessionId: 'c-two' });
  const result = await listWorkRecords({ kind: 'song', limit: 1 });
  expect(result.total).toBe(2);
  expect(result.more).toBe(true);
  expect((await listWorkRecords({ kind: 'song', offset: 1, limit: 1 })).items[0].sessionId).not.toBe(result.items[0].sessionId);
});
it('删记录和删会话可清除追溯数据，删除后仍明确历史覆盖有缺口', async () => {
  const one = await song('one', { sessionId: 'c-one' });
  await song('two', { sessionId: 'c-two' });
  await removeWorkRecord(one.id);
  expect((await listWorkRecords()).total).toBe(1);
  await dropSessionWork('c-two');
  expect((await listWorkRecords()).total).toBe(0);
  expect((await listWorkRecords()).truncated).toBe(true);
});
it('评测不读写正式成果记录，未来制作需求不当历史统计', async () => {
  await collection('sessions').put({ id: 'c-eval', evaluationId: 'test' });
  await song('evaluation', { sessionId: 'c-eval' });
  expect((await listWorkRecords()).total).toBe(0);
  expect(await answerWorkHistory('总共做过几首歌', 'c-eval')).toBeNull();
  expect(workQuestion('计划一共要做几首歌')).toBe('');
});
it('纯统计不用模型猜总数，混合新任务仍走原模型流程', async () => {
  await song('one');
  let calls = 0;
  const result = await runAgent({
    adapter: {
      async stream() {
        calls++;
        throw new Error('不应调用模型');
      }
    },
    model: 'fixture',
    userText: '一共做了几首歌，全部列出',
    history: [],
    tools: [],
    context: { dynamic: '' },
    sessionId: 'c-ledger'
  });
  expect(calls).toBe(0);
  expect(result.text).toContain('至少 1');
  expect(result.text).toContain('歌one');
  expect(await answerWorkHistory('一共做了几首歌，顺便再帮我唱一首', 'c-ledger')).toBeNull();
});
it('统计可立即停止，文档回执只接真实存在的文件', async () => {
  await song('one');
  const controller = new AbortController();
  controller.abort();
  await expect(listWorkRecords({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  await workspace.write('文档成果.docx', new Blob(['file']));
  await recordWorkAttempt({
    tool: 'create_document',
    args: { title: '方案' },
    output: '已生成 文档成果.docx',
    ok: true,
    sessionId: 'c-ledger',
    scope: {},
    callId: 'doc'
  });
  expect((await listWorkRecords({ kind: 'document' })).total).toBe(1);
});
it('索引达到4096条明确标记截断，不声称历史完整', async () => {
  await collection('kv').put({ id: 'work-ledger-v1', since: 1, ids: Array.from({ length: 4096 }, (_, index) => 'old-' + index), truncated: false });
  await song('bounded');
  const index = await collection('kv').get('work-ledger-v1');
  expect(index.ids).toHaveLength(4096);
  expect(index.truncated).toBe(true);
  expect((await listWorkRecords({ kind: 'song' })).total).toBe(1);
});
it('按北京时间时间范围核对，不把昨天的歌算进今天；Excel不混入Word', async () => {
  const now = Date.parse('2026-10-25T16:30:00Z');
  const one = await song('today');
  const two = await song('yesterday');
  const kv = collection('kv');
  const first = await kv.get('work-record:' + one.id);
  const second = await kv.get('work-record:' + two.id);
  await kv.put({ ...first, createdAt: now });
  await kv.put({ ...second, createdAt: now - 3600000 });
  const answer = await answerWorkHistory('今天一共做了几首歌', 'c-ledger', { now });
  expect(answer.result.total).toBe(1);
  expect(answer.text).toContain('歌today');
  expect(answer.text).not.toContain('歌yesterday');
  expect(await answerWorkHistory('2026年9月一共做了几首歌', 'c-ledger', { now })).toBeNull();
});
it('用户可纠正成果标题，保留原始生成标题用于追溯', async () => {
  const { renameWorkRecord } = await import('../src/agent/workLedger.js');
  const scope = {};
  const record = await song('rename', { scope });
  await renameWorkRecord(record.id, '纠正后的歌名');
  await song('rename', { scope });
  const result = await listWorkRecords({ kind: 'song' });
  expect(result.items[0]).toMatchObject({ title: '歌rename', displayTitle: '纠正后的歌名' });
  expect((await answerWorkHistory('一共做了几首歌', 'c-ledger')).text).toContain('纠正后的歌名');
});
it('已经删除来源对话的生成任务不重新写回成果记录', async () => {
  const result = await recordWorkAttempt({
    tool: 'sing_song',
    args: {},
    output: '已经唱好，保存在 音乐/示例.mp3',
    ok: true,
    sessionId: 'deleted-conversation',
    scope: {},
    callId: 'late-result'
  });
  expect(result).toBeNull();
  expect((await listWorkRecords()).total).toBe(0);
});
it('中转复用工具调用ID时，不合并不同真实产物；同一回执重记仍去重', async () => {
  const scope = {};
  await song('reused-call', { scope, path: '音乐/第一首.mp3' });
  await song('reused-call', { scope, path: '音乐/第二首.mp3' });
  await song('reused-call', { scope, path: '音乐/第二首.mp3' });
  const result = await listWorkRecords({ kind: 'song' });
  expect(result.total).toBe(2);
  expect(new Set(result.items.map((record) => record.id)).size).toBe(2);
});
it('精确查文件来源不受最近200条视图限制', async () => {
  const old = await song('old-source', { path: '音乐/老成果.mp3' });
  const newer = await song('new-source', { path: '音乐/新成果.mp3' });
  const index = await collection('kv').get('work-ledger-v1');
  await collection('kv').put({ ...index, ids: [old.id, ...Array.from({ length: 220 }, (_, i) => 'gap-' + i), newer.id] });
  const result = await listWorkRecords({ path: '音乐/老成果.mp3', limit: 1 });
  expect(result.items[0].id).toBe(old.id);
});
it('历史统计夹带新文件或新歌任务时不吞掉后续动作', async () => {
  await song('history');
  for (const request of ['一共做了几首歌，帮我生成PPT', '总共唱了几首歌，再来一首', '列全之前做过的文档，导出Excel']) {
    expect(await answerWorkHistory(request, 'c-ledger')).toBeNull();
  }
});
it('执行器给不同真实调用分配操作ID，即使服务商ID和输出路径都复用', async () => {
  await collection('sessions').put({ id: 'c-operations', messages: [] });
  let turn = 0;
  const adapter = {
    async stream() {
      turn++;
      if (turn <= 2) return { text: '', toolCalls: [{ id: 'reused', name: 'sing_song', args: { title: '歌曲' + turn } }], stop: 'tool_use' };
      return { text: '两次操作已完成。', toolCalls: [], stop: 'end_turn' };
    }
  };
  const tool = {
    name: 'sing_song',
    description: '假生成器',
    input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    run: async ({ title }) => {
      await workspace.write('音乐/同一输出路径.mp3', new Blob([title]));
      return '已经唱好，保存在 音乐/同一输出路径.mp3';
    }
  };
  await runAgent({
    adapter,
    model: 'fixture',
    userText: '唱两首歌',
    history: [],
    tools: [tool],
    context: { dynamic: '' },
    sessionId: 'c-operations',
    quiet: true,
    emit: () => {}
  });
  expect((await listWorkRecords({ kind: 'song' })).total).toBe(2);
});
