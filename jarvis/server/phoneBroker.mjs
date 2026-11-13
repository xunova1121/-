import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { currentUser } from './userScope.mjs';
import { PHONE_SESSION_MS, PHONE_COMMAND_MS, phoneCommand, phoneResult, phoneError } from '../shared/phoneControl.js';
const hash = v => createHash('sha256').update(String(v || '')).digest();
/** 控制连接及正文只在内存，服务重启即失效。每人最多5台，全局250台，每台最多1个在途命令。 */
export function createPhoneBroker({ user = currentUser, active = () => true, now = Date.now, commandMs = PHONE_COMMAND_MS } = {}) {
  const devices = new Map();
  const finish = (d, error, result) => { const c = d.command; if (!c) return; d.command = null; clearTimeout(c.timer); c.signal?.removeEventListener('abort', c.abort); if (error) c.reject(error); else c.resolve(result); };
  const remove = d => { finish(d, phoneError('PHONE_DISCONNECTED', '手机连接已关闭，请在手机重新开启')); devices.delete(d.id); };
  const clean = () => { for (const d of devices.values()) if (d.until <= now() || !active(d.owner)) remove(d); };
  const owned = id => { clean(); const d = devices.get(id); if (!d || d.owner !== user()) throw phoneError('PHONE_NOT_FOUND', '找不到本人设备', 404); return d; };
  const view = d => ({ id: d.id, name: d.name, online: d.seen > 0 && d.seen > now() - 15000, paused: d.paused, expiresAt: d.until, busy: !!d.command });
  function authenticate(id, token) {
    clean(); const d = devices.get(id);
    if (!d || !timingSafeEqual(hash(token), d.secret)) throw phoneError('PHONE_AUTH', '手机控制连接已失效', 401);
    return d;
  }
  return {
    register({ name, installationId }, parentSession = null) {
      clean(); const owner = user();
      if (typeof installationId !== 'string' || !/^[a-f0-9-]{36}$/.test(installationId)) throw phoneError('PHONE_ARGUMENT', '设备编号无效', 400);
      const own = [...devices.values()].filter(d => d.owner === owner);
      for (const d of own) if (d.installationId === installationId) remove(d);
      if ([...devices.values()].filter(d => d.owner === owner).length >= 5 || devices.size >= 250) throw phoneError('PHONE_LIMIT', '请先断开不再使用的手机', 429);
      const token = 'phone_' + randomBytes(32).toString('base64url'), id = randomUUID();
      const d = { id, owner, installationId, parentSession, name: String(name || '我的安卓手机').slice(0, 60), secret: hash(token), until: now() + PHONE_SESSION_MS, seen: 0, paused: false, command: null };
      devices.set(id, d); return { ...view(d), token };
    },
    list() { clean(); return [...devices.values()].filter(d => d.owner === user()).map(view); },
    disconnect(id) { remove(owned(id)); return { ok: true }; },
    execute(id, input, { signal } = {}) {
      const d = owned(id), action = phoneCommand(input);
      if (signal?.aborted) throw signal.reason || Object.assign(new Error('已停止'), { name: 'AbortError' });
      if (!d.seen || d.seen <= now() - 15000) throw phoneError('PHONE_OFFLINE', '手机离线，请打开未央并开启手机操控');
      if (d.paused) throw phoneError('PHONE_PAUSED', '手机已暂停，请在手机恢复后继续');
      if (d.command) throw phoneError('PHONE_BUSY', '手机正在执行另一条操作，请等待结果');
      return new Promise((resolve, reject) => {
        const c = { id: randomUUID(), action, deadline: Math.min(d.until, now() + commandMs), claimed: false, resolve, reject, signal };
        c.abort = () => finish(d, signal.reason || Object.assign(new Error('已停止；未收到回执的动作结果未知，不能重复执行'), { name: 'AbortError' }));
        c.timer = setTimeout(() => finish(d, phoneError('PHONE_RESULT_UNKNOWN', '手机回执超时，结果未知；先核对屏幕，不能重发点击或输入')), Math.max(1, c.deadline - now())); c.timer.unref?.();
        d.command = c; signal?.addEventListener('abort', c.abort, { once: true });
      });
    },
    transport(id, token, body = {}) {
      const d = authenticate(id, token); d.seen = now();
      if (body.op === 'poll') {
        d.paused = body.paused === true;
        if (d.paused && d.command) finish(d, phoneError('PHONE_PAUSED', '手机已暂停，先检查屏幕后再继续'));
        const c = d.command;
        if (c && !c.claimed && !d.paused && c.deadline > now()) { c.claimed = true; return { command: { id: c.id, ...c.action, deadline: c.deadline }, expiresAt: d.until }; }
        return { command: null, activeId: c?.id || '', expiresAt: d.until };
      }
      const c = d.command;
      if (!c || c.id !== body.commandId || !c.claimed || c.deadline <= now() || d.paused) throw phoneError('PHONE_EXPIRED', '操作已取消或过期，请勿重放');
      if (body.op === 'validate') return { ok: true, deadline: c.deadline };
      if (body.op === 'complete') { const result = phoneResult(body.result); finish(d, null, result); return { ok: true }; }
      throw phoneError('PHONE_ARGUMENT', '手机传输动作不支持', 400);
    },
    revokeSession(id) { for (const d of devices.values()) if (d.parentSession === id) remove(d); },
    close() { for (const d of devices.values()) remove(d); }
  };
}
