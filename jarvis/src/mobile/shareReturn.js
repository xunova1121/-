/** 分享只保留30分钟的小型返回指针；不保存文件内容、对话正文或登录凭证。 */
export const SHARE_RETURN_KEY = 'jarvis.shareReturn.v1';
export const SHARE_RETURN_TTL = 30 * 60_000;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const safePath = value => typeof value === 'string' && value.length <= 300 && !/^[\\/]|[\u0000-\u001f]|(^|[\\/])\.\.([\\/]|$)/.test(value);
const safeSession = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const safeScope = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
async function bounded(promise, label, ms = 3000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时，请重试`)), ms); })]); }
  finally { clearTimeout(timer); }
}

export function readShareReturn(storage, now = Date.now()) {
  try {
    const raw = storage?.getItem(SHARE_RETURN_KEY);
    if (!raw || raw.length > 1600) return null;
    const value = JSON.parse(raw);
    if (value.version !== 1 || !validId(value.id) || !safeScope(value.scope) || !Number.isFinite(value.at) || now < value.at || now - value.at >= SHARE_RETURN_TTL) return null;
    if (value.sessionId && !safeSession(value.sessionId)) return null;
    if (value.filePath && !safePath(value.filePath)) return null;
    return { version: 1, id: value.id, at: value.at, scope: value.scope, sessionId: value.sessionId || '', filePath: value.filePath || '' };
  } catch { return null; }
}

/** 只比较摘要，存盘数据不会含服务器地址、成员ID或会话令牌。 */
export async function shareAccountScope(account, serverMode, crypto = globalThis.crypto) {
  if (!crypto?.subtle) return null;
  const material = JSON.stringify([Boolean(serverMode), String(account?.url || ''), String(account?.userId || ''), String(account?.token || '')]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function createShareReturnCoordinator({ storage = null, native = null, context = async () => null, now = Date.now, foreground = () => true } = {}) {
  let active = null;
  const forget = id => {
    try { if (JSON.parse(storage?.getItem(SHARE_RETURN_KEY) || 'null')?.id === id) storage.removeItem(SHARE_RETURN_KEY); } catch { /* 已损坏的记录不能恢复。 */ }
    Promise.resolve().then(() => native?.finish({ id })).catch(() => {});
  };
  const release = ticket => {
    if (active !== ticket) return;
    clearTimeout(ticket.timer);
    clearTimeout(ticket.returnTimer);
    forget(ticket.id);
    active = null;
  };
  return {
    async begin() {
      if (active?.settled && foreground()) release(active);
      if (active) throw new Error(active.expired ? '上次分享状态未确认，请从最近任务返回；仍无法分享时完全关闭再打开未央' : '分享正在打开或进行中，请先完成或取消当前分享');
      const id = 'share_' + (globalThis.crypto?.randomUUID?.() || now().toString(36) + Math.random().toString(36).slice(2));
      const ticket = { id, at: now(), launched: false, settled: false, left: false, returned: false, expired: false };
      active = ticket;
      ticket.timer = setTimeout(() => {
        if (active !== ticket) return;
        ticket.expired = true;
        forget(id);
        // 原生回调没回来不能冒险打开第二个选择器；不占用任何页面遮罩或交互锁。
        if (!ticket.launched || ticket.settled) active = null;
      }, SHARE_RETURN_TTL);
      ticket.timer.unref?.();
      try {
        const saved = await bounded(Promise.resolve().then(context), '准备分享返回位置');
        if (active !== ticket || ticket.expired) throw new Error('分享准备已过期，请重新操作');
        if (safeScope(saved?.scope)) {
          const record = { version: 1, id, at: ticket.at, scope: saved.scope, sessionId: safeSession(saved.sessionId) ? saved.sessionId : '', filePath: safePath(saved.filePath) ? saved.filePath : '' };
          try { storage?.setItem(SHARE_RETURN_KEY, JSON.stringify(record)); } catch { /* 存储不可用时仍可分享，但不承诺重启恢复。 */ }
        }
        return ticket;
      } catch (error) { release(ticket); throw error; }
    },
    async prepare(ticket) {
      if (active !== ticket || ticket.expired) throw new Error('分享准备已失效');
      try {
        const pending = Promise.resolve().then(() => native?.prepare({ id: ticket.id })).then(result => {
          if (active !== ticket || ticket.expired || ticket.returned) { forget(ticket.id); return { notification: false }; }
          return result;
        });
        return await bounded(pending, '准备返回入口');
      } catch { return { notification: false }; }
    },
    launch(ticket) {
      if (active !== ticket || ticket.expired) throw new Error('分享准备已失效');
      ticket.launched = true;
    },
    settle(ticket, failed = false) {
      if (active !== ticket) return;
      ticket.settled = true;
      if (failed || ticket.returned || ticket.expired) release(ticket);
    },
    foreground(isActive) {
      if (!active) return;
      clearTimeout(active.returnTimer);
      if (!isActive) active.left = true;
      else if (active.left) {
        const ticket = active;
        // 选择器跳微信时可能瞬间resume，稳定在前台后才撤返回入口。
        ticket.returnTimer = setTimeout(() => {
          if (active !== ticket || !foreground()) return;
          ticket.returned = true;
          forget(ticket.id);
          if (ticket.settled) release(ticket);
        }, 800);
        ticket.returnTimer.unref?.();
      }
    },
    cancel(ticket) { release(ticket); },
    forget,
    pending: () => readShareReturn(storage, now())
  };
}
