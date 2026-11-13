import { it, expect, vi } from 'vitest';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { recordImageInputRecovery, resetImageInputRecovery } from '../src/agent/imageInputRecovery.js';
import { runAgent } from '../src/agent/agent.js';
import { createInspectImageTool } from '../src/agent/inspectImage.js';

const schema = { type: 'object', properties: {
  path: { type: 'string' }, question: { type: 'string' },
  region: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'] }
}, required: ['path', 'question'] };
const inputError = () => Object.assign(new Error('图片区域越界'), { code: 'IMAGE_REGION', kind: 'input' });
const call = (args, id = 'i') => ({ id, name: 'inspect_image', args });
function executor(run = vi.fn(async () => '原图候选内容')) {
  const tool = { name: 'inspect_image', description: 'fixture', input_schema: schema, run };
  const events = [];
  const options = {
    loader: { get: name => name === tool.name ? tool : null }, emit: event => events.push(event),
    seen: new Map(), executionScope: {}, review: { record() {}, report: () => ({ request: '检查原图' }) },
    retrieval: {}, closing: false, webTools: new Set(), parallelSafe: new Set()
  };
  return { run, options, events, execute: calls => executeToolCalls(calls, options) };
}

it('真实执行器：改question、参数键顺序或路径别名不能绕过一次纠正上限', async () => {
  const fixture = executor();
  const [first] = await fixture.execute([call({ path: '图片/原图.png', question: 1, region: '底部' })]);
  expect(first.ok).toBe(false); expect(first.output).toContain('最小参数纠正一次'); expect(first.recoveryStop).toBeUndefined();
  const [second, skipped] = await fixture.execute([
    call({ region: { x: 'bad' }, question: 2, path: './图片/原图.png' }, 'second'),
    call({ path: '图片/原图.png', question: '本批不得再执行' }, 'third')
  ]);
  expect(second.recoveryStop).toContain('本次没有完成复核');
  expect(second.recoveryStop).toContain('已有描述不等于本次复核结果');
  expect(skipped.output).toContain('原图复核参数纠正上限'); expect(skipped.output).not.toContain('图形恢复');
  expect(fixture.run).not.toHaveBeenCalled();
  expect(fixture.events.filter(event => event.type === 'tool_end')).toHaveLength(2);
});

it('成功纠正清该图错误，不限制后续不同合法区域或别的图片', async () => {
  const fixture = executor();
  await fixture.execute([call({ path: '图.png', question: 1, region: 'bad' })]);
  for (const [index, x] of [0, 0.3, 0.6].entries()) {
    const [result] = await fixture.execute([call({ path: '图.png', question: `检查${index}`, region: { x, y: 0, width: 0.2, height: 1 } }, String(index))]);
    expect(result.ok).toBe(true); expect(result.recoveryStop).toBeUndefined();
  }
  expect(fixture.run).toHaveBeenCalledTimes(3);
  const [again] = await fixture.execute([call({ path: '图.png', question: 2, region: 'bad' })]);
  const [other] = await fixture.execute([call({ path: '另一张.png', question: 3, region: 'bad' })]);
  expect(again.output).toContain('纠正一次'); expect(again.recoveryStop).toBeUndefined();
  expect(other.recoveryStop).toBeUndefined();
});

it('视觉模型、网络和能力错误不计为参数错误，也不影响其他工具', async () => {
  const scope = {}, args = { path: '图.png' };
  for (const failure of [
    { code: 'TimeoutError', kind: 'network' }, { code: 'IMAGE_INSPECT_UNAVAILABLE', kind: 'capability' },
    { code: 'INVALID_TOOL_ARGS', name: 'ValidationError', kind: 'api' }, new DOMException('停止', 'AbortError')
  ]) expect(recordImageInputRecovery(scope, 'inspect_image', args, failure)).toBeNull();
  expect(recordImageInputRecovery(scope, 'other', args, inputError())).toBeNull();
  expect(recordImageInputRecovery(scope, 'inspect_image', args, inputError())).toMatchObject({ failures: 1, stopped: false });
});

it('真实inspect_image的区域错误进入守护，模型改问题和region格式仍只纠正一次', async () => {
  const fixture = executor(), tool = createInspectImageTool({});
  fixture.options.loader.get = () => tool;
  const [first] = await fixture.execute([call({ path: '原图.png', question: '核对标题', region: [0, 0, 1, 1] })]);
  const [second] = await fixture.execute([call({ question: '再看数字', path: './原图.png', regions: [] })]);
  expect(first.failure).toMatchObject({ code: 'IMAGE_REGION', kind: 'input' });
  expect(first.recoveryStop).toBeUndefined();
  expect(second.failure).toMatchObject({ code: 'IMAGE_REGION', kind: 'input' });
  expect(second.recoveryStop).toContain('本次没有完成复核');
});

it('工具内部IMAGE_REGION也走真实执行器守护，旧入口无executionScope时用每轮seen', async () => {
  const fixture = executor(vi.fn(async () => { throw inputError(); }));
  delete fixture.options.executionScope;
  const [first] = await fixture.execute([call({ path: '图.png', question: '第一次' })]);
  const [second] = await fixture.execute([call({ path: '图.png', question: '修正但仍越界' })]);
  expect(first.recoveryStop).toBeUndefined(); expect(second.recoveryStop).toBeTruthy();
  expect(fixture.run).toHaveBeenCalledTimes(2);
  const next = executor(vi.fn(async () => { throw inputError(); }));
  const [newTurn] = await next.execute([call({ path: '图.png', question: '新轮重新检查' })]);
  expect(newTurn.recoveryStop).toBeUndefined();
});

it('状态不存正文，目标容量有界，明确新指令可重置本轮计数', () => {
  const scope = {}, failure = inputError();
  recordImageInputRecovery(scope, 'inspect_image', { path: '首图.png', question: '敏感问题正文' }, failure);
  for (let index = 0; index < 24; index++) recordImageInputRecovery(scope, 'inspect_image', { path: `图${index}.png` }, failure);
  expect(recordImageInputRecovery(scope, 'inspect_image', { path: '首图.png' }, failure).failures).toBe(1);
  expect(JSON.stringify(scope)).toBe('{}');
  resetImageInputRecovery(scope);
  expect(recordImageInputRecovery(scope, 'inspect_image', { path: '首图.png' }, failure).failures).toBe(1);
});

it('真实主循环在两次参数失败后结束，不再请求模型或冒称本次复核完成', async () => {
  let calls = 0;
  const run = vi.fn(async () => '不应执行');
  const result = await runAgent({
    model: 'fixture', quiet: true, context: { dynamic: '' }, userText: '请核对工作区原图上的文字', history: [], maxSteps: 30,
    tools: [{ name: 'inspect_image', description: 'fixture', input_schema: schema, run }], emit() {},
    adapter: { async stream() {
      calls++;
      return { text: '', stop: 'tool_use', toolCalls: [call({ question: calls, region: '不是对象', path: '原图.png' }, `c${calls}`)] };
    } }
  });
  expect(calls).toBe(2); expect(run).not.toHaveBeenCalled();
  expect(result.text).toContain('本次没有完成复核'); expect(result.text).toContain('已停止本轮重复调用');
  expect(result.text).not.toContain('图片坏'); expect(result.text).not.toContain('服务不可用');
});
