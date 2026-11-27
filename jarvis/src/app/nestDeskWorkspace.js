import { toast } from './env.js';
import * as workspace from '../agent/workspace.js';
import { userStorageSuffix } from '../core/userStorage.js';
import { createWorkspaceFiles } from './workspaceFiles.js';
import { nestFileScope } from './nestFileScope.js';
import { lastTaskReceipt, sameTaskReceipt, verifiedTaskFiles } from './nestTaskDelivery.js';
import { createNestFilePreview } from '../ui/nestFilePreview.js';

export function createNestDeskOptions(app) {
  const getWorkspace = createWorkspaceFiles(app);
  const getScope = () =>
    (app.server ? 'server:' + app.server.base : 'local') + userStorageSuffix() + ':' + workspace.mode() + ':' + (workspace.folderName() || '');
  const owners = new WeakMap();
  const getReceipt = () => {
    const session = app.session;
    if (!session) return null;
    const fileScope = nestFileScope(app.server);
    const owner = app.server ? 'server:' + app.server.base + userStorageSuffix() : fileScope;
    const receipt = lastTaskReceipt(session, owner, fileScope);
    if (!receipt) return null;
    const prior = owners.get(receipt.answer);
    if (prior && (prior.owner !== owner || prior.server !== app.server)) return null;
    if (!prior) owners.set(receipt.answer, { owner, server: app.server });
    return receipt;
  };
  const preview = createNestFilePreview(
    (...args) => app.panels.openFile(...args),
    () => app.panels.releasePreview()
  );
  const current = (receipt) => sameTaskReceipt(receipt, getReceipt());
  async function readResults(receipt) {
    if (!receipt || !current(receipt)) return [];
    const source = getWorkspace();
    await source.restoreFolder();
    if (!current(receipt)) return [];
    const files = await source.list();
    return current(receipt) ? verifiedTaskFiles(receipt, files) : [];
  }
  async function useResult(receipt, file, trigger, edit) {
    const source = getWorkspace();
    function check() {
      source.check();
      if (!current(receipt)) throw new Error('任务或工作区已切换，请重新打开文件夹');
    }
    async function verify() {
      check();
      const match = (await readResults(receipt)).find((f) => f.path === file.path);
      check();
      if (!match || match.size !== file.size || match.mtime !== file.mtime) throw new Error('成品已移动或更新，请重新查看文件夹');
    }
    await verify();
    if (edit) {
      const prompt = document.getElementById('prompt');
      const lead = '继续修改工作区文件「' + file.path + '」';
      if (!prompt.value.includes(lead)) prompt.value = prompt.value.trim() ? prompt.value + '\n' + lead : lead + '，';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      prompt.focus({ preventScroll: true });
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      return;
    }
    preview.open(
      file.path,
      trigger,
      {
        ...source,
        readBlob: async (path) => {
          check();
          const blob = await source.readBlob(path);
          await verify();
          return blob;
        }
      },
      () => current(receipt)
    );
  }
  return {
    getWorkspace,
    getScope,
    getReceipt,
    readResults,
    useResult,
    refreshPreview: preview.refresh,
    closePreview: preview.close,
    openFile: (path) => app.openInWorkspace(path),
    openWorkspace: () => app.showPanel('workspace'),
    notify: toast
  };
}
