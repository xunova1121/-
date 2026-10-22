/**
 * 未央前端入口：只负责“组装”——按顺序创建各模块、恢复上次的设置、启动。具体功能都在 app/ 下：
 *
 *   app/context.js        app 上下文：各模块共用的状态（当前对话、正在回答的一轮……）和彼此的函数
 *   app/env.js            运行环境和小工具（取元素、手机 / 桌面版、提示条……）
 *   app/stage.js          主视觉：光核舞台、情绪、仪表盘、轨道 HUD、建议标注、顶栏状态
 *   app/models.js         模型与网关、服务器模式连接、辅助模型
 *   app/conversations.js  对话管理：切换、打开、刷新、导出、编辑重发
 *   app/voice.js          朗读、语音识别、语音对话、听写、人脸跟随
 *   app/turn.js           一轮对话：发消息、事件显示、插话、打断、后台继续
 *   app/background.js     记忆整理、压缩、主动问好、习惯学习、定时任务
 *   app/toolbox.js        智能体工具组装（含电脑操作、MCP）
 *   app/remoteTask.js     服务器模式：接上服务器上的任务、取回文件
 *   app/composer.js       输入框、附件、引用 / 朗读
 *   app/panels.js         右侧面板
 *   app/view.js           欢迎页、命令面板、主题、更新提示、设置开关、开机动画
 *   app/sessionLists.js   “对话”面板、手机左侧抽屉
 *   app/sync.js           服务器模式设置面板
 *   app/recovery.js       启动时接回上次的对话 / 没做完的任务
 *   app/shortcuts.js      键盘快捷键
 *   app/screenAwake.js    屏幕常亮：说话时不灭、久不碰调暗
 *
 * 模块的创建顺序就是原来 main.js 里各段代码的先后顺序，不要随意调换（后面的模块创建时会用到前面的）。
 * 新功能放进对应模块，不要往这里加。写法规范见 docs/代码规范.md。
 */
import './mobile/boot.js'; // 安卓 App：先装好原生网络 / 朗读（其他版本里是空的）
import logoUrl from './ui/logo.svg';
import { MOBILE } from './config.js';
import { loadSettings, saveSettings } from './core/settings.js';
import { openingSuggestions } from './core/suggest.js';
import * as ws from './agent/workspace.js';
import * as agentMemory from './agent/memory.js';
import * as habits from './agent/habits.js';
import * as sessionsApi from './agent/sessions.js';
import { initWorkbench } from './ui/workbench.js';
import { initMascots } from './ui/mascot.js';
import { initCompanion } from './ui/companion.js';
import { initHologramCompanion } from './ui/hologramScene.js';
import { initCompanionAppearance } from './ui/companionAppearance.js';
import { initConversationComposer } from './ui/conversationComposer.js';
import { initRenderHealthPanel } from './mobile/renderHealth.js';
import { $, body, DESKTOP, COMPACT, narrow, toast, wp } from './app/env.js';
import { createApp, mount } from './app/context.js';
import { createStage } from './app/stage.js';
import { createModels } from './app/models.js';
import { createConversations } from './app/conversations.js';
import { createVoice } from './app/voice.js';
import { createVoiceDevices } from './app/voiceDevices.js';
import { createTurnInputs } from './app/turnInputs.js';
import { createTurnEvents } from './app/turnEvents.js';
import { createTurn } from './app/turn.js';
import { createBackground } from './app/background.js';
import { createToolbox } from './app/toolbox.js';
import { createRemoteTask } from './app/remoteTask.js';
import { createComposer } from './app/composer.js';
import { createPanels, PANES } from './app/panels.js';
import { createModelWorkspace } from './app/modelWorkspace.js';
import { createView } from './app/view.js';
import { createSessionLists } from './app/sessionLists.js';
import { createSync } from './app/sync.js';
import { createRecovery } from './app/recovery.js';
import { createShortcuts } from './app/shortcuts.js';
import { createScreenAwake } from './app/screenAwake.js';

// 浏览器标签页图标：未央 logo（小图直接内联，单文件版也能显示）
document.head.append(Object.assign(document.createElement('link'), { rel: 'icon', type: 'image/svg+xml', href: logoUrl }));

// ---------------------------------------------------------------- 设置
const settings = loadSettings();
/** 各模块共用的状态和函数（见 app/context.js） */
const app = createApp({ settings });
function setSetting(key, value) {
  settings[key] = value;
  // 通话临时启用的朗读 / 唤醒词不覆盖用户保存的偏好。
  saveSettings(app.callRestore ? { ...settings, ...app.callRestore } : settings);
}
app.setSetting = setSetting;
// 启动末尾才创建的几个界面部件（形象、全息陪伴、输入框外观）
let mascots = null;
let companion = null;
let composer = null;
Object.defineProperties(app, { mascots: { get: () => mascots }, composer: { get: () => composer }, companion: { get: () => companion } });

// ---------------------------------------------------------------- 各模块（按这个顺序创建）
mount(app, createStage(app));
mount(app, createModels(app));
mount(app, createConversations(app));
mount(app, createVoice(app));
mount(app, createVoiceDevices(app));
mount(app, createTurnInputs(app));
mount(app, createTurnEvents(app));
mount(app, createTurn(app));
mount(app, createBackground(app));
mount(app, createToolbox(app));
mount(app, createRemoteTask(app));
mount(app, createComposer(app));
mount(app, createPanels(app));
mount(app, createModelWorkspace(app));
mount(app, createView(app));
mount(app, createSessionLists(app));
mount(app, createSync(app));
mount(app, createRecovery(app));
mount(app, createShortcuts(app));
mount(app, createScreenAwake(app));
globalThis.__jarvisToast = toast; // 手机原生保存文件时的进度提示

// ---------------------------------------------------------------- 恢复上次的设置
$('#set-tts').checked = settings.readTyped;
$('#set-wake').checked = settings.wakeWord;
$('#set-quality').value = settings.quality;
app.dashboard.setTurns(app.history.filter((m) => m.role === 'user').length);
$('#set-motion').value = settings.reducedMotion;
for (const x of document.querySelectorAll('#set-vad button')) x.setAttribute('aria-checked', String(x.dataset.v === settings.vadSensitivity));
app.setFocusView(settings.focusView);
app.applyEmotionOverride('auto'); // 设置里的“表情手动锁定”已去掉：每次启动都按对话自动变化
app.applyMotionMode();
// 摄像头 / 麦克风不随页面加载申请权限：上次开着的开关，只有在浏览器已授予权限（不会弹窗）时才自动恢复，
// 否则复位为关闭，等用户再次主动开启
app.restoreDevice('camera', 'faceFollow', app.setFaceFollow);
// 兼容显示（上次界面崩过）时不自动开麦克风：先让界面稳稳打开，需要时再手动开
if (!app.mic.hidden && !(MOBILE && document.documentElement.classList.contains('safe-render')))
  app.restoreDevice('microphone', 'directVoice', app.setDirectVoice);

// ---------------------------------------------------------------- 启动
app.updateModelLabels();
app.detectGateway();
app.panels.refreshMind();
let startPane = 'workspace';
try {
  startPane = localStorage.getItem('jarvis.pane') || startPane;
} catch {
  /* ignore */
}
if (narrow.matches) body.classList.add('side-closed');
app.showPanel(PANES.includes(startPane) ? startPane : 'workspace');
if (narrow.matches) body.classList.remove('side-open');
app.setTask('idle');
app.renderWelcome();
app.syncMemoryEngine();
app.initSessionsPanel();
app.initSync();

app.initDrawer();
app.initSchedules();
app.resumeOnStart();
agentMemory.maintain().catch(() => {});

// ---------------------------------------------------------------- 光核旁的建议标注
app.bootSequence();

app.initSuggestions();
app.updateStageMode();
app.callouts.set(openingSuggestions({ desktop: Boolean(DESKTOP), hasSkills: false }));
if (!app.history.length) app.openingCallouts(false);

// ---------------------------------------------------------------- 键盘快捷键
app.initShortcuts();

// 调试 / 自动化测试入口
window.__jarvis = {
  machine: app.machine,
  speaker: app.speaker,
  get voice() {
    return app.voice;
  },
  get skills() {
    return app.skillsPanel;
  },
  get palette() {
    return app.palette;
  },
  get mcp() {
    return app.mcpPanel;
  },
  get localModels() {
    return app.localModels;
  },
  greetOnReturn: app.greetOnReturn,
  habits,
  memorizeHabits: app.memorizeHabits,
  director: app.director,
  get callouts() {
    return app.callouts;
  },
  schedulerTick: app.schedulerTick,
  reflectNow: app.reflectNow,
  settings,
  live: app.live,
  get stage() {
    return app.stage;
  },
  get config() {
    return app.llmConfig;
  },
  get gateway() {
    return app.gateway;
  },
  panels: app.panels,
  send: app.send,
  interrupt: app.interrupt,
  showPanel: app.showPanel,
  newSession: app.newSession,
  openSession: app.openSession,
  get sessionId() {
    return app.session.id;
  },
  sessionGet: (id) => sessionsApi.get(id),
  get quality() {
    return app.quality;
  },
  workspace: ws
};

// 工作台界面只用在电脑上；手机 App 保留自己的界面（底部输入、左侧抽屉菜单、整页面板）
// prettier-ignore
if (!COMPACT) initWorkbench({ showPanel: app.showPanel, newSession: app.newSession, openSession: app.openSession, getSession: () => app.session, getRunning: () => (app.active && !app.active.streamDone ? app.session.id : null), openFile: app.openInWorkspace });
mascots = initMascots();
companion = initCompanion({
  send: app.send,
  startVoice: async () => {
    await app.setVoiceCall(true);
    return app.callActive;
  },
  stopVoice: () => app.setVoiceCall(false),
  speak: (text) => {
    app.speaker.unlock();
    app.speaker.speak(text);
  }
});
const hologram = initHologramCompanion({
  send: async (text) => {
    if (app.active) throw new Error('当前任务还在进行，请稍等完成后再发送。');
    await app.send(text);
  },
  onFull: () => {
    body.classList.add('side-closed');
    body.classList.remove('side-open');
    document.querySelector('.wb-tabs button')?.click();
  },
  wallpaper: MOBILE
    ? async () => {
        const { registerPlugin } = await import('@capacitor/core');
        await registerPlugin('CompanionWallpaper').open();
      }
    : null
});
const holoEntry = Object.assign(document.createElement('button'), { type: 'button', className: 'wy-hologram-entry', textContent: '✧ 全息陪伴' });
holoEntry.onclick = () => {
  companion.close();
  hologram.open();
};
document.querySelector('.wy-companion-head span').after(holoEntry);
if (DESKTOP?.onWallpaperRequest)
  DESKTOP.onWallpaperRequest(async (request) => {
    if (request.open) {
      hologram.open();
      return;
    }
    if (!request.text) return;
    try {
      if (app.active) throw new Error('当前任务还在进行，请稍等完成后再发送。');
      await app.send(request.text);
      const reply = [...document.querySelectorAll('#transcript .msg.agent')].at(-1);
      const text = [...(reply?.querySelectorAll('.body') || [])].map((el) => el.textContent).join('\n');
      wp({ say: text || '本轮已结束，可以打开完整对话查看结果。', requestId: request.id });
    } catch (error) {
      wp({ say: `这次没有完成：${error.message || error}`, requestId: request.id, error: true });
    }
  });
if (MOBILE) {
  import('@capacitor/core')
    .then(({ registerPlugin }) => {
      const plugin = registerPlugin('CompanionWallpaper');
      const check = async () => {
        try {
          const r = await plugin.consumeOpen();
          if (r.open) hologram.open();
        } catch {}
      };
      check();
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check();
      });
    })
    .catch(() => {});
}
composer = initConversationComposer({ cancelDictation: () => app.stopDictation() });
initCompanionAppearance();
initRenderHealthPanel({
  mobile: MOBILE,
  toast,
  onChange: () => {
    if (!app.active) app.replayTranscript();
  }
});

// 手机启动页：界面准备好、并且至少显示了 2 秒后淡出（太快一闪而过不像 App）
{
  const splash = document.getElementById('app-splash');
  if (splash) {
    const wait = MOBILE ? Math.max(0, 2000 - performance.now()) : 0;
    setTimeout(() => {
      splash.classList.add('out');
      setTimeout(() => splash.remove(), 420);
    }, wait);
  }
}

app.initPendingList();
