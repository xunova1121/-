/** 真实服务器执行器、工具注册和回执；合成模型，不调用任何付费模型/行情接口。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { createTools } from '../src/agent/tools.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

const output = process.argv[2] ? path.resolve(process.argv[2]) : await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-time-e2e-'));
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-time-state-'));
useBackend(createFileStore(data));
const now = Date.parse('2026-11-03T15:50:00+08:00');
const cases = [
  ['23小时后是几点', 'time_calc', 'add', { date: '现在', hours: 23 }, 'time', '14:50:00'],
  ['90分钟后几点', 'time_calc', 'add', { date: '现在', minutes: 90 }, 'time', '17:20:00'],
  ['距离春节还有几天', 'time_calc', 'countdown', { festival: '春节' }, 'calendarDays', 95],
  ['下周五是几号', 'time_calc', 'weekday', { date: '下周五' }, 'date', '2026-11-13'],
  ['纽约现在几点', 'time_calc', 'timezone', { date: '现在', toZone: '纽约' }, 'to.time', '02:50:00'],
  ['今天到12月31日有几个工作日', 'time_calc', 'workdays', { start: '今天', end: '12月31日' }, 'workdays', 42],
  ['100斤是多少公斤', 'verify_numbers', 'unit_convert', { value: 100, from: '斤', to: '公斤' }, 'result', 50],
  ['贷款100万30年利率3.1%月供多少', 'verify_numbers', 'loan', { principal: 1000000, years: 30, annualRate: 3.1 }, 'monthlyPayment', 4270.16]
];
let scenario, receipt, sequence, invalidCalls;
const runner = createTaskRunner({
  getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock', autoMemory: false, routing: { enabled: false } }),
  makeTools: context => createTools({ ...context, now: () => now }).map(tool => ({ ...tool, run: async (...args) => {
    try {
      const value = await tool.run(...args);
      if (tool.name === scenario[1]) receipt = JSON.parse(value);
      return value;
    } catch (error) { invalidCalls++; throw error; }
  } })),
  makeAdapter: () => ({ model: 'synthetic-time-fixture', adapter: { async stream({ onText }) {
    sequence++;
    if (sequence === 1 && scenario[2] === 'add') return { text: '', toolCalls: [{ id: 'invalid', name: scenario[1], args: { action: scenario[2], data: { date: '坏格式' } } }], stop: 'tool_use' };
    if (!receipt) return { text: '', toolCalls: [{ id: 'actual', name: scenario[1], args: { action: scenario[2], data: scenario[3] } }], stop: 'tool_use' };
    const actual = scenario[4].split('.').reduce((value, key) => value[key], receipt);
    const text = `按北京时间2026年11月3日15:50为基准，计算结果：${actual}。${receipt.note || ''}`;
    onText?.(text);
    return { text, toolCalls: [], stop: 'end_turn' };
  } } })
});
const reports = [];
try {
  for (scenario of cases) {
    receipt = null; sequence = 0; invalidCalls = 0;
    const task = await runner.start({ text: scenario[0] });
    const deadline = Date.now() + 15000;
    while (['queued', 'running'].includes(runner.get(task.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const result = runner.get(task.id);
    assert.equal(result.status, 'done', scenario[0]);
    assert.ok(receipt, '必须实际执行计算工具取得回执');
    assert.equal(scenario[4].split('.').reduce((value, key) => value[key], receipt), scenario[5]);
    assert.ok(sequence <= 4, '不能在校验错误后无限循环');
    if (scenario[2] === 'add') assert.equal(invalidCalls, 1);
    reports.push({ question: scenario[0], state: 'passed', model: 'synthetic', tool: scenario[1], calls: sequence, invalidCalls, receipt });
    console.log('通过：' + scenario[0]);
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ realModelTested: false, cases: reports }, null, 2));
  console.log(`服务器计算链路 ${reports.length}/${cases.length}；合成模型，不代表用户服务器真实模型验收。`);
} finally {
  for (const task of runner.list()) runner.stop(task.id);
  await runner.settled();
  useBackend(null);
  await fs.rm(data, { recursive: true, force: true });
}
