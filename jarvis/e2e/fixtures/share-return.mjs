/** 仅原生Share/App与应用切会话端口用测试替身；被测分享/恢复模块、DOM、IndexedDB和localStorage均真实。 */
import { createNativeSharer } from '/src/mobile/saveNative.js';
import { createShareReturnCoordinator, shareAccountScope, SHARE_RETURN_KEY } from '/src/mobile/shareReturn.js';
import { createShareRecovery } from '/src/app/shareReturn.js';
import { createNewSessionAction } from '/src/app/sessionNavigation.js';
import * as sessions from '/src/agent/sessions.js';
import * as workspace from '/src/agent/workspace.js';

const sourcePath = '分享验收/原图.png';
const fixtureAccountKey = 'fixture.share.account';
const fixtureNoticeKey = 'fixture.share.notification';
const initialAccount = { url: 'https://fixture.invalid', userId: 'fixture-user-a', token: 'fixture-only-login-a' };
if (!localStorage.getItem(fixtureAccountKey)) localStorage.setItem(fixtureAccountKey, JSON.stringify(initialAccount));
const account = () => JSON.parse(localStorage.getItem(fixtureAccountKey));
const restoring = new URL(location.href).searchParams.has('restore');
const slowRestore = new URL(location.href).searchParams.has('slow');
const original = { ...sessions.create(), id: 'c_share_original', title: '分享前的对话', messages: [{ role: 'user', content: '保留这个海报，不要重复生成' }, { role: 'assistant', content: '图片已保存在工作区' }] };
if (!restoring) {
  await sessions.save(original);
  // 真实画布PNG，后续比对工作区原字节与分享插件拿到的Base64。
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
  const pen = canvas.getContext('2d'); pen.fillStyle = '#17304a'; pen.fillRect(0, 0, 320, 240); pen.fillStyle = '#ffffff'; pen.font = '28px sans-serif'; pen.fillText('未央分享验收', 25, 125);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  await workspace.write(sourcePath, blob);
}
const calls = { share: [], prepare: [], finish: [], writes: [], removed: [], send: 0, reflect: 0, switch: 0, toasts: [] };
let active = true, notificationAllowed = true, pendingNative = null;
let cacheFolders = [], releaseRead;
const app = { server: null, active: null, session: restoring ? { id: 'c_empty', messages: [] } : original };
app.prompt = document.getElementById('prompt');
Object.defineProperty(app, 'history', { get: () => app.session.messages });
const render = () => {
  document.getElementById('session').textContent = app.session.id;
  document.getElementById('transcript').textContent = app.history.map(message => message.content).join('\n');
};
app.send = () => { calls.send++; };
app.reflectNow = () => { calls.reflect++; };
// 应用端口记录是否要求反思、是否尊重迟到守护，不替换待测restore实现。
app.switchTo = async (session, options = {}) => {
  if (options.isCurrent && !options.isCurrent()) return false;
  if (options.reflect !== false) app.reflectNow();
  app.session = session; calls.switch++; render(); return true;
};
const native = {
  prepare: async ({ id }) => {
    calls.prepare.push(id);
    if (notificationAllowed) localStorage.setItem(fixtureNoticeKey, id);
    return { notification: notificationAllowed };
  },
  finish: async ({ id }) => {
    calls.finish.push(id);
    if (localStorage.getItem(fixtureNoticeKey) === id) localStorage.removeItem(fixtureNoticeKey);
  }
};
const coordinator = createShareReturnCoordinator({ storage: localStorage, native, context: () => globalThis.__jarvisGetShareContext?.(), foreground: () => active });
const recovery = createShareRecovery(app, {
  coordinator, scope: () => shareAccountScope(account(), false), toast: message => calls.toasts.push(message),
  getSession: async id => {
    if (slowRestore) { window.shareFixture.waiting = true; await new Promise(resolve => { releaseRead = resolve; }); }
    return sessions.get(id);
  }
});
const share = createNativeSharer({
  Filesystem: {
    readdir: async () => ({ files: cacheFolders }),
    rmdir: async value => { calls.removed.push(value.path); cacheFolders = cacheFolders.filter(entry => 'share/' + entry.name !== value.path); },
    writeFile: async value => {
      calls.writes.push(value);
      cacheFolders.push({ name: value.path.split('/')[1], type: 'directory', mtime: Date.now() });
      return { uri: 'file:///cache/' + value.path };
    }
  },
  Directory: { Cache: 'CACHE' },
  Share: { share: input => { calls.share.push(input); return new Promise((resolve, reject) => { pendingNative = { resolve, reject }; }); } },
  shareReturn: coordinator,
  toast: message => calls.toasts.push(message)
});
document.getElementById('share').onclick = async () => {
  try { document.getElementById('result').textContent = await share(await workspace.readBlob(sourcePath), '原图.png'); }
  catch (error) { document.getElementById('error').textContent = error.message; }
};
document.getElementById('new-session').onclick = createNewSessionAction(app, { create: () => ({ ...sessions.create(), id: 'c_user_new' }), focus: () => app.prompt.focus() });
window.addEventListener('fixture:app-state', event => {
  active = event.detail.isActive;
  document.getElementById('foreground').textContent = active ? '未央前台' : '微信（模拟外部App）';
  coordinator.foreground(active);
});
document.getElementById('viewer-name').textContent = sourcePath;
render();
window.shareFixture = {
  calls, app, recovered: null, sourcePath, waiting: false,
  pending: () => coordinator.pending(),
  rawPending: () => localStorage.getItem(SHARE_RETURN_KEY),
  notice: () => localStorage.getItem(fixtureNoticeKey),
  setNotification: value => { notificationAllowed = value; },
  resolve: () => pendingNative?.resolve({ activityType: 'fixture.wechat' }),
  reject: () => pendingNative?.reject(new Error('Share canceled')),
  foreground: value => dispatchEvent(new CustomEvent('fixture:app-state', { detail: { isActive: value } })),
  changeAccount: () => localStorage.setItem(fixtureAccountKey, JSON.stringify({ ...initialAccount, userId: 'fixture-user-b', token: 'fixture-only-login-b' })),
  originalBytes: async () => [...new Uint8Array(await (await workspace.readBlob(sourcePath)).arrayBuffer())],
  fillRecentCache: () => { cacheFolders = Array.from({ length: 64 }, (_, i) => ({ name: `share_recent_${i}`, type: 'directory', mtime: Date.now() })); },
  allowRead: () => releaseRead?.(),
  ready: !restoring
};
if (restoring) window.shareFixture.recovered = await recovery.restore();
window.shareFixture.ready = true;
