/** 原生前台事件和网页可见性统一入口：同一轮恢复只通知一次，不在后台定时保活。 */
export function onServerResume(callback, { target = globalThis, doc = globalThis.document, now = Date.now, gapMs = 750 } = {}) {
  let last = -Infinity;
  let lastOnline = -Infinity;
  let closed = false;
  const wake = (reason, native = false) => {
    if (closed || (!native && (doc?.hidden || target.__jarvisForeground === false))) return;
    const at = now();
    // 网络真正恢复可能紧随前台事件；不能被前一次失败探测的去重窗口吞掉。
    if (reason === 'online') {
      if (at - lastOnline < gapMs) return;
      lastOnline = at;
    } else if (at - last < gapMs) return;
    last = at;
    callback({ reason });
  };
  const foreground = event => { if (event.detail?.active === true) wake('foreground', true); };
  const visible = () => { if (!doc?.hidden) wake('visible'); };
  const focus = () => wake('focus');
  const online = () => wake('online');
  target.addEventListener?.('jarvis:foreground', foreground);
  target.addEventListener?.('focus', focus);
  target.addEventListener?.('online', online);
  doc?.addEventListener?.('visibilitychange', visible);
  return () => {
    closed = true;
    target.removeEventListener?.('jarvis:foreground', foreground);
    target.removeEventListener?.('focus', focus);
    target.removeEventListener?.('online', online);
    doc?.removeEventListener?.('visibilitychange', visible);
  };
}
