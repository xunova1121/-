/** 分享后进程被系统重建：只恢复原会话，不借恢复自动发送、反思或重做任务。 */
import { loadServerSettings } from '../core/serverClient.js';
import { shareAccountScope } from '../mobile/shareReturn.js';
import * as sessions from '../agent/sessions.js';

export function createShareRecovery(
  app,
  {
    coordinator = globalThis.__jarvisShareReturn,
    scope = () => shareAccountScope(loadServerSettings(), Boolean(app.server)),
    getSession = sessions.get,
    toast = () => {}
  } = {}
) {
  if (!coordinator) return { restore: async () => false };
  const currentScope = () =>
    Promise.resolve()
      .then(scope)
      .catch(() => null);
  globalThis.__jarvisGetShareContext = async () => {
    const sessionId = app.history?.length ? app.session?.id : '';
    const viewer = globalThis.document?.getElementById('viewer');
    const filePath = viewer && !viewer.hidden ? globalThis.document.getElementById('viewer-name')?.textContent || '' : '';
    return { sessionId, filePath, scope: await currentScope() };
  };
  return {
    async restore() {
      const saved = coordinator.pending();
      if (!saved) return false;
      const initial = app.session?.id;
      const server = app.server;
      const navigation = app.sessionNavigationVersion || 0;
      const draft = app.prompt?.value || '';
      const stillEmpty = () =>
        !draft &&
        (app.prompt?.value || '') === draft &&
        (app.sessionNavigationVersion || 0) === navigation &&
        app.server === server &&
        app.session?.id === initial &&
        !app.history?.length &&
        !app.active;
      if (!stillEmpty()) {
        coordinator.forget(saved.id);
        return true;
      }
      if (saved.scope !== (await currentScope())) {
        coordinator.forget(saved.id);
        return false;
      }
      try {
        const session = saved.sessionId ? await getSession(saved.sessionId) : null;
        if (!stillEmpty() || saved.scope !== (await currentScope())) return true;
        if (session) {
          // 复用正常切会话清理/展示，但不触发记忆模型；迟到结果也不能抢新对话。
          if (!(await app.switchTo(session, { reflect: false, isCurrent: stillEmpty }))) return true;
        }
        // 文件仍可从恢复的对话成果链接或工作区打开，不在后台自动读大图。
        toast(session ? '已回到分享前的对话，没有重新发送任务' : '已回到未央；刚才的文件仍可在工作区查看');
      } catch {
        toast('已回到未央；原会话暂时未取到，可从对话列表打开，未重新发送任务');
      } finally {
        coordinator.forget(saved.id);
      }
      // 即使网络暂不可用也跳过旧pending自动续做，避免重复执行。
      return true;
    }
  };
}
