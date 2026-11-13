import { createMessageQueue } from '../core/messageQueue.js';
import { prepareImage } from '../agent/images.js';
import * as ws from '../agent/workspace.js';
import { initMessageQueuePanel } from '../ui/messageQueuePanel.js';
import { toast } from './env.js';

/** 队列只在当前设备内存中存在，绑定登录客户端与原会话；重启后不自动重发不明状态的请求。 */
export function createComposerQueue(app, form) {
  const queue = createMessageQueue();
  const scope = () => app.server || `local:${ws.mode()}:${ws.folderName() || ''}`;
  let preparing = null;
  const current = () => queue.list(scope(), app.session?.id);
  const working = () => Boolean(app.active && !app.active.streamDone);
  const panel = initMessageQueuePanel(form, {
    current,
    working,
    remove: (id) => {
      queue.remove(scope(), app.session?.id, id);
      refresh();
    },
    edit: async (id) => {
      if (app.prompt.value.trim() || app.attachments.length) return toast('输入框里已有草稿，请先发送或清空');
      const row = current().find((item) => item.id === id);
      if (!row) return;
      try {
        const files = await restoreFiles(row.files);
        if (row.scope !== scope() || row.sessionId !== app.session?.id) return;
        if (app.prompt.value.trim() || app.attachments.length) return toast('已有新草稿，排队问题保持原样');
        if (!queue.remove(row.scope, row.sessionId, id)) return;
        app.prompt.value = row.text;
        app.attachments.push(...files);
        app.renderAttachments();
        app.autosize();
        app.prompt.focus();
      } catch (error) {
        toast(error.message);
      }
      refresh();
    },
    toggle: () => {
      const rows = current();
      queue.pause(scope(), app.session?.id, working() && !rows.some((row) => row.paused));
      refresh();
      if (!current().some((row) => row.paused)) drain();
    }
  });

  async function restoreFiles(files) {
    const restored = [];
    for (const file of files) {
      const blob = await ws.readBlob(file.path);
      if (!blob) throw new Error(`找不到附件：${file.path}`);
      restored.push({ path: file.path, image: file.image ? await prepareImage(blob) : null });
    }
    return restored;
  }

  function refresh() {
    panel.refresh();
  }

  async function drain() {
    if (preparing || working()) return;
    const row = current()[0];
    if (!row || row.paused) return;
    preparing = row.id;
    try {
      const files = await restoreFiles(row.files);
      // 读取附件期间可能切换用户、会话或发起了别的任务；不能把排队内容送进新任务。
      if (row.scope !== scope() || row.sessionId !== app.session?.id || working()) return;
      if (current()[0]?.id !== row.id || current()[0]?.paused) return;
      queue.take(row.scope, row.sessionId);
      preparing = null;
      refresh();
      // send同步建立active；每轮只取一条，其余等完成事件，不拼接问题。
      await app.send(row.text, { queuedFiles: files, echo: row.echo });
      // 本机动作等入口可能直接完成而不建立模型任务；仍按原顺序接着处理。
      if (!working()) setTimeout(drain, 0);
    } catch (error) {
      queue.pause(row.scope, row.sessionId);
      toast(`队列已暂停：${error.message}`);
    } finally {
      if (preparing === row.id) preparing = null;
      refresh();
    }
  }

  function enqueue(text, { files = app.attachments, target = app.session, client = scope(), echo = true } = {}) {
    try {
      queue.add({ scope: client, sessionId: target?.id, text, files, echo });
      if (files === app.attachments) {
        app.attachments.splice(0);
        app.renderAttachments();
      }
      refresh();
      return true;
    } catch (error) {
      if (client === scope() && target?.id === app.session?.id && !app.prompt.value.trim()) {
        app.prompt.value = text;
        app.autosize();
      }
      toast(error.message);
      return false;
    }
  }

  function finished(turn, ok) {
    const client = turn.queueScope;
    const visible = client === scope() && turn.session.id === app.session?.id;
    if (!ok || !visible || turn.background) queue.pause(client, turn.session.id);
    refresh();
    if (ok && visible && !turn.background) setTimeout(drain, 0);
  }

  new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  refresh();
  return {
    enqueue,
    finished,
    refresh,
    scope,
    drain,
    get mode() {
      return panel.mode;
    },
    pause() {
      queue.pause(scope(), app.session?.id);
      refresh();
    }
  };
}
