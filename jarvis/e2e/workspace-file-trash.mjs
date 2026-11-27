/** 使用正式云端聊天、事件流和用户文件 API，仅用确定性模型代替付费上游。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createServerClient, followTask } from '../src/core/serverClient.js';
import { useBackend } from '../src/agent/store.js';

const target = '旧项目/报价单.txt';
const other = '新项目/报价单.txt';
const original = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0xc1);
let steps = [];
let modelCalls = 0;
const fixture = () => ({
  model: 'file-space-fixture',
  adapter: {
    async stream(input) {
      modelCalls++;
      const step = steps.shift();
      assert.ok(step, '此轮不应额外调用模型');
      if (step.name) {
        assert.ok(input.tools.some(tool => tool.name === step.name), '模型能通过本轮工具描述找到 ' + step.name);
        return { text: '', toolCalls: [{ name: step.name, args: step.args, id: 'call-' + modelCalls }], stop: 'tool_use' };
      }
      if (step.receipt) assert.ok(input.messages.some(m => m.role === 'tool' && step.receipt.test(m.content)), '模型收到真实工具回执');
      input.onText?.(step.text);
      return { text: step.text, toolCalls: [], stop: 'end_turn' };
    }
  }
});
const dir = await mkdtemp(path.join(tmpdir(), 'wy-file-space-chat-'));
let server, mode;
try {
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ provider: 'mock', autoMemory: false, teamMode: 'off', routing: { enabled: false }, hedgeBackup: false }));
  mode = createServerMode({ dataDir: dir, password: 'test-workspace-file-trash', makeTaskAdapter: fixture });
  await mode.ready;
  server = createServer({ serverMode: mode, ollama: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const owner = createServerClient({ base, token: tokenFor('test-workspace-file-trash') });
  async function member(name) {
    const { accessCode } = await owner.createUser(name);
    const token = await createServerClient({ base }).login(accessCode);
    return createServerClient({ base, token });
  }
  const alice = await member('甲'), bob = await member('乙');
  await alice.upload(target, new Blob([original]));
  await alice.upload(other, new Blob(['要保留的同名文件']));
  await bob.upload(target, new Blob(['乙的文件']));
  async function chat(client, sessionId, text, plan = []) {
    steps = [...plan];
    const task = await client.startTask({ sessionId, text });
    const events = [];
    const end = await followTask(client, task.id, { after: 0, onEvent: event => events.push(event), signal: AbortSignal.timeout(30000) });
    assert.equal(end.status, 'done', end.error);
    assert.equal(steps.length, 0, '预期的模型调用都实际发生');
    const session = await client.getSession(task.sessionId);
    const messages = session.session?.messages || session.messages;
    assert.equal(messages.at(-2).role, 'user');
    assert.equal(messages.at(-2).content, text);
    assert.equal(messages.at(-1).role, 'assistant');
    return { sessionId: task.sessionId, answer: messages.at(-1).content, receipts: events.filter(e => e.type === 'tool_end') };
  }
  const candidates = await chat(alice, null, '我想把以前的文件删除');
  assert.match(candidates.answer, /请选择/);
  assert.ok(candidates.answer.includes(target) && candidates.answer.includes(other));
  assert.ok(candidates.receipts.find(e => e.name === 'prepare_file_trash' && e.ok));
  assert.equal(modelCalls, 0);
  assert.deepEqual(await alice.listTrashedFiles(), []);
  const sessionId = candidates.sessionId;
  const number = candidates.answer.split('\n').find(line => line.includes(target)).match(/^(\d+)\./)[1];
  const byNumber = await chat(alice, sessionId, number);
  assert.ok(byNumber.answer.includes(target) && byNumber.answer.includes('确认删除文件') && !byNumber.answer.includes(other));
  const cancelled = await chat(alice, sessionId, '取消');
  assert.match(cancelled.answer, /已取消/);
  assert.deepEqual(await alice.listTrashedFiles(), []);
  assert.equal(modelCalls, 0);
  const selected = await chat(alice, sessionId, '删除文件 ' + target, [{ name: 'prepare_file_trash', args: { paths: [target] } }]);
  assert.ok(selected.answer.includes(target) && selected.answer.includes('确认删除文件') && !selected.answer.includes(other));
  assert.deepEqual(await alice.listTrashedFiles(), []);
  // 另开会话，同一确认句不能消费原对话的待确认清单。
  const beforeCrossSession = modelCalls;
  const orphan = await chat(alice, null, '确认删除文件');
  assert.match(orphan.answer, /没有已核对的待删清单/);
  const orphanBulk = await chat(alice, orphan.sessionId, '确认全部移入回收站');
  assert.match(orphanBulk.answer, /没有已核对的待删清单/);
  assert.equal(modelCalls, beforeCrossSession);
  assert.deepEqual(await alice.listTrashedFiles(), []);
  const confirmed = await chat(alice, sessionId, '确认删除文件');
  assert.ok(confirmed.answer.includes('已移至') && confirmed.answer.includes(target));
  const receipt = confirmed.receipts.find(e => e.name === 'trash_files' && e.ok);
  assert.deepEqual(JSON.parse(receipt.output).paths, [target]);
  assert.deepEqual((await alice.listFiles()).map(f => f.path), [other]);
  await assert.rejects(alice.download(target), /404|找不到/);
  assert.equal(await (await alice.download(other)).text(), '要保留的同名文件');
  assert.equal(await (await bob.download(target)).text(), '乙的文件');
  assert.deepEqual(await bob.listTrashedFiles(), []);
  const query = await chat(alice, sessionId, '查看文件回收站', [
    { name: 'list_trashed_files', args: {} },
    { text: '回收站中有 ' + target, receipt: /旧项目\/报价单\.txt/ }
  ]);
  assert.deepEqual(JSON.parse(query.receipts.find(e => e.name === 'list_trashed_files' && e.ok).output).files.map(f => f.path), [target]);
  const recovered = await chat(alice, sessionId, '从回收站恢复文件 ' + target, [
    { name: 'restore_file', args: { path: target } },
    { text: '已恢复 ' + target, receipt: /"restored"/ }
  ]);
  assert.deepEqual(JSON.parse(recovered.receipts.find(e => e.name === 'restore_file' && e.ok).output).paths, [target]);
  assert.deepEqual(new Uint8Array(await (await alice.download(target)).arrayBuffer()), original);
  assert.deepEqual(await alice.listTrashedFiles(), []);

  const content = new Map([[target, original], [other, new TextEncoder().encode('要保留的同名文件')]]);
  for (let i = 0; i < 26; i++) {
    const directory = ['.workflows/posters/过程', 'uploads/上传', '成果/旧稿'][i % 3];
    const path = directory + '/' + i + '.bin';
    const bytes = Uint8Array.of(i, 255, 0, 127, 0xc2, i);
    await alice.upload(path, new Blob([bytes]));
    content.set(path, bytes);
  }
  const beforeBulk = modelCalls;
  const dated = await chat(alice, sessionId, '以前的文件全删了');
  assert.match(dated.answer, /请选择/);
  assert.ok(!dated.answer.includes('确认全部移入回收站'));
  const all = await chat(alice, sessionId, '我想清除所有文件');
  assert.match(all.answer, /云端|云服务器|服务器文件空间/);
  assert.ok(all.answer.includes('全部 ' + content.size + ' 个') && all.answer.includes('确认全部移入回收站'));
  assert.equal((await alice.listFiles()).length, content.size);
  assert.deepEqual(await alice.listTrashedFiles(), []);
  const late = 'uploads/确认后新增.bin', changed = 'uploads/上传/1.bin';
  const newBytes = Uint8Array.of(42, 0, 255, 127, 0xc2, 1);
  await alice.upload(late, new Blob(['确认时的清单之外']));
  await alice.upload(changed, new Blob([newBytes]));
  const bulk = await chat(alice, sessionId, '确认全部移入回收站');
  const receipts = bulk.receipts.filter(e => e.name === 'trash_files');
  assert.equal(receipts.length, 1);
  const result = JSON.parse(receipts[0].output);
  assert.equal(result.status, 'partial');
  assert.equal(result.changedCount, content.size - 1);
  assert.deepEqual(result.errors.map(e => e.path), [changed]);
  assert.equal(modelCalls, beforeBulk);
  assert.deepEqual((await alice.listFiles()).map(f => f.path).sort(), [changed, late].sort());
  const trashed = await alice.listTrashedFiles();
  assert.deepEqual(trashed.map(f => f.path).sort(), [...content.keys()].filter(p => p !== changed).sort());
  assert.deepEqual(new Uint8Array(await (await alice.download(changed)).arrayBuffer()), newBytes);
  assert.equal(await (await alice.download(late)).text(), '确认时的清单之外');
  assert.equal(await (await bob.download(target)).text(), '乙的文件');
  assert.deepEqual(await bob.listTrashedFiles(), []);
  for (const entry of trashed) {
    await alice.restoreTrashedFile(entry.path, entry);
    assert.deepEqual(new Uint8Array(await (await alice.download(entry.path)).arrayBuffer()), content.get(entry.path));
  }
  assert.deepEqual(await alice.listTrashedFiles(), []);
  console.log('云端对话回收站通过：按序号和文件名选定、取消及跨会话隔离；28 项全空间快照、真实逐项回收和逐字节恢复，新增、改写及另一账号的文件保留。');
} finally {
  await mode?.runner.settled();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  useBackend(null);
  await rm(dir, { recursive: true, force: true });
}
