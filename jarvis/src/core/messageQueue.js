/** 仅保存待发送文字和工作区路径；最多10条、每条8000字/12个附件，不缓存图片或工具结果。 */
export function createMessageQueue() {
  const rows = [];
  let sequence = 0;
  const same = (row, scope, sessionId) => row.scope === scope && row.sessionId === sessionId;
  return {
    add({ scope, sessionId, text, files = [], echo = true }) {
      text = String(text || '').trim();
      if (!sessionId || !text && !files.length) throw new Error('请先输入问题或添加附件');
      if (rows.length >= 10) throw new Error('最多排队10条，请等待处理或移除一条');
      if (text.length > 8000 || files.length > 12) throw new Error('排队问题最多8000字、12个附件，请分开发送');
      const paths = files.map(file => {
        if (!file.path || file.path.length > 500) throw new Error('附件路径无效，请重新添加');
        return { path: file.path, image: Boolean(file.image) };
      });
      const row = { id: ++sequence, scope, sessionId, text, files: paths, echo, paused: false };
      rows.push(row);
      return row.id;
    },
    list(scope, sessionId) {
      return rows.filter(row => same(row, scope, sessionId)).map(row => ({ ...row, files: row.files.map(file => ({ ...file })) }));
    },
    remove(scope, sessionId, id) {
      const at = rows.findIndex(row => row.id === id && same(row, scope, sessionId));
      return at < 0 ? null : rows.splice(at, 1)[0];
    },
    pause(scope, sessionId, paused = true) {
      for (const row of rows) if (same(row, scope, sessionId)) row.paused = paused;
    },
    take(scope, sessionId) {
      const first = rows.find(row => same(row, scope, sessionId));
      return first && !first.paused ? this.remove(scope, sessionId, first.id) : null;
    }
  };
}
