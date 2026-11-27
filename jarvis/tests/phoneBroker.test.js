import { it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPhoneBroker } from '../server/phoneBroker.mjs';
import { runAsUser } from '../server/userScope.mjs';
let broker;
afterEach(() => { broker?.close(); vi.useRealTimers(); });
const register = () => broker.register({ name: '测试手机', installationId: randomUUID() });
const poll = d => broker.transport(d.id, d.token, { op: 'poll' });
it('两个账号只看见自己的手机，伪造owner无效，设备令牌不能串机', () => {
  broker = createPhoneBroker(); const a = runAsUser('u_aaaaaaaaaaaaaaaaaaaaaaaa', register), b = runAsUser('u_bbbbbbbbbbbbbbbbbbbbbbbb', register);
  expect(runAsUser('u_aaaaaaaaaaaaaaaaaaaaaaaa', () => broker.list()).map(d => d.id)).toEqual([a.id]);
  expect(() => runAsUser('u_bbbbbbbbbbbbbbbbbbbbbbbb', () => broker.disconnect(a.id))).toThrow(/本人/);
  expect(() => broker.transport(a.id, b.token, { op: 'poll' })).toThrow(/失效/);
  expect(() => broker.transport(a.id, '', { op: 'poll' })).toThrow();
  expect(JSON.stringify(broker.list())).not.toContain(a.token);
});
it('执行、领取、二次校验、完成闭环；同一命令仅领取一次', async () => {
  broker = createPhoneBroker(); const d = register();
  expect(() => broker.execute(d.id, { action: 'home' })).toThrow(/离线/);
  poll(d); const promise = broker.execute(d.id, { action: 'read_screen' });
  const command = poll(d).command; expect(command.action).toBe('read_screen'); expect(poll(d).command).toBeNull();
  expect(() => broker.execute(d.id, { action: 'home' })).toThrow(/另一条/);
  expect(broker.transport(d.id, d.token, { op: 'validate', commandId: command.id }).ok).toBe(true);
  broker.transport(d.id, d.token, { op: 'complete', commandId: command.id, result: { ok: true, message: '已读屏', secret: 'drop' } });
  expect(await promise).toEqual({ ok: true, code: '', message: '已读屏' });
  expect(() => broker.transport(d.id, d.token, { op: 'validate', commandId: command.id })).toThrow(/过期/);
});
it('任务取消后不能再校验或提交结果；同一手机可开始新的核对', async () => {
  broker = createPhoneBroker(); const d = register(); poll(d); const ctrl = new AbortController();
  const promise = broker.execute(d.id, { action: 'home' }, { signal: ctrl.signal }), id = poll(d).command.id;
  ctrl.abort(); await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => broker.transport(d.id, d.token, { op: 'validate', commandId: id })).toThrow();
  expect(poll(d).activeId).toBe('');
});
it('暂停、账号禁用、登录撤销立即终止设备控制', async () => {
  let active = true; broker = createPhoneBroker({ active: () => active });
  const d = broker.register({ installationId: randomUUID() }, 'login-1'); poll(d);
  const pending = broker.execute(d.id, { action: 'read_screen' });
  broker.transport(d.id, d.token, { op: 'poll', paused: true }); await expect(pending).rejects.toMatchObject({ code: 'PHONE_PAUSED' });
  expect(() => broker.execute(d.id, { action: 'home' })).toThrow(/暂停/);
  active = false; expect(broker.list()).toEqual([]); expect(() => poll(d)).toThrow();
  active = true; const next = broker.register({ installationId: randomUUID() }, 'login-2'); broker.revokeSession('login-2'); expect(() => poll(next)).toThrow();
});
it('超时回执未知，迟到动作和过期连接均不能重放', async () => {
  vi.useFakeTimers(); broker = createPhoneBroker({ commandMs: 100 }); const d = register(); poll(d);
  const assertion = expect(broker.execute(d.id, { action: 'home' })).rejects.toMatchObject({ code: 'PHONE_RESULT_UNKNOWN' }); const id = poll(d).command.id;
  await vi.advanceTimersByTimeAsync(101); await assertion;
  expect(() => broker.transport(d.id, d.token, { op: 'complete', commandId: id, result: { ok: true } })).toThrow();
  await vi.advanceTimersByTimeAsync(900000); expect(() => poll(d)).toThrow();
});
it('同设备重新绑定撤销旧连接，单账号数量有界', () => {
  broker = createPhoneBroker(); const installationId = randomUUID(); const first = broker.register({ installationId }); const second = broker.register({ installationId });
  expect(() => poll(first)).toThrow(); expect(poll(second).command).toBeNull();
  for (let i = 0; i < 4; i++) register(); expect(() => register()).toThrow(/断开/);
});
