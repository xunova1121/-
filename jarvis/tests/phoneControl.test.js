import { describe, it, expect, vi, afterEach } from 'vitest';
import { phoneCommand, phoneResult } from '../shared/phoneControl.js';
import { createPhoneTools } from '../src/agent/phoneTools.js';
import { localPhoneTransport } from '../src/mobile/phoneTransport.js';
import { resolveTaskIntent } from '../src/core/taskIntent.js';
import { taskToolCore } from '../src/agent/taskToolProfile.js';
import { checkpointEvent, checkpointNeedsReview } from '../shared/taskCheckpoint.js';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { trimComputerScreenshots } from '../src/agent/agent.js';
import { needsComputer } from '../src/llm/router.js';
import { withLookupDeadline } from '../src/agent/lookup/turn.js';
import { createTurnArchive, compactToolResults } from '../src/agent/turnContext.js';

afterEach(() => vi.useRealTimers());
it('明确指定手机不被桌面路由截走，手机任务不套搜索60秒上限', async () => {
  expect(needsComputer('打开我手机的微信')).toBe(false);
  expect(needsComputer('打开这台电脑上的微信')).toBe(true);
  expect(needsComputer('打开手机使用说明书.docx')).toBe(true);
  const run = vi.fn().mockResolvedValue('ok');
  await withLookupDeadline({ userText: '读取我手机当前页面', tools: [{ name: 'phone_action' }] }, run);
  expect(run.mock.calls[0][0].lookupDeadline).toBeUndefined();
});
describe('手机参数与路由', () => {
  it.each(['打开微信', '读取我手机当前页面', '设置明早七点的闹钟', '帮我导航到南京南站'])('%s 保留完整工具', text => {
    const intent = resolveTaskIntent(text);
    expect(intent.category).toBe('work');
    expect([...taskToolCore(intent, text)]).toContain('phone_action');
  });
  it('只保留动作白名单；服务端确认和任意Intent无效', () => {
    expect(phoneCommand({ action: 'dial', number: '10086', confirmed: true, shell: 'rm', intent: 'x' })).toEqual({ action: 'dial', number: '10086' });
    expect(() => phoneCommand({ action: 'shell' })).toThrow();
    expect(() => phoneCommand({ action: 'open_app', packageName: '../x' })).toThrow();
    expect(() => phoneCommand({ action: 'dial', number: '*123#' })).toThrow();
  });
  it('点击/输入需要新屏幕，坐标、文字和闹钟范围真实约束', () => {
    for (const args of [{ action: 'tap', x: .5, y: .5 }, { action: 'type_text', snapshotId: 's', text: 'abc' }, { action: 'tap', snapshotId: 's', x: 2, y: .2 }, { action: 'alarm', hour: 24 }, { action: 'alarm', hour: 8, minute: 70 }]) expect(() => phoneCommand(args)).toThrow();
    expect(phoneCommand({ action: 'alarm', hour: '7', minute: '30' })).toMatchObject({ hour: 7, minute: 30 });
  });
  it('限制返回大小并丢弃未知字段和非JPEG', () => {
    const result = phoneResult({ ok: true, token: 'not retained', screen: { nodes: Array.from({ length: 200 }, () => ({ text: 'x'.repeat(1000), password: 'not retained' })) }, image: { mime: 'text/html', data: 'AAAA' } });
    expect(result.screen.nodes).toHaveLength(160); expect(result.screen.nodes[0].text).toHaveLength(160);
    expect(JSON.stringify(result)).not.toContain('not retained'); expect(result.image).toBeUndefined();
  });
});
describe('工具只交付真实回执', () => {
  it('原生失败不能变成功，相同修改不重复提交，截图真实交模型', async () => {
    const execute = vi.fn().mockResolvedValueOnce({ ok: false, code: 'PHONE_STALE_SCREEN', message: '页面已变化' }).mockResolvedValueOnce({ ok: true, image: { mime: 'image/jpeg', data: 'AAAA' } });
    const tool = createPhoneTools({ execute })[1], args = { deviceId: 'local', action: 'tap', snapshotId: 's', nodeId: 'n1' };
    await expect(tool.run(args)).rejects.toMatchObject({ code: 'PHONE_STALE_SCREEN' });
    await expect(tool.run(args)).rejects.toMatchObject({ code: 'PHONE_DUPLICATE' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await tool.run({ deviceId: 'local', action: 'screenshot' })).toMatchObject({ images: [{ mime: 'image/jpeg', data: 'AAAA' }] });
  });
  it('恢复记录不存屏幕正文，不重放退出时在途动作', () => {
    let c = checkpointEvent({}, { type: 'tool_start', id: 'a', name: 'phone_action', args: { text: 'private' } });
    expect(checkpointNeedsReview(c)).toBe(true);
    c = checkpointEvent(c, { type: 'tool_end', id: 'a', name: 'phone_action', ok: true, output: 'private screen text' });
    expect(JSON.stringify(c)).not.toContain('private'); expect(checkpointNeedsReview(c)).toBe(false);
  });
  it('手机屏幕不进入可回读归档，避免通过read_tool_result再次写进进度', () => {
    const archive = createTurnArchive();
    compactToolResults([{ role: 'tool', name: 'phone_action', content: 'private-screen'.repeat(1000) }], { budget: 100, keep: 0, archive });
    expect(archive.chars).toBe(0);
  });
  it('模型输入只保留最近两屏和两张截图，用户附件保留', () => {
    const list = [{ role: 'user', images: ['original'] }, ...[1, 2, 3, 4].map(i => ({ role: 'tool', name: 'phone_action', content: JSON.stringify({ ok: true, screen: { snapshotId: String(i) } }), images: ['frame'] }))];
    trimComputerScreenshots(list);
    expect(list[0].images).toEqual(['original']); expect(list[1].images).toBeUndefined();
    expect(list.filter(x => x.role === 'tool' && /"screen"/.test(x.content))).toHaveLength(2);
  });
});
describe('本机取消与账号切换', () => {
  it('停止时取消原生命令，迟到回执不反转为成功', async () => {
    let complete; const native = { execute: vi.fn(() => new Promise(r => complete = r)), cancel: vi.fn().mockResolvedValue({}) };
    const ctrl = new AbortController(), promise = localPhoneTransport(native).execute('local', { action: 'read_screen' }, { signal: ctrl.signal });
    await Promise.resolve(); ctrl.abort(); await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    complete({ ok: true }); expect(native.cancel).toHaveBeenCalledTimes(1);
  });
  it('切换账号后丢弃原生迟到结果，错误设备不能调用', async () => {
    let valid = true, complete; const native = { execute: () => new Promise(r => complete = r) }, transport = localPhoneTransport(native, () => valid);
    await expect(transport.execute('other', { action: 'home' })).rejects.toMatchObject({ code: 'PHONE_SCOPE' });
    const promise = transport.execute('local', { action: 'read_screen' }); await Promise.resolve(); valid = false; complete({ ok: true });
    await expect(promise).rejects.toMatchObject({ code: 'PHONE_SCOPE' });
  });
  it('超时取消且不重试操作', async () => {
    vi.useFakeTimers(); const native = { execute: vi.fn(() => new Promise(() => {})), cancel: vi.fn().mockResolvedValue({}) };
    const assertion = expect(localPhoneTransport(native).execute('local', { action: 'home' })).rejects.toMatchObject({ code: 'PHONE_RESULT_UNKNOWN' });
    await vi.advanceTimersByTimeAsync(46000); await assertion;
    expect(native.execute).toHaveBeenCalledTimes(1); expect(native.cancel).toHaveBeenCalledTimes(1);
  });
});

function execution(tool) {
  const events = [];
  return { events, options: { loader: { get: () => tool }, emit: e => events.push(e), seen: new Map(), retrieval: { extensive: true }, review: { record() {}, report: () => ({ request: '手机任务' }) }, webTools: new Set(), parallelSafe: new Set(), requirementText: '操控手机' } };
}
it('执行器一次模型响应只执行一个手机动作；进度事件不泄漏输入和屏幕', async () => {
  const tool = createPhoneTools({ execute: vi.fn().mockResolvedValue({ ok: true, screen: { nodes: [{ text: 'secret-screen' }] } }) })[1];
  const { options, events } = execution(tool);
  const call = id => ({ id, name: 'phone_action', args: { deviceId: 'local', action: 'type_text', snapshotId: id, nodeId: 'n1', text: 'secret-input' } });
  const result = await executeToolCalls([call('a'), call('b')], options);
  expect(result.map(x => x.ok)).toEqual([true, false]); expect(result[0].output).toContain('secret-screen');
  expect(JSON.stringify(events)).not.toMatch(/secret-screen|secret-input/);
});
it('结果未知直接结束本批操作，不能换参数继续盲点', async () => {
  const run = vi.fn().mockRejectedValue(Object.assign(new Error('回执未知'), { code: 'PHONE_RESULT_UNKNOWN' }));
  const { options } = execution({ run, input_schema: { type: "object", properties: {} } });
  const result = await executeToolCalls(['a', 'b'].map(id => ({ id, name: 'phone_action', args: {} })), options);
  expect(run).toHaveBeenCalledTimes(1); expect(result[0].recoveryStop).toContain('手机操作已停止'); expect(result[1].ok).toBe(false);
});
