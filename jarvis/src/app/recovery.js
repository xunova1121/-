/**
 * 启动时的恢复：旧版单条对话流迁移成会话；手机上次被关掉时做到一半的任务接着做（结果不确定的先让用户核对）；
 * 最近 6 小时内的对话自动接着聊；设置里能查看其他没做完的任务。
 */
import { MOBILE } from '../config.js';
import { checkpointNeedsReview } from '../../shared/taskCheckpoint.js';
import { savePending, clearPending, takePending, resumeText, listPending } from '../core/pendingTask.js';
import { loadMemory, clearMemory } from '../core/memoryStore.js';
import { storageProblem } from '../agent/store.js';
import * as sessionsApi from '../agent/sessions.js';
import { $, COMPACT, storage, toast } from './env.js';

export function createRecovery(app) {
  /** 启动时接回上次的对话 / 没做完的任务 */
  async function resumeOnStart() {
    // 本地数据库打不开（比如另一个标签页还开着旧版、挡住了升级）：告诉用户，并且不做迁移，免得旧数据迁到临时存储里丢掉
    const problem = await storageProblem().catch(() => '');
    if (problem) {
      toast(problem);
      return;
    }
    if (app.settings.persistMemory) {
      await sessionsApi.migrateLegacy(loadMemory(storage)).catch(() => null);
      clearMemory(storage);
      app.setSetting('persistMemory', false);
    }
    const [recent] = await sessionsApi.list().catch(() => []);
    // 手机：上次 App 被关掉时有任务做到一半：回到那个对话接着做
    const left = MOBILE ? takePending(storage) : null;
    const leftSession = left && (await sessionsApi.get(left.sessionId).catch(() => null));
    if (left && (!leftSession || app.history.length)) savePending(storage, left.sessionId, left);
    if (leftSession && !app.history.length) {
      await app.switchTo(leftSession);
      if (checkpointNeedsReview(left.checkpoint)) {
        savePending(storage, left.sessionId, left);
        const card = document.createElement('section');
        card.className = 'task-recovery';
        card.setAttribute('role', 'status');
        const note = document.createElement('p');
        note.textContent = '上次退出时有操作的结果未确认，先核对再继续，避免重复执行。';
        const resume = document.createElement('button');
        resume.type = 'button';
        resume.textContent = '核对并继续';
        resume.onclick = () => {
          card.remove();
          app.send(resumeText(left));
        };
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.textContent = '不再继续';
        dismiss.onclick = () => {
          clearPending(storage, left.sessionId, left.turnId);
          card.remove();
        };
        card.append(note, resume, dismiss);
        $('#transcript').append(card);
      } else {
        toast('上次退出时任务还没做完，正在核对进度后继续');
        app.send(resumeText(left));
      }
      app.sessionsPanel.refresh();
      return;
    }
    // 手机：只有刷新页面、或界面崩溃后自动重开时才接回刚才的对话；从后台关掉再打开就停在首页
    const reopened = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload' || globalThis.__jarvisRecentCrash === true;
    if ((!COMPACT || reopened) && recent && Date.now() - recent.updatedAt < 6 * 3600_000 && !app.history.length) {
      if (app.server)
        await app.openSession(recent.id); // 服务器的列表不带消息：先显示副本，再取完整的
      else await app.switchTo(recent);
    }
    app.sessionsPanel.refresh();
  }

  /** 手机：设置里“查看未完成任务”（本机其他未完成任务仍可查看，不因恢复最新一条而丢失） */
  function initPendingList() {
    if (!MOBILE) return;
    const recovery = document.createElement('section');
    recovery.className = 'pending-recovery-list';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn';
    toggle.textContent = '查看未完成任务';
    const list = document.createElement('div');
    list.hidden = true;
    recovery.append(toggle, list);
    document.querySelector('[data-pane="settings"]').append(recovery);
    const draw = () => {
      list.replaceChildren();
      const rows = listPending(storage);
      if (!rows.length) {
        list.textContent = '没有保留的未完成任务。';
        return;
      }
      for (const rec of rows) {
        const card = document.createElement('div'),
          title = document.createElement('p');
        title.textContent = rec.title || String(rec.text || '未完成任务').slice(0, 40);
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'btn sm';
        open.textContent = '查看并继续';
        open.onclick = async () => {
          await app.openSession(rec.sessionId);
          app.prompt.value = resumeText(rec);
          app.autosize();
          app.showPanel('settings', { toggle: true });
          app.prompt.focus();
        };
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'btn ghost sm';
        dismiss.textContent = '不再继续';
        dismiss.onclick = () => {
          clearPending(storage, rec.sessionId, rec.turnId);
          draw();
        };
        card.append(title, open, dismiss);
        list.append(card);
      }
    };
    toggle.onclick = () => {
      list.hidden = !list.hidden;
      if (!list.hidden) draw();
    };
  }

  return { resumeOnStart, initPendingList };
}
