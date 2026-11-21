/** 只记本设备看过的回复时间，不存正文；最多160条，运行位置各自隔离。 */
export function createConversationActivity({ storage = globalThis.localStorage } = {}) {
  const key = 'jarvis.conversation-seen.v1';
  let seen = [];
  try {
    const saved = JSON.parse(storage?.getItem(key) || '[]');
    if (Array.isArray(saved)) seen = saved.filter((x) => typeof x?.scope === 'string' && typeof x?.id === 'string' && Number.isFinite(x?.at)).slice(-160);
  } catch { /* 存储损坏或不可用时，从本次真实观察开始。 */ }
  function note(scope, id, at) {
    const old = seen.find((x) => x.scope === scope && x.id === id);
    if (old?.at >= at) return;
    seen = [...seen.filter((x) => x !== old), { scope, id, at }].slice(-160);
  }
  return {
    state(row, { scope = 'local', current = false, activity = '' } = {}) {
      const reply = row.messages?.findLast((m) => m.role === 'assistant' || m.role === 'agent');
      const at = Number(reply?.ts ?? row.lastReplyAt) || 0;
      const old = seen.find((x) => x.scope === scope && x.id === row.id);
      // 首次遇到旧记录只建立基线，不把所有历史都标为未读。
      const unread = Boolean(!current && old && at > old.at);
      if (!old || current) note(scope, row.id, at);
      const status = ['queued', 'running'].includes(row.taskStatus) ? row.taskStatus : activity;
      const label = status === 'queued' ? '排队中' : status === 'running' ? '回答中' : row.taskId ? '处理中' : '';
      return { status: status || (row.taskId ? 'active' : ''), label, unread: !label && unread };
    },
    flush() {
      const value = JSON.stringify(seen);
      try { if (storage?.getItem(key) !== value) storage?.setItem(key, value); } catch { /* 满了仍保留本次内存状态。 */ }
    }
  };
}
