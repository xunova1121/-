/** 合成模型HTTP回复，真实服务器执行器、工具注册、Office渲染及三视图文件；不代表真实模型理解验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { architectureSpec } from './fixtures/architecture-plan.mjs';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { createTools } from '../src/agent/tools.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';
import * as workspace from '../src/agent/workspace.js';
import * as sessions from '../src/agent/sessions.js';
import { architectureServerAcceptance } from '../evals/architecture-server-acceptance.mjs';

const output = process.argv[2] ? path.resolve(process.argv[2]) : await fs.mkdtemp('/tmp/weiyang-architecture-director-');
if (process.argv[2]) await fs.mkdir(output, { recursive: true });
const storePath = path.join(output, 'state');
await fs.mkdir(storePath); // 已有结果不可复用，避免旧稿被当作这次产物。
useBackend(createFileStore(storePath));
const spec = structuredClone(architectureSpec), names = new Map(spec.entities.map(item => [item.id, item.title]));
const lines = [], cite = text => { lines.push(text); return { material: 0, quote: text }; };
const content = {
  title: spec.title,
  entities: spec.entities.map(({ assumption, source, excerpt, evidenceId, ...item }) => ({ ...item, citation: cite(item.title + '：' + item.responsibility + '。') })),
  relations: spec.relations.map(({ assumption, source, excerpt, evidenceId, ...item }) => ({ ...item, citation: cite(names.get(item.from) + '→' + names.get(item.to) + '：' + item.meaning + '。') })),
  requirements: spec.requirements.map(item => ({ entities: item.entities, citation: cite(item.text) }))
};
const source = '上传/虚构招标原文.md', directory = '交付/服务器架构专用流程';
await workspace.write(source, lines.join('\n'));
let helperCalls = 0, mainCalls = 0;
const toolCalls = [], helperKinds = [];
const server = http.createServer((request, response) => {
  (async () => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.method, 'POST');
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; assert.ok(size < 300000); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(input.stream, true); assert.ok(!input.tools?.length);
    const system = input.messages.filter(item => item.role === 'system').map(item => item.content).join('\n');
    const kind = system.includes('你负责业务理解') ? 'content' : system.includes('审查架构关系底稿') ? 'review' : 'unexpected';
    assert.notEqual(kind, 'unexpected', '辅助调用不得绕入其他任务');
    helperKinds.push(kind); helperCalls++;
    const text = JSON.stringify(kind === 'content' ? content : { passed: true, issues: [] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  })().catch(error => { response.writeHead(500); response.end(error.message); });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const cfg = { ...DEFAULT_CONFIG, provider: 'custom', models: { custom: 'synthetic-helper' }, keys: { custom: 'fixture-only' }, baseURLs: { custom: `http://127.0.0.1:${server.address().port}/v1` }, autoMemory: false, hedgeBackup: false, routing: { enabled: false } };
const runner = createTaskRunner({
  getConfig: async () => cfg,
  makeAdapter: () => ({ model: 'main-must-not-run', adapter: { async stream() { mainCalls++; throw new Error('架构专用流程不得调用通用主模型'); } } }),
  makeTools: context => createTools(context).map(tool => ({ ...tool, run: async (...args) => { toolCalls.push(tool.name); return tool.run(...args); } }))
});
let started;
try {
  started = await runner.start({ text: `根据工作区原始文件${source}制作总体架构图，同时给出业务闭环和数据流专题，产物存到${directory}/。各视图SVG、PNG、PDF和原生可编辑PPT同稿导出。`, evaluationId: 'architecture_director_e2e' });
  const deadline = Date.now() + 180000;
  while (!['done', 'error', 'stopped'].includes(runner.get(started.id)?.status)) {
    assert.ok(Date.now() < deadline, '架构专用流程超过3分钟');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await runner.settled();
  const task = runner.get(started.id), events = runner.events(started.id);
  assert.equal(task.status, 'done', task.error); assert.equal(mainCalls, 0);
  assert.equal(task.timing.modelCalls, 0); assert.equal(task.timing.helperModelCalls, 2);
  assert.equal(helperCalls, 2); assert.deepEqual(helperKinds, ['content', 'review']);
  assert.ok(toolCalls.length > 0); assert.ok(toolCalls.every(name => name === 'build_architecture'), JSON.stringify(toolCalls));
  assert.deepEqual(events.filter(event => event.type === 'tool_start').map(event => event.name), toolCalls);
  assert.ok(events.some(event => event.type === 'diagnostic' && event.phase === 'architecture_director_start'));
  assert.ok(events.some(event => event.type === 'diagnostic' && event.phase === 'architecture_director_end' && event.status === 'complete' && event.mainModelCalls === 0));
  assert.equal(events.some(event => event.type === 'diagnostic' && event.phase === 'model_start'), false);
  const accepted = await architectureServerAcceptance(directory);
  assert.equal(accepted.state, 'complete', JSON.stringify(accepted));
  assert.equal(accepted.views.length, 3); assert.equal(accepted.views.flatMap(view => view.files).length, 15);
  assert.equal(accepted.customerBusiness, 'not_reviewed'); assert.equal(accepted.customerVisual, 'not_reviewed');
  const saved = await sessions.get(started.sessionId), answer = saved.messages.at(-1);
  assert.equal(answer.role, 'assistant'); assert.equal(answer.timing.modelCalls, 0); assert.equal(answer.timing.helperModelCalls, 2);
  assert.match(answer.content, /已生成总体架构、业务闭环、数据流/);
  await fs.writeFile(path.join(output, 'acceptance.json'), JSON.stringify({ task, accepted, toolCalls, helperKinds, mainCalls, events }, null, 2));
  console.log('服务器专用流程通过：通用主模型0次，合成HTTP辅助回复2次；只调用注册的build_architecture，无读搜改工具空转；真实Office三视图15文件验收通过，非真实模型理解验收。');
} finally {
  if (started && !['done', 'error', 'stopped'].includes(runner.get(started.id)?.status)) runner.stop(started.id);
  await runner.settled(); server.close(); server.closeAllConnections(); await once(server, 'close'); useBackend(null);
}
