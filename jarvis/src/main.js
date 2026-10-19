import { checkpointNeedsReview } from '../shared/taskCheckpoint.js';
/**
 * 未央前端入口：状态管理层 + 渲染策略控制器。
 *
 *   感知（人脸 / VAD / 识别） ─┐
 *   智能体事件（agent.js）     ─┼─▶ EmotionMachine ─▶ ParamTween(400ms) ─┐
 *   注入事件（SSE）           ─┘                                        ├─▶ stage.frame()
 *   人脸角度 / 麦克风包络 / 播报包络 ─────────────────────────────────┘
 *
 * 主视觉默认是“光核”（发光能量球 + 会变形状的眼睛），可切换为全息胸像 / 线框胸像。
 * 情绪通过颜色、眼睛形状、轮廓光强度、光环转速与扫描速度表达。
 * 减少动画：在初始化 WebGL 之前判断，命中则根本不 import three.js、不下载网格。
 */
import { initWorkbench } from './ui/workbench.js';
import logoUrl from './ui/logo.svg';
import { initMascots } from './ui/mascot.js';
import { initCompanion } from './ui/companion.js';
import { initHologramCompanion } from './ui/hologramScene.js';
import { initRenderHealthPanel } from './mobile/renderHealth.js';
import { initCompanionAppearance } from './ui/companionAppearance.js';
let companion = null;
import { initConversationComposer } from './ui/conversationComposer.js';
let mascots = null;
let composer = null;

// 浏览器标签页图标：未央 logo（小图直接内联，单文件版也能显示）
document.head.append(Object.assign(document.createElement('link'), { rel: 'icon', type: 'image/svg+xml', href: logoUrl }));
import './mobile/boot.js'; // 安卓 App：先装好原生网络 / 朗读（其他版本里是空的）
import { loadSettings, saveSettings } from './core/settings.js';
import * as ws from './agent/workspace.js';
import * as agentMemory from './agent/memory.js';
import { loadConfig, saveConfig } from './llm/config.js';
import * as skillPacks from './agent/skillPacks.js';
import { storageProblem } from './agent/store.js';
import * as habits from './agent/habits.js';
import * as sessionsApi from './agent/sessions.js';
import { initSessionsPanel } from './ui/sessionsPanel.js';
import { openingSuggestions } from './core/suggest.js';
import { savePending, clearPending, takePending, resumeText, listPending } from './core/pendingTask.js';
import { initServerPanel } from './ui/serverPanel.js';
import { createSyncController } from './sync/controller.js';
import { initSyncPanel, describeResult } from './ui/syncPanel.js';
import { MOBILE } from './config.js';
import { initDrawer } from './ui/drawer.js';
import { loadMemory, clearMemory } from './core/memoryStore.js';
import { $, body, DESKTOP, COMPACT, storage, narrow, toast, wp } from './app/env.js';
import { createApp, mount } from './app/context.js';
import { createStage } from './app/stage.js';
import { createModels } from './app/models.js';
import { createPanels, PANES } from './app/panels.js';
import { createView } from './app/view.js';
import { createBackground } from './app/background.js';
import { createToolbox } from './app/toolbox.js';
import { createRemoteTask } from './app/remoteTask.js';
import { createConversations } from './app/conversations.js';
import { createVoice } from './app/voice.js';
import { createComposer } from './app/composer.js';
import { createTurn } from './app/turn.js';


// ---------------------------------------------------------------- 设置
const settings = loadSettings();
/** 各模块共用的状态和函数（见 app/context.js） */
const app = createApp({ settings });
function setSetting(key, value) {
  settings[key] = value;
  // 通话临时启用的朗读 / 唤醒词不覆盖用户保存的偏好。
  saveSettings(app.callRestore ? { ...settings, ...app.callRestore } : settings);
}
// main.js 里还没拆出去的函数：先挂到 app 上，拆出去的模块用 app.xxx 调用（函数声明会提升，这里就能挂）
Object.assign(app, { setSetting });
Object.defineProperties(app, { mascots: { get: () => mascots }, composer: { get: () => composer }, companion: { get: () => companion } });


mount(app, createStage(app));
mount(app, createModels(app));


// ---------------------------------------------------------------- 对话
mount(app, createConversations(app));
mount(app, createVoice(app));
mount(app, createTurn(app));

mount(app, createBackground(app));


// ---------------------------------------------------------------- 桌面版与 MCP
mount(app, createToolbox(app));
mount(app, createRemoteTask(app));






mount(app, createComposer(app));

mount(app, createPanels(app));

mount(app, createView(app));
globalThis.__jarvisToast = toast; // 手机原生保存文件时的进度提示



// ---------------------------------------------------------------- 恢复上次的设置
$('#set-tts').checked = settings.readTyped;
$('#set-wake').checked = settings.wakeWord;
$('#set-quality').value = settings.quality;
app.dashboard.setTurns(app.history.filter((m) => m.role === 'user').length);
$('#set-motion').value = settings.reducedMotion;
for (const x of document.querySelectorAll('#set-vad button')) x.setAttribute('aria-checked', String(x.dataset.v === settings.vadSensitivity));
app.setFocusView(settings.focusView);
app.applyEmotionOverride(settings.emotionOverride);
app.applyMotionMode();
// 摄像头 / 麦克风不随页面加载申请权限：上次开着的开关，只有在浏览器已授予权限（不会弹窗）时才自动恢复，
// 否则复位为关闭，等用户再次主动开启
app.restoreDevice('camera', 'faceFollow', app.setFaceFollow);
// 兼容显示（上次界面崩过）时不自动开麦克风：先让界面稳稳打开，需要时再手动开
if (!app.mic.hidden && !(MOBILE && document.documentElement.classList.contains('safe-render'))) app.restoreDevice('microphone', 'directVoice', app.setDirectVoice);


// ---------------------------------------------------------------- 启动
app.updateModelLabels();
app.detectGateway();
app.panels.refreshMind();
let startPane = 'workspace';
try { startPane = localStorage.getItem('jarvis.pane') || startPane; } catch { /* ignore */ }
if (narrow.matches) body.classList.add('side-closed');
app.showPanel(PANES.includes(startPane) ? startPane : 'workspace');
if (narrow.matches) body.classList.remove('side-open');
app.setTask('idle');
app.renderWelcome();
app.syncMemoryEngine();
app.sessionsPanel = initSessionsPanel({
  getCurrentId: () => app.session.id,
  onOpen: (id) => app.openSession(id),
  onNew: () => app.newSession(),
  onDeleted: (id) => { if (id === app.session.id) app.switchTo(sessionsApi.create()); },
  settings,
  onSaveChange: (on) => {
    setSetting('saveSessions', on);
    if (on) app.persistSession();
    toast(on ? '对话会保存在本机，可在“对话”里找回' : '新的对话不再保存（已保存的不受影响）');
  }
});
// ---------------------------------------------------------------- 多设备同步（阿里云 OSS，端到端加密）
const syncController = createSyncController({
  storage,
  getGateway: () => app.gateway,
  loadConfig,
  saveConfig,
  beforeSync: () => habits.flush(),
  afterSync: async (r) => {
    if (r.memory?.changedLocal) { await habits.reload(); app.panels.refreshMind(); skillPacks.changed(); }
    if (r.config?.changedLocal) app.panels.reloadConfig();
    if (r.sessions?.changedLocal) {
      app.sessionsPanel.refresh();
      // 当前对话在另一台设备上接着聊过：没在回答时换成合并后的版本
      const fresh = !app.active && app.history.length ? await sessionsApi.get(app.session.id) : null;
      if (fresh && fresh.messages.length !== app.history.length) {
        app.session = fresh;
        app.reflectFrom = app.history.length;
        app.replayTranscript();
      }
    }
  },
  onState: ({ state, result, error, manual }) => {
    syncPanel?.render();
    if (state === 'done' && !manual && Object.values(result).some((g) => g.pulled)) toast(`已从其他设备同步：${describeResult(result)}`);
    if (state === 'error' && !manual) console.warn('[同步]', error);
  }
});
const syncPanel = initSyncPanel({ controller: syncController, toast: (t) => toast(t) });
initServerPanel({ getLlmConfig: () => app.llmConfig, toast: (t) => toast(t), onConfigSaved: () => app.refreshServerModel(), onImported: () => { app.sessionsPanel?.refresh(); app.drawer?.refresh?.(); } });
syncController.start();

// 手机：底部菜单改成左侧抽屉（新对话 · 功能 · 历史对话）；面板全屏打开，左上角“返回对话”
if (COMPACT) {
  const icons = Object.fromEntries([...document.querySelectorAll('.rail-btn')].map((b) => [b.dataset.panel, b.querySelector('svg').outerHTML]));
  app.drawer = initDrawer({
    icons,
    onNew: () => { app.newSession(); app.closeSide(); },
    onOpenSession: (id) => { app.openSession(id); app.closeSide(); },
    onPanel: (name) => app.showPanel(name),
    listSessions: () => sessionsApi.list(),
    cachedSessions: () => sessionsApi.cachedList(),
    currentId: () => app.session.id,
    onRename: async (id, title) => {
      await sessionsApi.rename(id, title);
      if (id === app.session.id) { app.session.title = title; app.session.titleSet = true; app.showChatTitle(); }
      app.sessionsPanel?.refresh();
    },
    onPin: async (id, pinned) => { await sessionsApi.setPinned(id, pinned); if (id === app.session.id) app.session.pinned = pinned; app.sessionsPanel?.refresh(); },
    onExport: (id, kind) => app.exportSession(id, kind),
    searchContent: (q) => sessionsApi.searchContent(q),
    onDelete: async (id) => {
      await sessionsApi.remove(id);
      if (id === app.session.id) app.switchTo(sessionsApi.create());
      app.sessionsPanel?.refresh();
      toast('已删除');
    }
  });
  $('#btn-menu').hidden = false;
  $('#btn-menu').addEventListener('click', () => app.drawer.open());
  $('#btn-side-back').hidden = false;
  $('#btn-side-back').addEventListener('click', () => app.closeSide());
}

app.initSchedules();
// 旧版的单条对话流迁移成会话；最近 6 小时内的对话自动接着聊
(async () => {
  // 本地数据库打不开（比如另一个标签页还开着旧版、挡住了升级）：告诉用户，并且不做迁移，免得旧数据迁到临时存储里丢掉
  const problem = await storageProblem().catch(() => '');
  if (problem) { toast(problem); return; }
  if (settings.persistMemory) {
    await sessionsApi.migrateLegacy(loadMemory(storage)).catch(() => null);
    clearMemory(storage);
    setSetting('persistMemory', false);
  }
  const [recent] = await sessionsApi.list().catch(() => []);
  // 手机：上次 App 被关掉时有任务做到一半：回到那个对话接着做
  const left = MOBILE ? takePending(storage) : null;
  const leftSession = left && await sessionsApi.get(left.sessionId).catch(() => null);
  if(left&&(!leftSession||app.history.length))savePending(storage,left.sessionId,left);
  if (leftSession && !app.history.length) {
    await app.switchTo(leftSession);
    if(checkpointNeedsReview(left.checkpoint)) {
      savePending(storage,left.sessionId,left);
      const card=document.createElement('section');card.className='task-recovery';card.setAttribute('role','status');
      const note=document.createElement('p');note.textContent='上次退出时有操作的结果未确认，先核对再继续，避免重复执行。';
      const resume=document.createElement('button');resume.type='button';resume.textContent='核对并继续';resume.onclick=()=>{card.remove();app.send(resumeText(left));};
      const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='不再继续';dismiss.onclick=()=>{clearPending(storage,left.sessionId,left.turnId);card.remove();};
      card.append(note,resume,dismiss);$('#transcript').append(card);
    } else {
      toast('上次退出时任务还没做完，正在核对进度后继续');app.send(resumeText(left));
    }
    app.sessionsPanel.refresh();
    return;
  }
  // 手机：只有刷新页面、或界面崩溃后自动重开时才接回刚才的对话；从后台关掉再打开就停在首页
  const reopened = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload' || globalThis.__jarvisRecentCrash === true;
  if ((!COMPACT || reopened) && recent && Date.now() - recent.updatedAt < 6 * 3600_000 && !app.history.length) {
    if (app.server) await app.openSession(recent.id); // 服务器的列表不带消息：先显示副本，再取完整的
    else await app.switchTo(recent);
  }
  app.sessionsPanel.refresh();
})();
agentMemory.maintain().catch(() => {});

// ---------------------------------------------------------------- 光核旁的建议标注
app.bootSequence();

app.initSuggestions();
app.updateStageMode();
app.callouts.set(openingSuggestions({ desktop: Boolean(DESKTOP), hasSkills: false }));
if (!app.history.length) app.openingCallouts(false);

// ---------------------------------------------------------------- 键盘快捷键
//   Esc 打断   /  聚焦输入框   Alt+1..6 面板   Alt+F 专注视图   Alt+V 直接对话
//   Alt+O / Alt+H / Alt+W 光核 / 胸像 / 线框   按住空格：按下说话（降级模式、焦点不在输入框时）
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (app.interrupt()) { e.preventDefault(); toast('已打断'); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyO') {
    e.preventDefault();
    app.newSession();
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const k = e.code;
    const n = /^Digit([1-8])$/.exec(k)?.[1];
    if (n) app.showPanel(PANES[n - 1]);
    else if (k === 'KeyF') app.setFocusView(!settings.focusView);
    else if (k === 'KeyV' && !app.mic.hidden) app.toggleDictation();
    else return;
    e.preventDefault();
    return;
  }
  if (typing(document.activeElement)) return;
  if (e.key === '/') {
    e.preventDefault();
    app.prompt.focus();
  } else if (e.code === 'Space' && app.voice.mode === 'ptt' && !e.repeat) {
    e.preventDefault();
    app.mic.classList.add('ptt-active');
    app.voice.pttStart();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && app.voice.mode === 'ptt' && app.mic.classList.contains('ptt-active')) {
    app.mic.classList.remove('ptt-active');
    app.voice.pttEnd();
  }
});

// 调试 / 自动化测试入口
window.__jarvis = {
  machine: app.machine,
  speaker: app.speaker,
  get voice() { return app.voice; },
  get skills() { return app.skillsPanel; },
  get palette() { return app.palette; },
  get mcp() { return app.mcpPanel; },
  get localModels() { return app.localModels; },
  greetOnReturn: app.greetOnReturn,
  habits,
  memorizeHabits: app.memorizeHabits,
  director: app.director,
  get callouts() { return app.callouts; },
  schedulerTick: app.schedulerTick,
  reflectNow: app.reflectNow,
  settings,
  live: app.live,
  get stage() { return app.stage; },
  get config() { return app.llmConfig; },
  get gateway() { return app.gateway; },
  panels: app.panels,
  send: app.send,
  interrupt: app.interrupt,
  showPanel: app.showPanel,
  newSession: app.newSession,
  openSession: app.openSession,
  get sessionId() { return app.session.id; },
  sessionGet: (id) => sessionsApi.get(id),
  get quality() { return app.quality; },
  workspace: ws
};

// 工作台界面只用在电脑上；手机 App 保留自己的界面（底部输入、左侧抽屉菜单、整页面板）
if (!COMPACT) initWorkbench({showPanel: app.showPanel,newSession: app.newSession,openSession: app.openSession,getSession:()=>app.session,getRunning:()=>app.active && !app.active.streamDone ? app.session.id : null,openFile:app.openInWorkspace});
mascots = initMascots();
companion = initCompanion({ send: app.send, startVoice: async () => { await app.setVoiceCall(true); return app.callActive; }, stopVoice: () => app.setVoiceCall(false), speak: text => { app.speaker.unlock(); app.speaker.speak(text); } });
const hologram = initHologramCompanion({send:async text=>{if(app.active)throw new Error('当前任务还在进行，请稍等完成后再发送。');await app.send(text);},onFull:()=>{body.classList.add('side-closed');body.classList.remove('side-open');document.querySelector('.wb-tabs button')?.click();},wallpaper:MOBILE?async()=>{const {registerPlugin}=await import('@capacitor/core');await registerPlugin('CompanionWallpaper').open();}:null});
const holoEntry=Object.assign(document.createElement('button'),{type:'button',className:'wy-hologram-entry',textContent:'✧ 全息陪伴'});
holoEntry.onclick=()=>{companion.close();hologram.open();};document.querySelector('.wy-companion-head span').after(holoEntry);
if(DESKTOP?.onWallpaperRequest)DESKTOP.onWallpaperRequest(async request=>{
  if(request.open){hologram.open();return;}
  if(!request.text)return;
  try{if(app.active)throw new Error('当前任务还在进行，请稍等完成后再发送。');await app.send(request.text);const reply=[...document.querySelectorAll('#transcript .msg.agent')].at(-1);const text=[...(reply?.querySelectorAll('.body')||[])].map(el=>el.textContent).join('\n');wp({say:text||'本轮已结束，可以打开完整对话查看结果。',requestId:request.id});}
  catch(error){wp({say:`这次没有完成：${error.message||error}`,requestId:request.id,error:true});}
});
if(MOBILE){import('@capacitor/core').then(({registerPlugin})=>{const plugin=registerPlugin('CompanionWallpaper');const check=async()=>{try{const r=await plugin.consumeOpen();if(r.open)hologram.open();}catch{}};check();document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});}).catch(()=>{});}
composer = initConversationComposer({cancelDictation:()=>app.stopDictation()});
initCompanionAppearance();
initRenderHealthPanel({ mobile: MOBILE, toast, onChange: () => { if (!app.active) app.replayTranscript(); } });

// 手机启动页：界面准备好、并且至少显示了 2 秒后淡出（太快一闪而过不像 App）
{
  const splash = document.getElementById('app-splash');
  if (splash) {
    const wait = MOBILE ? Math.max(0, 2000 - performance.now()) : 0;
    setTimeout(() => { splash.classList.add('out'); setTimeout(() => splash.remove(), 420); }, wait);
  }
}


// 本机其他未完成任务仍可查看，不因恢复最新一条而丢失。
if(MOBILE){
  const recovery=document.createElement('section');recovery.className='pending-recovery-list';
  const toggle=document.createElement('button');toggle.type='button';toggle.className='btn';toggle.textContent='查看未完成任务';
  const list=document.createElement('div');list.hidden=true;recovery.append(toggle,list);document.querySelector('[data-pane="settings"]').append(recovery);
  const draw=()=>{list.replaceChildren();const rows=listPending(storage);if(!rows.length){list.textContent='没有保留的未完成任务。';return;}
    for(const rec of rows){const card=document.createElement('div'),title=document.createElement('p');title.textContent=rec.title||String(rec.text||'未完成任务').slice(0,40);
      const open=document.createElement('button');open.type='button';open.className='btn sm';open.textContent='查看并继续';open.onclick=async()=>{await app.openSession(rec.sessionId);app.prompt.value=resumeText(rec);app.autosize();app.showPanel('settings',{toggle:true});app.prompt.focus();};
      const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='btn ghost sm';dismiss.textContent='不再继续';dismiss.onclick=()=>{clearPending(storage,rec.sessionId,rec.turnId);draw();};card.append(title,open,dismiss);list.append(card);
    }
  };toggle.onclick=()=>{list.hidden=!list.hidden;if(!list.hidden)draw();};
}


