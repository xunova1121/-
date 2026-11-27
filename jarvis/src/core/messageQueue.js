/**
 * 仅保存待发送文字和工作区路径；最多10条、每条8000字/12个附件，不缓存图片或工具结果。
 * 2026-11-17 复审：手机后台被杀时排队消息会丢。给了 storage 和 keyOf 就把排队内容存到本机：
 * 只存文字、工作区路径和“账号+会话”标识（不存登录令牌）；重启后只在同一账号、同一会话恢复，
 * 恢复的一律先暂停，不自动发送（状态不明的请求不能自动重发）。
 */
const STORE_KEY = 'jarvis.messageQueue.v1';
export function createMessageQueue({ storage = null, keyOf = null } = {}) {
  const rows = [];
  let sequence = 0;
  const same = (row, scope, sessionId) => row.scope === scope && row.sessionId === sessionId;
  const read = () => {
    try { const value = JSON.parse(storage?.getItem(STORE_KEY) || '[]'); return Array.isArray(value) ? value.slice(0, 50) : []; } catch { return []; }
  };
  const save = () => {
    if (!storage || !keyOf) return;
    const mine = rows.map(row => ({ key: keyOf(row.scope), sessionId: row.sessionId, text: row.text, files: row.files, echo: row.echo, submittedAt: row.submittedAt })).filter(row => row.key);
    const loadedKeys = new Set(mine.map(row => row.key));
    // 别的账号存着的排队消息原样保留，只替换当前已载入账号的那部分
    const others = read().filter(row => !loadedKeys.has(row.key) && !restored.has(row.key));
    try { storage.setItem(STORE_KEY, JSON.stringify([...others, ...mine].slice(-50))); } catch { /* 存不了就只保留在内存 */ }
  };
  const restored = new Set();
  const persist = fn => (...args) => { const out = fn(...args); save(); return out; };
  return {
    add: persist(function add({ scope, sessionId, text, files = [], echo = true, paused = false, submittedAt = Date.now() }) {
      text = String(text || '').trim();
      if (!sessionId || !text && !files.length) throw new Error('请先输入问题或添加附件');
      if (rows.length >= 10) throw new Error('最多排队10条，请等待处理或移除一条');
      if (text.length > 8000 || files.length > 12) throw new Error('排队问题最多8000字、12个附件，请分开发送');
      const paths = files.map(file => {
        if (!file.path || file.path.length > 500) throw new Error('附件路径无效，请重新添加');
        return { path: file.path, image: Boolean(file.image) };
      });
      const row = { id: ++sequence, scope, sessionId, text, files: paths, echo, paused, submittedAt: Number.isSafeInteger(submittedAt) && submittedAt > 0 ? submittedAt : null };
      rows.push(row);
      return row.id;
    }),
    list(scope, sessionId) {
      return rows.filter(row => same(row, scope, sessionId)).map(row => ({ ...row, files: row.files.map(file => ({ ...file })) }));
    },
    remove: persist(function remove(scope, sessionId, id) {
      const at = rows.findIndex(row => row.id === id && same(row, scope, sessionId));
      return at < 0 ? null : rows.splice(at, 1)[0];
    }),
    pause(scope, sessionId, paused = true) {
      for (const row of rows) if (same(row, scope, sessionId)) row.paused = paused;
    },
    take(scope, sessionId) {
      const first = rows.find(row => same(row, scope, sessionId));
      return first && !first.paused ? this.remove(scope, sessionId, first.id) : null;
    },
    /** 载入这个账号上次没发出去的排队消息（每个账号只载入一次），一律暂停；返回恢复了几条 */
    restore(scope) {
      const key = keyOf?.(scope);
      if (!storage || !key || restored.has(key)) return 0;
      restored.add(key);
      let count = 0;
      for (const row of read().filter(item => item.key === key)) {
        try {
          this.add({ scope, sessionId: row.sessionId, text: row.text, files: Array.isArray(row.files) ? row.files : [], echo: row.echo !== false, paused: true, submittedAt: row.submittedAt ?? null });
          count++;
        } catch { /* 超出上限或内容无效的旧记录跳过 */ }
      }
      return count;
    }
  };
}
