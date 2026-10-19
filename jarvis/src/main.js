import { checkpointEvent, checkpointNeedsReview } from '../shared/taskCheckpoint.js';
import { openQwenSession, QWEN_ASR } from './perception/qwenRealtime.js';
import { QwenVoice } from './perception/qwenVoice.js';
/**
 * 未央前端入口：状态管理层 + 渲染策略控制器。
 *
 *   感知（人脸 / VAD / 识别） ─┐
 *   智能体事件（agent.js）     ─┼─▶ EmotionMachine ─▶ ParamTween(400ms) ─┐
 *   注入事件（SSE）           ─┘                                        ├─▶ app.stage.frame()
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
import { transcriptWindow } from './mobile/transcriptWindow.js';
import { initRenderHealthPanel } from './mobile/renderHealth.js';
import { initCompanionAppearance } from './ui/companionAppearance.js';
let companion = null;
import { imageButton, previewWorkspaceImage } from './ui/imagePreview.js';
import { initCamera } from './ui/composerMedia.js';
import { initConversationComposer } from './ui/conversationComposer.js';
let mascots = null;
let composer = null;
let dictating = false, dictationTimer = null, dictationGeneration = 0;
let callTiming = null;
let callActive = false;
let callStarting = false;
let callGeneration = 0;
let callRestore = null;
let voiceSwitching = false, callCloudFallback = false;

// 浏览器标签页图标：未央 logo（小图直接内联，单文件版也能显示）
document.head.append(Object.assign(document.createElement('link'), { rel: 'icon', type: 'image/svg+xml', href: logoUrl }));
import './mobile/boot.js'; // 安卓 App：先装好原生网络 / 朗读（其他版本里是空的）
import { followTarget } from './core/faceMath.js';
import { SentenceChunker } from './core/sentenceChunker.js';
import { toPlainText, toSpeech } from './core/markdown.js';
import { SILENCE_BY_SENSITIVITY } from './core/vadGate.js';
import { loadSettings, saveSettings } from './core/settings.js';
import { runTeam, shouldTeam } from './agent/team.js';
import { runAgent } from './agent/agent.js';
import { STATUS_ASK, STOP_ASK, turnStatus } from './core/interject.js';
import { collectRequirements } from './agent/taskRequirements.js';
import * as ws from './agent/workspace.js';
import * as agentMemory from './agent/memory.js';
import { loadConfig, saveConfig, createAdapter, providerById, resolveVoice } from './llm/config.js';
import * as skillPacks from './agent/skillPacks.js';
import { preApproved } from './agent/commandSafety.js';
import * as compress from './agent/compress.js';
import { storageProblem } from './agent/store.js';
import * as habits from './agent/habits.js';
import { prepareImage, isImageName } from './agent/images.js';
import * as sessionsApi from './agent/sessions.js';
import { initSessionsPanel } from './ui/sessionsPanel.js';
import { openingSuggestions, followUpSuggestions, interruptionMark } from './core/suggest.js';
import { savePending, clearPending, takePending, resumeText, listPending } from './core/pendingTask.js';
import { runRemote } from './core/serverClient.js';
import { createPCModelAdapter } from './core/pcModelClient.js';
import { initServerPanel } from './ui/serverPanel.js';
import { initQuickPrompts } from './ui/quickPrompts.js';
import { createSyncController } from './sync/controller.js';
import { initSyncPanel, describeResult } from './ui/syncPanel.js';
import { matchWake, WakeWindow } from './core/wakeWord.js';
import { playCue } from './perception/voiceFx.js';
import { Transcript, toolLabel, summarizeArgs, searchBrand, setActionIcon, copyText } from './ui/transcript.js';
import { stripEmotionTags } from '../shared/emotionTag.js';
import { noteAction } from './mobile/renderDiagnostics.js';
import { Speaker } from './perception/speaker.js';
import { VoiceInput, speechRecognitionSupported } from './perception/voiceInput.js';
import { resolveStt, transcribe, encodeWav, sttEngineById } from './perception/stt.js';
import { MOBILE, VAD } from './config.js';
import { NativeVoice } from './mobile/nativeVoice.js';
import { createVoiceLifecycle } from './mobile/voiceLifecycle.js';
import { recordVoiceEvent, readVoiceEvents } from './mobile/voiceDiagnostics.js';
import { createTaskKeeper } from './mobile/backgroundTasks.js';
import { RecordedVoice } from './mobile/recordedVoice.js';
import { initDrawer } from './ui/drawer.js';
import { isAuto } from './ui/modelPicker.js';
import { classifyTask, routeFor, TASKS, fallbackRoutes, effortFor, isSmallTalk, computerTaskKind } from './llm/router.js';
import { loadMemory, clearMemory } from './core/memoryStore.js';
import { $, body, now, DESKTOP, COMPACT, storage, narrow, toast, wp, markActivity } from './app/env.js';
import { createApp, mount } from './app/context.js';
import { createStage } from './app/stage.js';
import { createModels } from './app/models.js';
import { createPanels, PANES } from './app/panels.js';
import { createView } from './app/view.js';
import { createBackground } from './app/background.js';
import { createToolbox } from './app/toolbox.js';
import { createRemoteTask } from './app/remoteTask.js';


// ---------------------------------------------------------------- 设置
const settings = loadSettings();
/** 各模块共用的状态和函数（见 app/context.js） */
const app = createApp({ settings });
function setSetting(key, value) {
  settings[key] = value;
  // 通话临时启用的朗读 / 唤醒词不覆盖用户保存的偏好。
  saveSettings(callRestore ? { ...settings, ...callRestore } : settings);
}
// main.js 里还没拆出去的函数：先挂到 app 上，拆出去的模块用 app.xxx 调用（函数声明会提升，这里就能挂）
Object.assign(app, { setSetting, send, openingCallouts });
Object.defineProperties(app, { speaker: { get: () => speaker }, face: { get: () => face }, mascots: { get: () => mascots } });

Object.defineProperties(app, {
  sessionsPanel: { get: () => sessionsPanel }, transcript: { get: () => transcript }, taskKeeper: { get: () => taskKeeper }
});
Object.assign(app, { newSession, interrupt, switchTo, rememberTurn, openSession, openInWorkspace, replayTranscript });
Object.defineProperty(app, 'mic', { get: () => mic });

mount(app, createStage(app));
mount(app, createModels(app));


// ---------------------------------------------------------------- 对话
const transcript = new Transcript($('#transcript'), { progress: COMPACT });
// 当前会话；app.history 就是它的消息列表（换对话只改 app.session）
app.session = sessionsApi.create();
/** 记一条消息：默认记进当前会话；后台任务记进它自己的会话（切到别的对话后仍然记对地方） */
function rememberTurn(role, content, extra = {}, target = app.session) {
  target.messages.push({ role, content, ts: Date.now(), ...extra });
  target.updatedAt = Date.now();
  persistSession(target);
}
function persistSession(target = app.session) {
  if (settings.saveSessions === false) return;
  return sessionsApi.save(target).then(() => { sessionsPanel?.refresh(); if (target === app.session) showChatTitle(); }).catch(() => {});
}
/** 手机顶栏显示当前对话的标题（还没说话的新对话不显示） */
function showChatTitle() {
  const el = $('#chat-title');
  const first = app.history.find((m) => m.role === 'user')?.content;
  const title = app.session.title || (first ? sessionsApi.autoTitle(first) : '');
  el.textContent = title;
  el.hidden = !title;
}
$('#chat-title').addEventListener('click', async () => {
  const now = $('#chat-title').textContent;
  let next = null;
  try { next = globalThis.prompt('给这段对话起个名字', now); } catch { /* 不支持弹窗 */ }
  next = String(next ?? '').trim().slice(0, 60);
  if (!next || next === now) return;
  app.session.title = next;
  app.session.titleSet = true;
  await sessionsApi.rename(app.session.id, next).catch(() => {});
  showChatTitle();
  sessionsPanel?.refresh();
  drawer?.refresh?.();
});
let turns = 0;
const recentImages = new Map(); // 消息时间 → 这条消息带的图片（只在内存里，不存盘）
const taskKeeper = createTaskKeeper(globalThis.__jarvisBackgroundTask, e => toast(e.message));
const attachments = [];

const speaker = new Speaker({
  onAudioScheduled: ({engine,delayMs}) => {
    if(callActive&&callTiming?.recognizedAt&&!callTiming.audioAt){callTiming.audioAt=now()+delayMs;recordVoiceEvent('通话分段耗时',JSON.stringify({engine,recognitionMs:callTiming.stoppedAt?Math.round(callTiming.recognizedAt-callTiming.stoppedAt):null,modelFirstTextMs:callTiming.firstTextAt?Math.round(callTiming.firstTextAt-callTiming.recognizedAt):null,audioScheduledMs:Math.round(callTiming.audioAt-callTiming.recognizedAt)}));}
  },
  onStart: () => {
    if (callActive) callStatus('未央正在说话…');
    voice.setSuppressed(true);
    body.classList.add('speaking');
  },
  onIdle: () => {
    if (callActive) callStatus('直接说话，未央在听');
    if (wake.awake) wake.wake(); // 回答说完后重新计时，方便接着问
    voice.setSuppressed(false);
    body.classList.remove('speaking');
    if (app.active?.streamDone) finishTurn();
  },
  onBoundary: () => { app.live.boundaryAt = now(); },
  onError: (e) => toast(resolveVoice(app.llmConfig,app.gateway).engine === 'qwen-realtime' ? `${e.message}（所选百炼声音未播放，请检查声音设置）` : `${e.message}（先用系统自带声音朗读，5 分钟后再试）`),
  getVoiceConfig: () => resolveVoice(app.llmConfig, app.gateway),
  getKeys: () => app.llmConfig.keys,
  getConfig: () => app.llmConfig,
  onEngine: (engine,fallback) => { const el = document.querySelector("#tts-status"); if (el) el.textContent = fallback ? "当前已回退系统声音（不是目标女孩童声），请检测语音服务" : `实际播放引擎：${engine}`; if (fallback && callActive) callStatus("在线声音失败，当前为系统声；请检测声音服务"); },
  getGateway: () => app.gateway
});
// 念不念由每一轮自己决定（见 makeSpeech）：语音对话、说话提问时念，打字提问默认不念
speaker.enabled = true;

/** 打断（barge-in）：停止朗读并中止正在执行的任务 */
function interrupt() {
  const had = speaker.speaking || app.active;
  if (app.active) app.callouts?.show();
  if (app.active) {
    const turn=app.active;
    if(!turn.streamDone&&(turn.shown?.trim()||turn.files?.size))rememberTurn('assistant',(turn.shown||'').trim()+'\n\n（已打断，还没完成；以上内容已保留）',{...(turn.usedTools?.length&&{tools:[...new Set(turn.usedTools)]}),...(turn.files?.size&&{files:[...turn.files]})},turn.session);
    app.active.ctrl.abort();
    app.active.bubble?.done('已打断');
    app.active = null;
    app.setTask('idle');
  }
  speaker.cancel();
  return Boolean(had);
}
$('#btn-stop').addEventListener('click', () => interrupt());



function finishTurn() {
  markActivity('');
  if (!app.active) return;
  app.active = null;
  turns++;
  app.dashboard.setTurns(turns);
  app.setTask('done');
  setTimeout(() => { if (!app.active) app.setTask('idle'); }, 3000);
  app.panels.refreshMind();
}

/** 朗读只读正文：代码块（``` 包围的部分，包括还没闭合的）不读。auto 为 false（打字提问）时不念 */
function makeSpeech(auto = true) {
  if (!auto) return { push() {}, flush() {}, resume() {} };
  let chunker = new SentenceChunker({ maxLen:callActive ? 24 : 60 });
  let full = '';
  let fed = 0, speechGeneration = speaker.gen;
  const speechTurn = app.active;
  return {
    resume() { if (speechTurn) speechTurn.muteSpeech = false; full = ''; fed = 0; chunker = new SentenceChunker({maxLen:callActive ? 24 : 60}); speechGeneration = speaker.gen; },
    push(delta) {
      if (speechTurn?.muteSpeech) return;
      full += delta;
      const spoken = full.replace(/```[\s\S]*?```/g, '\n').replace(/```[\s\S]*$/, '');
      if (!speaker.foreground || speechGeneration !== speaker.gen) { chunker = new SentenceChunker({ maxLen:callActive ? 24 : 60 }); speechGeneration = speaker.gen; if (!speaker.foreground) { fed = spoken.length; return; } }
      if (spoken.length > fed) {
        for (const s of chunker.push(spoken.slice(fed))) speaker.speak(s.replace(/[*#`|>]/g, ''));
        fed = spoken.length;
      }
    },
    flush() { if (speechTurn?.muteSpeech || !speaker.foreground || speechGeneration !== speaker.gen) return; for (const s of chunker.flush()) speaker.speak(s.replace(/[*#`|>]/g, '')); }
  };
}

mount(app, createBackground(app));

// ---------------------------------------------------------------- 多会话
/** 把当前会话的消息重新画到对话区 */
let historyViewEnd = null;
function visibleHistory(end = app.history.length) {
  return transcriptWindow(app.history.length, { mobile: MOBILE, safe: document.documentElement.classList.contains('safe-render'), end });
}
function replayTranscript(end = app.history.length) {
  showChatTitle();
  const root = $('#transcript'), range = visibleHistory(end);
  historyViewEnd = range.newer ? range.end : null;
  root.replaceChildren();
  transcript.follow = true;
  document.body.classList.remove('wy-reading-history');
  if (!app.history.length) { app.renderWelcome(); return; }
  transcript.batch(() => {
    if (range.older || range.newer) {
      const nav = Object.assign(document.createElement('nav'), { className: 'wy-history-pages' });
      nav.setAttribute('aria-label', '对话翻页');
      const pageButton = (label, target) => {
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
        button.onclick = () => {
          if (app.active) { toast('当前回复完成后，可以翻看更早的对话'); return; }
          replayTranscript(target);
        };
        nav.append(button);
      };
      if (range.older) pageButton(`查看更早的对话（还有 ${range.older} 条）`, range.start);
      if (range.newer) {
        pageButton('下一页', Math.min(app.history.length, range.end + range.limit));
        pageButton('回到最近对话', app.history.length);
      }
      root.append(nav);
    }
    // 翻看旧消息：很长的回答（除了最后一条）先只显示开头，点“展开全文”再显示，手机上少画很多内容
    const shown = app.history.slice(range.start, range.end);
    const lastAgent = shown.findLastIndex((m) => m.role !== 'user');
    shown.forEach((m, i) => {
      if (m.role === 'user') transcript.add('user', m.content, m.ts, { thumbs: m.thumbs });
      else {
        const b = transcript.add('agent', '', m.ts);
        b.append(m.content);
        for (const f of m.files || []) b.fileLink(f, openInWorkspace);
        b.done(m.tools?.length ? `用了：${m.tools.map(toolLabel).join('、')}` : '', { fold: i !== lastAgent });
      }
    });
  });
}
/** 新对话的开场建议：之前没做完的事 > 上一段对话 */
async function resumeSuggestion() {
  try {
    const [open] = await agentMemory.openItems({ exclude: app.session.id, k: 1 });
    if (open) return { title: `继续：${open.text.slice(0, 18)}`, prompt: `接着之前说的：${open.text}` };
    const [last] = await sessionsApi.recent({ exclude: app.session.id, k: 1 });
    if (last && Date.now() - last.updatedAt < 3 * 86400000) return { title: `接着上次：${last.title.slice(0, 16)}`, prompt: `接着上次「${last.title}」的对话继续` };
  } catch { /* 没有历史 */ }
  return null;
}
async function openingCallouts(hasSkills = true) {
  app.callouts?.set(openingSuggestions({ desktop: Boolean(DESKTOP), hasSkills, resume: await resumeSuggestion() }));
}

async function switchTo(next) {
  // 正在干活：不停下，转到后台接着做（做完记回原来的对话）；只是在朗读就停掉
  if (app.active && !app.active.streamDone) toBackground(app.active); else interrupt();
  if (settings.autoMemory) await app.reflectNow();
  app.session = next;
  app.reflectFrom = app.history.length;
  replayTranscript();
  // 切回一个还在后台干活的对话：把正在写的那条回答接回来
  const bg = [...backgroundTurns].find((t) => t.session.id === app.session.id);
  if (bg) { backgroundTurns.delete(bg); bg.background = false; app.active = bg; app.liveBubble = bg.bubble; transcript.root.append(bg.bubble.el); app.setTask('processing', bg.status || '思考中'); }
  else if (app.server && next.taskId) app.followServerTask(next); // 服务器上这个对话还在干活（比如 App 重新打开）：接上它的进度
  app.dashboard.setTurns(app.history.filter((m) => m.role === 'user').length);
  if (app.history.length) app.callouts?.set(followUpSuggestions({ tools: app.history.at(-1)?.tools ?? [], userText: [...app.history].reverse().find((m) => m.role === 'user')?.content ?? '', desktop: Boolean(DESKTOP) }));
  else openingCallouts();
  sessionsPanel?.refresh();
  app.setTask('idle');
}
function newSession() {
  if (!app.history.length) { $('#prompt').focus(); return; }
  switchTo(sessionsApi.create());
  $('#prompt').focus();
}
addEventListener('jarvis:open-session', (e) => { openSession(e.detail).then(() => app.showPanel('sessions')); });
/** 手机：第一次交任务时问一次能不能发“做完了”的通知（之后不再问） */
let askedNotify = false;
function askNotifyOnce() {
  if (!MOBILE || askedNotify) return;
  askedNotify = true;
  try { if (localStorage.getItem('jarvis.askedNotify')) return; localStorage.setItem('jarvis.askedNotify', '1'); } catch { /* 存不了也只问这一次 */ }
  globalThis.__jarvisBackgroundTask?.askNotify?.().catch(() => {});
}
let opening = 0; // 连点了好几段对话：只认最后点的那段
async function openSession(id) {
  noteAction('切换对话');
  // 点的就是当前对话：服务器模式下从服务器取一次最新进度（另一台设备可能接着聊过）
  if (id === app.session.id) { if (app.server) refreshFromServer(); return; }
  const mine = ++opening;
  // 服务器模式：先用手机 / 电脑上留的副本马上切过去，再从服务器取最新的换上
  const cached = app.server ? sessionsApi.cachedGet(id) : null;
  if (cached) await switchTo(cached);
  else if (app.server) app.setTask('processing', '正在打开对话');
  const s = await sessionsApi.get(id).catch((e) => { if (!cached) toast(`打不开这段对话：${e.message}`); return null; });
  if (mine !== opening) return;
  if (!s) { if (!cached) app.setTask('idle'); return; }
  if (!cached) await switchTo(s);
  else if (app.session.id === id && !app.active && changed(app.session, s)) { app.session = s; app.reflectFrom = app.history.length; replayTranscript(); }
  if (app.server && app.session.id === id && s.taskId && !app.active) app.followServerTask(s); // 另一台设备正在做：接上进度
}
/** 服务器上的这段对话比手上的新吗（另一台设备接着聊过、或者做完了任务） */
const changed = (a, b) => b.messages.length !== a.messages.length || (b.updatedAt ?? 0) > (a.updatedAt ?? 0) || b.messages.at(-1)?.content !== a.messages.at(-1)?.content;
/** 服务器模式：从服务器取当前对话的最新进度，有变化就换上（App 切回前台、点当前对话时） */
let refreshing = false;
async function refreshFromServer() {
  if (!app.server || refreshing || app.active || !app.session?.id) return;
  noteAction('从服务器刷新对话');
  refreshing = true;
  try {
    const id = app.session.id;
    const s = await sessionsApi.get(id).catch(() => null);
    if (!s || app.session.id !== id || app.active) return;
    if (changed(app.session, s)) { app.session = s; app.reflectFrom = app.history.length; replayTranscript(); }
    if (s.taskId) app.followServerTask(s);
    try { drawer?.refresh?.(); } catch { /* 抽屉还没建好 */ }
  } finally { refreshing = false; }
}
// App 从后台切回来 / 电脑窗口重新获得焦点：拉一次最新进度（两台设备轮着用时不会对不上）
let lastPull = 0;
const pullSoon = () => { if (Date.now() - lastPull < 3000) return; lastPull = Date.now(); refreshFromServer(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) pullSoon(); });
addEventListener('focus', pullSoon);

let sessionsPanel = null;

// ---------------------------------------------------------------- 桌面版与 MCP
mount(app, createToolbox(app));
mount(app, createRemoteTask(app));

/** 对话里点生成的文件：切到工作区并打开它 */
/** 导出一段对话：复制全部内容，或存成 Word / Markdown 放进工作区“导出”文件夹（在工作区里能下载、分享） */
async function exportSession(id, kind) {
  const s = id === app.session.id ? app.session : await sessionsApi.get(id).catch(() => null) ?? sessionsApi.cachedGet(id);
  if (!s?.messages?.length) { toast('这段对话还没有内容'); return; }
  const title = s.title || '对话';
  const said = (m) => stripEmotionTags(String(m.content)).replace(/\n*\[已上传到工作区：[^\]]+\]$/, '').trim();
  const when = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '');
  const md = `# ${title}\n\n${s.messages.map((m) => `### ${m.role === 'user' ? '我' : '未央'}${m.ts ? `　${when(m.ts)}` : ''}\n\n${said(m)}`).join('\n\n')}\n`;
  if (kind === 'copy') { toast((await copyText(toPlainText(md))) ? '整段对话已复制' : '复制失败'); return; }
  const name = title.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || '对话';
  try {
    let path;
    if (kind === 'md') path = (await ws.write(`导出/${name}.md`, md)).path;
    else {
      const { generate } = await import('./agent/docs.js');
      const out = await generate('docx', { title, content: md.replace(/^# .*\n/, '') });
      path = (await ws.write(`导出/${name}.${out.ext}`, out.blob)).path;
    }
    app.panels.refreshFiles();
    toast(`已导出到工作区：${path}`);
    openInWorkspace(path);
  } catch (e) { toast(`导出没成功：${e.message}`); }
}
function openInWorkspace(path) {
  app.showPanel('workspace');
  app.panels.openFile(path);
}



/** “/技能名 内容” → 明确要求模型使用该技能（界面上仍显示用户原话） */
async function expandSlash(text) {
  if (!text.startsWith('/')) return text;
  const names = (await skillPacks.enabled().catch(() => [])).map((p) => p.name);
  const m = skillPacks.matchSlash(text, names);
  return m ? `请使用技能「${m.name}」完成：${m.rest || '（用户没有补充内容，先说明这个技能能做什么并询问需要的材料）'}` : text;
}

// —— 干活时插话、切换对话后台继续
const backgroundTurns = new Set();
/** 干活时又发来一句：问进度直接答；说停就停；其他的交给正在干的未央（下一步开始前看到），不打断 */
async function interject(text, { thumbs = [] } = {}) {
  const turn = app.active;
  transcript.add('user', text, Date.now(), { thumbs });
  const reply = (words) => { const b = transcript.add('agent', words); b.done(); };
  if (STOP_ASK.test(text)) { interrupt(); reply('好的，已经停下。上面是停下前做到的地方，要接着做跟我说一声。'); return; }
  if (STATUS_ASK.test(text)) { reply(`${turnStatus(turn, now())}。做完会直接给你结果；想停的话点右下角的方块，或者说“停”。`); return; }
  rememberTurn('user', text, thumbs.length ? { thumbs } : {}, turn.session);
  if (!turn.remote) {
    turn.inbox.push(text);
    if (MOBILE) { turn.checkpoint=checkpointEvent(turn.checkpoint,{type:'user_note',text}); savePending(storage,turn.session.id,{checkpoint:turn.checkpoint}); }
  } else if (!turn.remoteId) {
    turn.inbox.push(text); reply('收到补充，连接到原任务后会送达。'); return;
  } else {
    try { await app.server.appendTaskNote(turn.remoteId,text); }
    catch(e) { if (!prompt.value.trim()) { prompt.value=text; autosize(); } reply('补充没有送达，已放回输入框。原任务不会重复执行；服务器较旧时请先更新服务器。'); return; }
  }
  reply(`收到，做完手上这一步就看这句话（${turnStatus(turn, now())}）。`);
}
/** 切到别的对话：正在干的任务转到后台接着做 */
function toBackground(turn) {
  turn.background = true;
  backgroundTurns.add(turn);
  app.active = null;
  speaker.cancel();
  app.setTask('idle');
  toast('刚才的任务在后台接着做，做完会提醒你');
}
/** 后台任务做完（或出错）：记回原来的对话，提醒用户 */
function finishBackground(turn, { text = '', error = '', shown = '', usedTools = [], files = new Set() }) {
  backgroundTurns.delete(turn);
  const extra = { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(files.size && { files: [...files].slice(-12) }) };
  const title = turn.session.title || '另一个对话';
  if (error) {
    if (shown.trim() || usedTools.length) rememberTurn('assistant', `${shown.trim()}\n\n${interruptionMark(error)}`, extra, turn.session);
    toast(`「${title}」里的任务没做完：${error.slice(0, 40)}`);
  } else {
    rememberTurn('assistant', text || '（完成）', extra, turn.session);
    toast(`「${title}」里的任务做完了，切回去就能看到`);
  }
  turn.bubble.done();
  sessionsPanel?.refresh();
}

async function send(text, { echo = true, byVoice = false } = {}) {
  noteAction(byVoice ? '语音提问' : '发消息');
  askNotifyOnce();
  text = String(text || '').trim();
  if (!text && !attachments.length) return;
  if (!attachments.length && companion?.perform(text)) return;
  if (!text && attachments.some((a) => a.image)) text = '请看看这张图片。';
  // 正在干活时又发了一句：不打断，问进度就直接答，别的话交给正在干的未央；说“停”才停
  if (echo && app.active && !app.active.streamDone) {
    const extra = attachments.splice(0); renderAttachments();
    if (app.server && extra.length) {
      try { for (const f of extra) await app.server.upload(f.path, await ws.readBlob(f.path)); }
      catch (e) { attachments.unshift(...extra); renderAttachments(); if (!prompt.value.trim()) { prompt.value=text; autosize(); } toast(`附件未送达，已保留：${e.message}`); return; }
      if (!app.active || app.active.streamDone) { attachments.unshift(...extra); renderAttachments(); return send(text,{echo,byVoice}); }
    }
    const content = extra.length ? text + '\n\n[已上传到工作区：' + extra.map(f=>f.path).join('、') + ']' : text;
    return interject(content, { thumbs:extra.filter(f=>f.image).map(f=>({src:f.image.thumb,path:f.path})) });
  }
  if (app.active) { app.active.ctrl.abort(); app.active = null; }
  speaker.cancel();
  speaker.unlock(); // 发送多由点击 / 回车触发：顺便启动音频上下文，云端语音才能播放

  // 持续聊天也保持有界；先重画已完成的历史，再追加本轮，避免重复消息。
  if (MOBILE && (historyViewEnd !== null || $('#transcript').querySelectorAll('.msg').length >= visibleHistory().limit)) replayTranscript();
  const files = attachments.splice(0);
  renderAttachments();
  const userText = files.length ? `${text}\n\n[已上传到工作区：${files.map((f) => f.path).join('、')}]` : text;
  const imgs = files.filter((f) => f.image).map((f) => f.image);
  const thumbs = files.filter(f => f.image).map(f => ({ src:f.image.thumb, path:f.path }));
  if (echo) transcript.add('user', userText, Date.now(), { thumbs }); // echo=false：这句话之前已经显示并记下了
  app.director.onUserText(text);
  app.hud.newTurn();
  app.hud.think(`◂ 收到：${text.slice(0, 30)}`);
  // 之前发过的图片（最近两条带图的消息）继续带给模型：追问“第二张图里……”时模型还看得到
  // 只在这句话提到图片时才带（不然后面每句闲聊都会被当成看图任务、多花流量）
  const refersToImage = !imgs.length && /图|截图|照片|相片|图片|表格|这张|那张|第.张|上面|刚才发的|picture|image|screenshot/i.test(text);
  // 长对话：已压缩进摘要的消息不再原样发送，其余（至少最近 20 条）原样发送，见 compress.js
  const recent = compress.unsummarized(app.history, app.session.summary);
  const withImages = new Set(refersToImage ? recent.filter((m) => m.role === 'user' && recentImages.has(m.ts)).slice(-2).map((m) => m.ts) : []);
  const llmHistory = recent.map(({ role, content, ts }) => ({ role, content, ...(withImages.has(ts) && { images: recentImages.get(ts) }) }));
  if (echo) rememberTurn('user', userText, thumbs.length ? { thumbs } : {});
  if (imgs.length) {
    recentImages.set(app.history.at(-1).ts, imgs.map(({ mime, data }) => ({ mime, data })));
    while (recentImages.size > 2) recentImages.delete(recentImages.keys().next().value);
  }

  if (app.machine.task !== 'listening') app.machine.beginUserTurn();
  const ctrl = new AbortController();
  const bubble = transcript.add('agent');
  app.liveBubble = bubble;
  bubble.el.classList.add('streaming');
  // 这一轮属于哪个会话：切到别的对话后在后台接着做，结果、文件都记回这个会话
  const turn = { ctrl, streamDone: false, bubble, session: app.session, files: new Set(), inbox: [], t0: now(), steps: 0, status: '', background: false };
  app.active = turn;
  app.setTask('processing', '思考中');
  // 手机：记下正在做的任务（App 被划掉时，下次打开接着做）
  const doneSteps = [];
  turn.checkpoint={text:userText,notes:[],inFlight:[],steps:[],files:[],status:'running'};
  if (MOBILE && !app.server) savePending(storage,app.session.id,{turnId:turn.t0,text:userText,title:app.session.title||'',ts:Date.now(),steps:[],files:[],checkpoint:turn.checkpoint});

  // 模型分工：按这句话的类型换模型；日常对话让推理模型少想一点（首字更快）
  const computerKind = DESKTOP ? computerTaskKind(text,{history: app.history}) : null;
  const task = computerKind === 'gui' ? 'vision' : shouldTeam(text, settings.teamMode === 'auto' && !app.helperLlm() ? 'off' : settings.teamMode) ? 'reason' : classifyTask(text, { images: imgs.length + withImages.size });
  const route = routeFor(app.llmConfig, task);
  const remotePC=Boolean(app.server&&computerKind);
  const local=createAdapter(route.cfg,{gateway: app.gateway});
  const model=remotePC?'服务器模型':local.model;
  let usedModel=model;
  const adapter=remotePC?createPCModelAdapter(app.server,{task,onModel:m=>{usedModel=m;}}):local.adapter;
  const problem=remotePC?null:local.problem;
  if (COMPACT && isAuto(app.llmConfig) && model && !app.server) $('#model-chip-text').textContent = `自动 · ${model}`;
  // 日常闲聊少想一点（首字更快）；要查证、分析、算结果的不省
  const effort = effortFor(task, text, app.llmConfig);
  if (route.routed&&!remotePC) app.hud.think(`◇ 模型分工：${TASKS[task].name} → ${route.model}`);
  // 服务器模式下电脑版：要动这台电脑的事（桌面、文件夹、打开软件……）留在本机做，其余交给服务器
  const here = Boolean(app.server && DESKTOP && computerKind);
  turn.remote=Boolean(app.server&&!here);
  if (here) app.hud.think('◇ 服务器模型推理，电脑工具在本机执行');
  if (problem && (!app.server || here)) { // 服务器模式：用服务器上的模型设置
    bubble.append(problem);
    bubble.done();
    app.callouts?.set(followUpSuggestions({ error: true, userText: text }));
    app.active = null;
    app.setTask('error', '需要配置模型');
    app.showPanel('models');
    return;
  }

  // 备用模型：当前模型出错（重试后还不行）时自动换着用
  const fallbacks = remotePC ? [] : fallbackRoutes(app.llmConfig, { provider: route.cfg.provider, model }).map((f) => ({ ...createAdapter(f.cfg, { gateway: app.gateway }), label: f.model })).filter((f) => !f.problem && f.adapter && f.model);

  // 语音对话中、或者是说话提问的：念回答；打字提问只显示（设置里打开“打字提问也朗读”除外）
  const spoken = callActive || byVoice || settings.readTyped;
  const speech = makeSpeech(spoken);
  const cards = new Map();
  let firstToken = 0;
  let outMarked = false; // 崩溃记录：这一段在输出文字
  let textChunks = 0; // 回答分几次收到：1 次说明是整段一次性到的（中转站或网络没有边生成边给）
  let serverCard = null;
  const t0 = now();
  const usedTools = [];
  turn.usedTools=usedTools;
  const madeFiles = turn.files;
  let shown = ''; // 这一轮已经显示出来的回答（中断时保留，点“继续”接着写）
  let ctxMs = null;
  app.callouts?.retract();
  // 内置演示模式下“自动”不触发（规则拆步效果有限），只认明确的“/团队 …”或“总是”
  const team = !app.server && !computerKind && shouldTeam(text, settings.teamMode === 'auto' && !app.helperLlm() ? 'off' : settings.teamMode);
  let teamCard = null;
  const releaseTask = taskKeeper.begin();
  try {
    // 服务器模式：服务器做，进度事件和本机一样显示（runRemote 的用法和 runAgent 一样）
    const serverRun = async (o) => {
      for (const f of files) await app.server.upload(f.path, await ws.readBlob(f.path)); // 发来的附件先传到服务器的工作区
      return runRemote(app.server, { sessionId: o.sessionId, userText: o.userText, images: o.images, voice: o.voice, emit: o.emit, signal: o.signal, onFile: (p) => app.pullServerFile(p, turn), onStarted:async remoteTask=>{
        turn.remoteId=remoteTask.id;
        for(const note of turn.inbox.splice(0)) {
          try { await app.server.appendTaskNote(remoteTask.id,note); }
          catch(e) { prompt.value += (prompt.value.trim()?'\n':'')+note; autosize(); toast('补充未送达原任务，已保留在输入框，请更新服务器或重新发送'); }
        }
      } });
    };
    const result = await (app.server && !here ? serverRun : team ? runTeam : runAgent)({
      llm: team ? app.helperLlm('reason') : undefined,
      pickModel: team ? app.modelForRole : undefined,
      effort,
      adapter, model, history: llmHistory, userText: team ? userText : await expandSlash(userText), signal: ctrl.signal, computerTask: computerKind,
      sessionId: app.session.id,
      summary: app.session.summary ?? null,
      requirements: collectRequirements(app.history, app.session.requirements),
      requirementText: userText, // 保留斜杠命令展开前的原话，避免当成缺失历史重复注入
      fallbacks,
      inbox: team ? null : turn.inbox,
      checkpoint: MOBILE&&!turn.remote ? async event=>{
        turn.checkpoint=checkpointEvent(turn.checkpoint,event);
        savePending(storage,turn.session.id,{checkpoint:turn.checkpoint,ts:Date.now(),files:[...turn.files]});
      }:null,
      // 语音对话：让模型用口语短答；“你好 / 谢谢”这类寒暄不带工具，回得快
      voice: callActive || byVoice,
      light: !files.length && isSmallTalk(text),
      maxSteps: DESKTOP ? 40 : 28, // 用鼠标键盘操作电脑、逐项联网核实时步数多
      images: imgs.map(({ mime, data }) => ({ mime, data })),
      tools: app.server && !here ? [] : await app.buildTools({ turn }),
      approve: async (req) => {
        if (preApproved(req, { sessionKeys: app.sessionApprovals })) return true; // 危险命令每次都问
        // 看屏幕后主窗口已隐藏，确认卡必须先恢复可见；保持紧急停止热键有效。
        if(app.controlActive&&DESKTOP)await DESKTOP.invoke('controlPause');
        if(ctrl.signal.aborted)return false;
        app.setTask('processing', '等待你确认');
        let cancel;
        const aborted = new Promise((r) => {cancel=()=>r('deny');ctrl.signal.addEventListener('abort',cancel,{once:true});});
        try { const v=await Promise.race([bubble.confirm(req), aborted]);
          if (v === 'session' && req.key) app.sessionApprovals.add(req.key);
          return v !== 'deny';
        } finally {ctrl.signal.removeEventListener('abort',cancel);}
      },
      emit: (e) => {
        if (e.type === 'tool_start' && e.name !== 'update_plan') { turn.steps++; turn.status = toolLabel(e.name); }
        else if (e.type === 'tool_progress') turn.status = e.text;
        else if (e.type === 'text') turn.status = '写回答';
        if (turn.background) {
          // 切到别的对话了：只把内容记在这一轮的气泡里（切回来时接上），不朗读、不改界面状态
          if (e.type === 'text') { bubble.append(e.delta); shown += e.delta; turn.shown=shown; }
          else if (e.type === 'tool_start' && e.name !== 'update_plan') { cards.set(e.id, bubble.toolCard(e.name, e.args)); usedTools.push(e.name); }
          else if (e.type === 'tool_progress') cards.get(e.id)?.progress(e.text);
          else if (e.type === 'tool_end') cards.get(e.id)?.done(e.ok, e.output, e.ms);
          else if (e.type === 'plan') bubble.plan?.(e.steps);
          return;
        }
        if (app.active !== turn) return;
        if (e.type === 'text') {
          if(callActive&&callTiming?.recognizedAt&&!callTiming.firstTextAt)callTiming.firstTextAt=now();
          if (!firstToken) { firstToken = now(); app.hud.think('生成回答'); }
          if (!outMarked) { outMarked = true; markActivity(`正在输出回答${shown.length ? `（已 ${shown.length} 字）` : ''}`); }
          if (serverCard) { serverCard.done(true, '由模型服务端完成', Math.round(now() - serverCard.t0)); serverCard = null; }
          bubble.append(e.delta);
          shown += e.delta;
          textChunks++;
          app.machine.feedResponseText(e.delta);
          speech.push(e.delta);
        } else if (e.type === 'interjection_accepted') {
          speech.resume();
          bubble.status?.('已收到补充，正在调整…');
          if (callActive) callStatus('已收到，正在按补充要求处理…');
        } else if (e.type === 'fallback') {
          usedModel = e.to;
          const note = `${e.from} 出错（${e.reason}），已换成 ${e.to} 接着做`;
          app.hud.think(`⇄ ${note}`, 'sub');
          toast(note);
          app.setTask('processing', `已换成 ${e.to}`.slice(0, 30));
        } else if (e.type === 'retry') {
          const note = e.resume ? `网络中断，第 ${e.attempt} 次重连，接着刚才的地方写` : `连接出错，第 ${e.attempt} 次自动重试`;
          app.hud.think(`↻ ${note}`, 'sub');
          app.setTask('processing', note.slice(0, 30));
        } else if (e.type === 'emotion') { app.machine.setStreamHint(e.value); app.director.onEmotion(e.value); bubble.mood?.(e.value); }
        else if (e.type === 'state' && e.value !== 'done') app.setTask(e.value, e.value === 'listening' ? '生成回答' : '');
        else if (e.type === 'plan') bubble.plan?.(e.steps); // 任务清单：卡片里实时打勾
        else if ((e.type === 'tool_start' || e.type === 'tool_end') && e.name === 'update_plan') { /* 更新清单本身不单独占一张工具卡片 */ }
        else if (e.type === 'tool_start') {
          app.director.onToolStart(e.name);
          app.hud.toolStart(e.id, toolLabel(e.name));
          app.hud.think(`▸ ${toolLabel(e.name)}  ${summarizeArgs(e.name, e.args)}`);
          cards.set(e.id, bubble.toolCard(e.name, e.args));
          usedTools.push(e.name);
          bubble.status?.(`正在${toolLabel(e.name)}…`);
          app.setTask('processing', toolLabel(e.name));
          markActivity(`${toolLabel(e.name)} ${summarizeArgs(e.name, e.args)}`.slice(0, 80));
          outMarked = false;
        } else if (e.type === 'tool_progress') {
          cards.get(e.id)?.progress(e.text);
          app.hud.think(`  ${e.text}`, 'sub');
          app.setTask('processing', e.text.slice(0, 30));
        } else if (e.type === 'tool_end') {
          cards.get(e.id)?.done(e.ok, e.output, e.ms);
          app.hud.toolEnd(e.id, e.ok);
          if (MOBILE&&!turn.remote) { if(e.ok) doneSteps.push(toolLabel(e.name)); savePending(storage, turn.session.id, { ts: Date.now(), steps: doneSteps, files: [...turn.files] }); }
          if (!e.ok) app.hud.think(`✕ ${toolLabel(e.name)} 失败`, 'bad');
          if (/remember|forget|save_skill/.test(e.name)) app.panels.refreshMind();
        } else if (e.type === 'server_tool') {
          serverCard = Object.assign(bubble.toolCard('web_search', { query: `${searchBrand(model)}自带联网搜索` }), { t0: now() });
        } else if (e.type === 'sources') bubble.sources(e.items);
        else if (e.type === 'timing') ctxMs = e.contextMs;
        else if (e.type === 'team_plan') { app.hud.think(`团队分工 · ${e.steps.map((x) => x.roleName).join(' → ')}`); teamCard = bubble.teamCard(e.steps); app.setTask('processing', `团队分工 · ${e.steps.length} 步`); }
        else if (e.type === 'team_step') {
          teamCard?.step(e.index, e.status, e.note);
          if (e.status === 'running' || e.status === 'redo') app.setTask('processing', `第 ${e.index + 1} 步${e.status === 'redo' ? ' · 返工' : ''}`);
        } else if (e.type === 'team_review') { teamCard?.review(e); app.setTask('processing', e.pass ? '审核通过，汇总中' : '审核发现问题'); }
      }
    });
    if (turn.background) { finishBackground(turn, { text: result.text, shown, usedTools, files: madeFiles }); return; }
    if (app.active !== turn) return;
    speech.flush();
    const total = now() - t0;
    const modelTag = app.server && !here ? '服务器 · ' : here ? `本机工具 · ${usedModel} · ` : providerById(app.llmConfig.provider)?.kind === 'mock' ? '' : usedModel !== model ? `${usedModel}（${model} 出错后换用） · ` : `${model}${route.routed ? `（${TASKS[task].name}）` : ''} · `;
    bubble.done(`${modelTag}${team ? `团队 ${result.steps} 步 · ` : ''}${ctxMs !== null && ctxMs >= 300 ? `准备 ${(ctxMs / 1000).toFixed(1)}s · ` : ''}${firstToken ? `首字 ${((firstToken - t0) / 1000).toFixed(1)}s · ` : ''}耗时 ${(total / 1000).toFixed(1)}s${result.toolCalls ? ` · 工具 ${result.toolCalls} 次` : ''}${MOBILE && textChunks ? ` · 分 ${textChunks} 次收到${globalThis.__jarvisNetVia?.(app.llmConfig.baseURLs?.[app.llmConfig.provider] || '') === 'native' ? '（原生网络）' : ''}` : ''}`, {
      onFeedback: async (kind, comment) => {
        if (kind === 'up') await agentMemory.noteTask(`获得好评：${text.slice(0, 30)}`);
        else {
          await agentMemory.addLesson(`关于「${text.slice(0, 40)}」的回答，用户不满意：${comment || '未说明原因，下次先确认需求再回答'}`, text);
          toast('已记下这条教训，之后遇到类似问题会注意');
        }
        app.panels.refreshMind();
      }
    });
    app.dashboard.setLatency(firstToken ? firstToken - t0 : null, total);
    app.hud.think(`✓ 完成 · ${(total / 1000).toFixed(1)}s${result.toolCalls ? ` · ${result.toolCalls} 个工具` : ''}`, 'ok');
    $('#hud-latency').textContent = firstToken ? `${Math.round(firstToken - t0)} ms` : '—';
    if (result.text) wp({ say: result.text.replace(/```[\s\S]*?```/g, '').replace(/[#*>`|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 4000) });
    rememberTurn('assistant', result.text || '（完成）', { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(madeFiles.size && { files: [...madeFiles].slice(-12) }) }, turn.session);
    // 做完时人不在（App 在后台 / 窗口没在看）：发通知，点开就能看结果
    if (document.hidden) app.notify('未央做完了', `${(turn.session.title || text).slice(0, 30)}：${stripEmotionTags(result.text || '').replace(/\s+/g, ' ').slice(0, 120)}`);
    // 在本机做的这一轮也记回服务器上的这段对话（手机上能看到）
    if (here) app.server.appendSession(turn.session.id, turn.session.messages.slice(-2).map(({ role, content, ts, tools }) => ({ role, content, ts, ...(tools && { tools }) }))).catch((e) => toast(`这一轮没能记到服务器上：${e.message}`));
    $('#mode-pill').classList.remove('offline');
    turn.streamDone = true;
    app.callouts?.set(followUpSuggestions({ tools: usedTools, userText: text, desktop: Boolean(DESKTOP) }));
    app.scheduleReflect();
    app.compressHistory();
    if (!speaker.speaking) finishTurn();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (turn.background) { finishBackground(turn, { error: app.friendlyError(String(err.message || err)), shown, usedTools, files: madeFiles }); return; }
    if (app.active !== turn) return;
    const msg = app.friendlyError(String(err.message || err));
    const cors = !MOBILE && /Failed to fetch|NetworkError|Load failed|CORS/i.test(msg);
    bubble.append(`\n（出错了：${msg}${cors ? '。多半是该服务商不允许网页直接调用：双击 jarvis 文件夹里的 启动.bat（或 start.sh）并保持窗口开着，本页面会自动连上本机网关，然后重试即可' : ''}）`);
    if (cors && !app.gateway) app.detectGateway();
    bubble.done();
    bubble.activity('error');
    $('#mode-pill').classList.add('offline');
    app.active = null;
    app.setTask('error', '请求失败');
    app.hud.think(`✕ ${msg.slice(0, 40)}`, 'bad');
    // 已经写了一部分或做了几步：记进对话，点“继续”从断开的地方接着做，而不是从头再来
    const resumable = Boolean(shown.trim() || usedTools.length);
    if (resumable) rememberTurn('assistant', `${shown.trim()}\n\n${interruptionMark(err)}`, { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(madeFiles.size && { files: [...madeFiles].slice(-12) }) }, turn.session);
    app.callouts?.set(followUpSuggestions({ error: true, resumable, userText: text, desktop: Boolean(DESKTOP) }));
  } finally {
    if (MOBILE) clearPending(storage, turn.session.id, turn.t0);
    await persistSession(turn.session);
    releaseTask();
    app.endControl();
    // 回答写完的一瞬间又收到的话（没来得及交给模型）：接着当一句新话处理
    const left = turn.inbox.splice(0);
    if(left.length&&turn.remote){prompt.value+=(prompt.value.trim()?'\n':'')+left.join('\n');autosize();toast('未送达的补充已放回输入框，没有另开任务');}
    else if (left.length && !ctrl.signal.aborted && !turn.background && app.session === turn.session) setTimeout(() => send(left.join('\n'), { echo: false }), 0);
  }
}


// —— 输入框：Enter 发送，Shift+Enter 换行；随内容自动增高
const prompt = $('#prompt');
function autosize() { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`; composer?.refresh(); }
$('#inputbar').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = prompt.value;
  prompt.value = '';
  autosize();
  send(v);
});
// 手机（触屏）键盘没有 Shift：回车就是换行，点发送按钮才发送；电脑上回车发送、Shift+回车换行
const enterSends = () => !MOBILE && !globalThis.matchMedia?.('(pointer: coarse)').matches;
prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && enterSends()) {
    e.preventDefault();
    $('#inputbar').requestSubmit();
  }
});
prompt.addEventListener('input', (e) => {
  autosize();
  if (e.target.value && speaker.speaking) speaker.cancel(); // 开始打字即打断朗读
  if (e.target.value && !app.active && app.machine.task !== 'listening') app.machine.beginUserTurn();
});

// —— 常用指令：把开头写好放进输入框，接着补充再发
initQuickPrompts({
  button: $('#btn-quick'),
  onPick: (text) => {
    prompt.value = prompt.value.trim() ? `${text}${prompt.value}` : text;
    autosize();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  }
});

// —— 附件：上传 / 拖入的文件放进工作区“上传/”目录，并附在下一条消息里
async function addFiles(list) {
  for (const f of list) {
    try {
      const r = await ws.write(`上传/${f.name}`, f);
      // 图片同时作为“看图”输入发给模型
      const image = isImageName(f.name) ? await prepareImage(f).catch(() => null) : null;
      attachments.push({ path: r.path, image });
      app.panels.markFresh(r.path);
    } catch (e) { toast(`${f.name}：${e.message}`); }
  }
  renderAttachments();
  app.panels.refreshFiles();
  prompt.focus();
}
function renderAttachments() {
  queueMicrotask(() => composer?.refresh());
  const box = $('#attach-list');
  box.hidden = !attachments.length;
  box.replaceChildren(...attachments.map((a, i) => {
    const x = Object.assign(document.createElement('button'), { type: 'button', textContent: '✕', title: '移除' });
    x.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
    const s = document.createElement('span');
    if (a.image) {
      s.className = 'has-thumb';
      s.append(imageButton(a.image.thumb, () => previewWorkspaceImage(a.path,a.image.thumb).catch(e => toast(e.message))));
    }
    const label = Object.assign(document.createElement('span'), { className:'attach-name', textContent:a.image ? '图片 · 已上传工作区' : a.path.split('/').pop(), title:a.path });
    s.append(label, x);
    return s;
  }));
}
// ＋菜单统一处理文件入口；原相机、文件上传处理器保留。
initCamera({ button: $('#btn-camera'), input: $('#camera-input'), native: MOBILE || /Android|iPhone|iPad/i.test(navigator.userAgent), onFiles: addFiles, onError: e => toast(e.message) });
addEventListener('jarvis:open-upload', e => { app.showPanel('workspace'); if (e.detail?.path) app.panels.openFile(e.detail.path); });
// 粘贴截图 / 图片
$('#prompt').addEventListener('paste', (e) => {
  const imgs = [...(e.clipboardData?.items ?? [])].filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
  if (!imgs.length) return;
  e.preventDefault();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  addFiles(imgs.map((f, i) => new File([f], `粘贴-${stamp}${i ? `-${i}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
});
$('#file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#drop-overlay').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});

// ---------------------------------------------------------------- 语音
// 唤醒词：未唤醒时只听不动——不打断正在进行的回答，不显示识别中的文字
const wake = new WakeWindow();
const asleep = () => settings.wakeWord && !wake.awake;
const DISMISS = /^(退下|没事了|休息吧|再见|就这样)[。.！!]*$/;
// 窄屏用短提示语，避免输入框被撑成好几行
const narrowPrompt = matchMedia('(max-width: 860px)');
const setPlaceholder = () => { $('#prompt').placeholder = narrowPrompt.matches ? '交给我一个任务……' : '交给我一个任务：写代码、做 PPT、分析文件、查资料……（Enter 发送，Shift+Enter 换行）'; };
narrowPrompt.addEventListener?.('change', setPlaceholder);
setPlaceholder();
setInterval(() => document.body.classList.toggle('awake', settings.wakeWord && wake.awake), 250);
function onWake() {
  wake.wake();
  const ctx = speaker.unlock();
  if (ctx?.state === 'running') playCue(ctx, 'start', 0.08);
  app.machine.beginUserTurn();
}

// 语音识别：网页版优先用浏览器自带识别；桌面版（Electron 没有浏览器识别）或用户指定时走云端转写
const browserSR = speechRecognitionSupported && !window.jarvisDesktop && !MOBILE; // 桌面版、手机 App 里的浏览器识别都用不了
const callStatus = text => { $('#voice-call-status').textContent = text; };
const sttEngine = () => resolveStt(app.llmConfig, { gateway: app.gateway, browserSupported: browserSR });
function recordedVoice() {
  return new RecordedVoice({ getTranscriber: () => { const id = sttEngine(); return id === 'none' || id === 'browser' ? null : (wav, signal) => transcribe(id,app.llmConfig,wav,{gateway: app.gateway,signal}); }, ...voiceHandlers });
}
const voiceHandlers = {
  onStatus: phase => { if(callActive&&phase==='speech')callTiming={};if(callActive&&phase==='processing'){callTiming??={};callTiming.stoppedAt=now();} recordVoiceEvent('识别阶段',phase); if (callActive) callStatus({ ready:'麦克风已开启，请说话', speech:'正在听你说话…', processing:'正在识别这句话…', popup:'尝试手机系统的语音窗口…' }[phase] || phase); },
  onUnavailable: async message => {
    recordVoiceEvent('系统识别不可用',message);
    if (!MOBILE || !callActive || callCloudFallback || /权限|permission/i.test(message) || sttEngine() === 'none') return;
    const gen = callGeneration; voiceSwitching = true; callCloudFallback = true;
    try {
      voice.disable(); await globalThis.__jarvisSpeech?.stop();
      if (!callActive || gen !== callGeneration) return;
      voice = recordedVoice(); callStatus('系统识别暂不可用，正在启用服务商转写…');
      await voice.enable({ silenceMs:SILENCE_BY_SENSITIVITY[settings.vadSensitivity] });
      if (gen !== callGeneration) voice.disable();
    } catch (e) { toast(`语音转写无法启动：${e.message}`); if (gen === callGeneration) await setVoiceCall(false); }
    finally { voiceSwitching = false; }
  },
  onConfirm: () => {
    if (callActive) callStatus('正在听你说话…');
    if (asleep()) return;
    app.live.voiceListening = true;
    if (!app.active) app.director.setState('voice');
    // 开口只打断朗读，不取消正在执行的任务；最终文字走同一套补充要求逻辑。
    if (app.active) app.active.muteSpeech = true;
    speaker.cancel();
    app.machine.beginUserTurn();
    app.dashboard.setTask('listening', '正在听');
    $('#vad-meter').classList.add('on');
  },
  onCancel: () => endListening(),
  onInterim: (t) => { if (!asleep() || matchWake(t).woke) transcript.interim(t); },
  onFinal: (t) => {
    if (dictating) {
      const text = String(t || '').trim();
      stopDictation();
      if (text) { prompt.value += (prompt.value.trim() ? ' ' : '') + text; autosize(); prompt.dispatchEvent(new Event('input',{bubbles:true})); prompt.focus(); }
      return;
    }
    if (callActive) {callTiming??={};callTiming.recognizedAt=now();callStatus('未央正在思考…');}
    endListening();
    transcript.clearInterim();
    if (!settings.wakeWord) return send(t, { byVoice: true });
    const m = matchWake(t);
    if (!wake.awake && !m.woke) return; // 没叫名字：忽略
    const cmd = m.woke ? m.rest : t;
    if (DISMISS.test(cmd)) {
      wake.sleep();
      speaker.speak('好的，有需要再叫我。');
      return;
    }
    onWake();
    if (!cmd) {
      if (app.active) { app.active.ctrl.abort(); app.active = null; }
      speaker.cancel();
      speaker.speak('我在。');
      app.setTask('listening', '已唤醒');
      return;
    }
    send(cmd, { byVoice: true });
  },
  onEnergy: (e) => {
    app.live.voiceEnergy = e;
    $('#inputbar').style.setProperty('--e', e.toFixed(2));
  },
  onMode: (m) => {
    if (m === 'off' && callActive && !callStarting && !voiceSwitching) queueMicrotask(() => { if (!voiceSwitching && callActive) setVoiceCall(false); });
    if (callActive) callStatus(m === 'off' ? '语音已停止' : m === 'loading' ? '正在准备语音…' : m === 'ptt' ? '按住麦克风说话，松开后回复' : '直接说话，未央在听');
    $('#voice-status').textContent = {
      off: '',
      loading: sttEngine() === 'qwen-realtime' ? '正在连接百炼实时识别…' : '正在加载本地语音活动检测模型…',
      vad: '已开启：直接说话即可，停顿后自动提交。',
      ptt: '语音活动检测不可用，已降级为“按下说话”：按住麦克风说话，松开提交。'
    }[m];
    $('#btn-mic').setAttribute('aria-pressed', String(m !== 'off'));
    body.classList.toggle('voice-on', m !== 'off');
    body.classList.toggle('voice-ptt', m === 'ptt');
    $('#btn-mic').title = dictating ? '停止语音转文字' : '语音转文字';
    $('#btn-mic').setAttribute('aria-label', dictating ? '停止语音转文字' : '语音转文字');
  },
  onError: (code) => {
    if (dictating) stopDictation();
    recordVoiceEvent('识别错误',code);
    if (callActive) callStatus(String(code));
    toast(code === 'not-allowed' ? '麦克风权限被拒绝' : /^语音识别/.test(code) ? code : `语音识别出错：${code}`);
  }
};
let voice = new (MOBILE ? RecordedVoice : VoiceInput)({
  allowBrowserSR: browserSR,
  getTranscriber: () => {
    const id = sttEngine();
    return id === 'browser' || id === 'none' ? null : (wav, signal) => transcribe(id, app.llmConfig, wav, { gateway: app.gateway, signal });
  },
  ...voiceHandlers
});
// 安卓 App：有系统语音识别就用它（免费、不用密钥、自己判断说完）；没有再走云端转写
const nativeVoiceReady = MOBILE && globalThis.__jarvisSpeech
  ? NativeVoice.available(globalThis.__jarvisSpeech).then((ok) => {
    globalThis.__jarvisNativeSpeechAvailable = ok; recordVoiceEvent('系统服务检测',String(ok));
    if (ok) voice = new NativeVoice({ plugin: globalThis.__jarvisSpeech, ...voiceHandlers });
    return ok;
  })
  : Promise.resolve(false);

function endListening() {
  transcript.clearInterim();
  if (!app.live.voiceListening) return;
  app.live.voiceListening = false;
  if (!app.active) app.director.setState('idle');
  app.live.voiceEnergy = 0;
  transcript.clearInterim();
  $('#vad-meter').classList.remove('on');
  // 识别被取消且没有发出请求：回到空闲；保持情绪不变以外的状态（no-speech 不触发警觉）
  if (!app.active && app.machine.task === 'listening') app.setTask('idle');
}

async function setDirectVoice(on) {
  const nativeAvailable = await nativeVoiceReady; // 手机上先确定用不用系统识别
  if (on && sttEngine() === 'qwen-realtime') {
    if (!(voice instanceof QwenVoice)) { voice.disable(); voice = new QwenVoice({ getConfig:()=>app.llmConfig, getGateway:()=>app.gateway, allowBargeIn:()=>callActive, ...voiceHandlers }); }
  } else if (on && voice instanceof QwenVoice) {
    voice.disable();
    voice = new (MOBILE ? RecordedVoice : VoiceInput)({ allowBrowserSR:browserSR, getTranscriber:()=>{const id=sttEngine();return id==='none'||id==='browser'?null:(wav,signal)=>transcribe(id,app.llmConfig,wav,{gateway: app.gateway,signal});}, ...voiceHandlers });
  }
  if (MOBILE && on) {
    const useNative = nativeAvailable && (app.llmConfig.stt?.engine || 'auto') === 'auto';
    if (useNative && !(voice instanceof NativeVoice)) { voice.disable(); voice = new NativeVoice({ plugin: globalThis.__jarvisSpeech, ...voiceHandlers }); }
    if (!useNative && voice instanceof NativeVoice) {
      voice.disable();
      voice = new RecordedVoice({ getTranscriber: () => { const id = sttEngine(); return id === 'none' || id === 'browser' ? null : (wav, signal) => transcribe(id, app.llmConfig, wav, { gateway: app.gateway, signal }); }, ...voiceHandlers });
    }
  }
  setSetting('directVoice', on);
  $('#set-voice').checked = on;
  if (on) {
    try {
      await voice.enable({ silenceMs: SILENCE_BY_SENSITIVITY[settings.vadSensitivity] });
    } catch (err) {
      recordVoiceEvent('启动失败',err.message); toast(err.message);
      if (/云端语音识别/.test(err.message)) app.showPanel('models');
      setSetting('directVoice', false);
      $('#set-voice').checked = false;
      return false;
    }
  } else {
    voice.disable();
    endListening();
  }
  return true;
}

/** 语音通话临时开启朗读并关闭唤醒词，结束后恢复原来的偏好。 */
async function setVoiceCall(on) {
  noteAction(on ? '开始语音对话' : '结束语音对话');
  if (on && (callStarting || callActive)) return;
  if (on && dictating) await stopDictation();
  const gen = ++callGeneration;
  if (!on) {
    callActive = false;
    $('#voice-call-panel').hidden = true;
    $('#btn-call').setAttribute('aria-pressed', 'false');
    $('#btn-call').setAttribute('aria-label', '开始语音对话');
    speaker.cancel();
    if (callRestore) {
      settings.speechOutput = callRestore.speechOutput;
      settings.wakeWord = callRestore.wakeWord;
      callRestore = null;
    }
    await setDirectVoice(false);
    return;
  }
  callStarting = true;
  callCloudFallback = false;
  callActive = true;
  callRestore = { speechOutput: settings.speechOutput, wakeWord: settings.wakeWord, directVoice: settings.directVoice };
  settings.speechOutput = true;
  settings.wakeWord = false;
  speaker.unlock();
  $('#voice-call-panel').hidden = false;
  $('#btn-call').setAttribute('aria-pressed', 'true');
  $('#btn-call').setAttribute('aria-label', '结束语音对话');
  recordVoiceEvent('通话','开始连接');
  callStatus('正在连接语音…');
  try {
    const ok = await setDirectVoice(true);
    if (gen !== callGeneration) { await setDirectVoice(false); return; }
    if (!ok) await setVoiceCall(false);
    else callStatus(voice.mode === 'ptt' ? '按住麦克风说话，松开后回复' : '直接说话，未央在听');
  } catch (e) {
    toast(`语音无法启动：${e.message || e}`);
    if (gen === callGeneration) await setVoiceCall(false);
  } finally { callStarting = false; }
}
$('#btn-call').addEventListener('click', () => setVoiceCall(!callActive));
$('#btn-call-end').addEventListener('click', () => setVoiceCall(false));
const voiceCheckButton = Object.assign(document.createElement('button'),{type:'button',className:'voice-diagnose',textContent:'检测语音'});
voiceCheckButton.onclick = async () => { await setVoiceCall(false); app.showPanel('settings'); await checkVoice(); };
$('#voice-call-panel').append(voiceCheckButton);
const takeFloor = Object.assign(document.createElement('button'), {type:'button',textContent:'我来说',id:'btn-call-listen'});
takeFloor.onclick = () => { if (app.active) app.active.muteSpeech=true; speaker.cancel(); voice.setSuppressed(false); callStatus('正在听你说话…'); };
$('#voice-call-panel').append(takeFloor);
const voiceLifecycle = createVoiceLifecycle({
  getState: () => ({ hidden:document.hidden, nativeActive:globalThis.__jarvisForeground !== false, starting:callStarting, systemDialog:Boolean(globalThis.__jarvisSystemSpeechDialog) }),
  onAudio: foreground => speaker.setForeground(foreground),
  onLeave: () => { if (dictating) { stopDictation(); return; } if (!MOBILE && !(voice instanceof QwenVoice)) return; if (callActive) { companion?.close(); setVoiceCall(false); } else if (voice.mode !== 'off') setDirectVoice(false); }
});
document.addEventListener('visibilitychange', () => voiceLifecycle.update());
addEventListener('jarvis:foreground', () => voiceLifecycle.update());
voiceLifecycle.update();

// “检测语音”：逐项检查麦克风 / 系统识别 / 云端转写 / 语音检测模型，告诉用户卡在哪一步
async function checkVoice() {
  const list = $('#voice-check');
  list.hidden = false;
  list.replaceChildren();
  const line = (ok, text) => { const li = document.createElement('li'); li.dataset.ok = ok === null ? 'wait' : ok ? '1' : '0'; li.textContent = text; list.append(li); return li; };
  await nativeVoiceReady;
  // 1. 麦克风
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    line(true, '麦克风：已允许');
  } catch (e) {
    line(false, `麦克风：不能用（${e.name === 'NotAllowedError' ? '权限被拒绝，请在系统设置里允许未央使用麦克风' : e.message || e.name}）`);
  }
  await checkRecognition(line);
  // 检测真正配置的声音，不能只检测手机系统朗读后声称云端女声正常。
  const tli = line(null,'实际声音服务：正在合成并试听…');
  try {
    const result = await speaker.test();
    tli.dataset.ok = '1'; tli.textContent = `实际声音：${result.engine} · ${result.voice || '服务默认'}（已解码并播放；请确认听感）`;
    recordVoiceEvent('声音检测成功',`${result.engine} ${result.voice}`);
  } catch (e) {
    tli.dataset.ok = '0'; tli.textContent = `实际声音服务不可用：${e.message}`; recordVoiceEvent('声音检测失败',e.message);
  }
  for (const event of readVoiceEvents().slice(-6)) line(null,`${new Date(event.time).toLocaleTimeString('zh-CN')} · ${event.stage}：${event.detail}`);

}

/** 语音自检里的“识别”部分 */
async function checkRecognition(line) {
  if (sttEngine() === 'qwen-realtime') {
    const li=line(null,'百炼实时识别：正在连接…');
    let session;
    try {
      session=await openQwenSession({model:QWEN_ASR,key:app.llmConfig.keys?.qwen||'',region:app.llmConfig.voice?.qwenRegion||'beijing',gateway: app.gateway,signal:AbortSignal.timeout(20000)});
      li.dataset.ok='1';li.textContent='百炼实时识别：会话配置成功；请实际说话验证，连接成功不代表已测识别准确率';
    } catch(e) {li.dataset.ok='0';li.textContent='百炼实时识别：'+e.message;}
    finally {session?.close();}
    return;
  }
  // 2. 识别方式
  if (voice instanceof NativeVoice) { line(true, '系统语音服务可发现；需实际说话验证，失败后尝试系统窗口或云端转写'); return; }
  if (MOBILE) line(false, '手机自带语音识别：这台手机没有可用的识别服务，改用云端转写');
  const id = sttEngine();
  if (id === 'browser') { line(true, '识别方式：浏览器自带语音识别'); return; }
  if (id === 'none') { line(false, '识别方式：没有可用的语音识别。请在“模型 → 声音”填硅基流动或 OpenAI 的 Key'); return; }
  // 3. 云端转写：发 1 秒静音试一下
  const li = line(null, `云端转写（${sttEngineById(id)?.name ?? id}）：检测中…`);
  try {
    await transcribe(id, app.llmConfig, encodeWav(new Float32Array(16000)), { gateway: app.gateway, signal: AbortSignal.timeout?.(20000) });
    li.dataset.ok = '1';
    li.textContent = `云端转写（${sttEngineById(id)?.name ?? id}）：接口连通（静音检测不代表实际识别准确）`;
  } catch (e) {
    li.dataset.ok = '0';
    li.textContent = `云端转写：${e.message}`;
  }
  if (MOBILE) { line(true, '语音切句：轻量录音模式，不需要下载语音检测模型'); return; }
  // 4. 语音检测模型（网页版云端转写靠它切分句子）
  const vli = line(null, '语音检测模型：检测中…');
  try {
    // 手机版打在 APK 里（本地服务不一定支持 HEAD，直接读）
    const r = await fetch(`${VAD.baseAssetPath}silero_vad_v5.onnx`, { method: MOBILE ? 'GET' : 'HEAD', signal: AbortSignal.timeout?.(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    vli.dataset.ok = '1';
    vli.textContent = MOBILE ? '语音检测模型：已内置' : '语音检测模型：能下载';
  } catch (e) {
    vli.dataset.ok = '0';
    vli.textContent = `语音检测模型：加载不了（${e.message}），说话后无法自动提交`;
  }
}
$('#btn-voice-check').addEventListener('click', () => checkVoice());

const mic = $('#btn-mic');
if (!browserSR && !window.jarvisDesktop && !MOBILE && sttEngine() === 'none') {
  // Firefox 等：隐藏语音输入，保留文本输入与语音输出（需求 6.1 / 10）
  mic.hidden = true;
  $('#row-voice').hidden = true;
  setSetting('directVoice', false);
}
async function stopDictation() {
  dictationGeneration++; dictating = false; clearTimeout(dictationTimer); dictationTimer = null;
  body.classList.remove('dictating'); await setDirectVoice(false); composer?.refresh();
}
async function toggleDictation() {
  if (dictating) return stopDictation();
  if (callActive) await setVoiceCall(false);
  speaker.cancel(); dictating = true; const gen = ++dictationGeneration; body.classList.add('dictating');
  dictationTimer = setTimeout(() => { if (dictating && gen === dictationGeneration) { stopDictation(); toast('本次转文字已结束，未发送消息'); } }, 45000);
  try { const ok = await setDirectVoice(true); if (gen !== dictationGeneration) { voice.disable(); return; } if (!ok) await stopDictation(); }
  catch (e) { if (gen === dictationGeneration) { await stopDictation(); toast(e.message); } }
}
mic.addEventListener('click', () => { if (voice.mode !== 'ptt') toggleDictation(); });
mic.addEventListener('pointerdown', (e) => {
  if (voice.mode !== 'ptt') return;
  e.preventDefault();
  mic.setPointerCapture(e.pointerId);
  mic.classList.add('ptt-active');
  voice.pttStart();
});
for (const ev of ['pointerup', 'pointercancel']) {
  mic.addEventListener(ev, () => {
    if (voice.mode !== 'ptt' || !mic.classList.contains('ptt-active')) return;
    mic.classList.remove('ptt-active');
    voice.pttEnd();
  });
}

// ---------------------------------------------------------------- 人脸跟随
let face = null;
async function setFaceFollow(on) {
  setSetting('faceFollow', on);
  $('#set-face').checked = on;
  const status = $('#face-status');
  if (!on) {
    face?.stop();
    app.live.face = null;
    status.textContent = '';
    return;
  }
  try {
    const { FaceTracker } = await import('./perception/faceTracker.js');
    face ??= new FaceTracker({
      onAngles: (a) => {
        if (!a) return;
        const t = followTarget(a);
        const had = app.live.face;
        app.live.face = t.inRange ? t : null;
        // 摄像头看到你回来了（之前 10 分钟以上没看到人）
        if (app.live.face) {
          if (!had && app.live.faceGoneAt && Date.now() - app.live.faceGoneAt >= 10 * 60_000) app.greetOnReturn({ awayMs: Date.now() - app.live.faceGoneAt, reason: 'face' });
          app.live.faceGoneAt = 0;
        } else if (had) app.live.faceGoneAt = Date.now();
      },
      onStatus: (s) => {
        status.textContent = {
          starting: '正在启动摄像头与本地模型…',
          tracking: '跟随中（15fps，本机推理）',
          degraded: '推理较慢，已降至 10fps / 320×240',
          lost: '未检测到人脸',
          off: ''
        }[s] ?? '';
        if (s === 'lost') { app.live.face = null; toast('未检测到人脸'); }
      }
    });
    await face.start();
  } catch (err) {
    face?.stop();
    setSetting('faceFollow', false);
    $('#set-face').checked = false;
    status.textContent = '';
    toast(err.name === 'NotAllowedError' ? '摄像头权限被拒绝' : `人脸跟随不可用：${err.message}`);
  }
}


mount(app, createPanels(app));

mount(app, createView(app));
$('#set-face').addEventListener('change', (e) => setFaceFollow(e.target.checked));
$('#set-voice').addEventListener('change', (e) => callActive && !e.target.checked ? setVoiceCall(false) : setDirectVoice(e.target.checked));
$('#set-wake').addEventListener('change', (e) => { setSetting('wakeWord', e.target.checked); wake.sleep(); });
$('#set-tts').addEventListener('change', (e) => {
  setSetting('readTyped', e.target.checked);
  if (!e.target.checked) speaker.cancel();
});
for (const b of document.querySelectorAll('#set-vad button')) {
  b.addEventListener('click', () => {
    setSetting('vadSensitivity', b.dataset.v);
    voice.setSilenceMs(SILENCE_BY_SENSITIVITY[b.dataset.v]);
    for (const x of document.querySelectorAll('#set-vad button')) x.setAttribute('aria-checked', String(x === b));
  });
}
globalThis.__jarvisToast = toast; // 手机原生保存文件时的进度提示

// ---------------------------------------------------------------- 编辑重发 / 重新生成
/**
 * 回到某句话之前重新来：
 *   edit  把你的这句话放回输入框，改好再发（这句话和它后面的都去掉）
 *   retry 去掉这条回答（和它后面的），把它前面那句话重新发一次
 */
async function rewindAndResend(kind, text) {
  if (app.active) { toast('等这一轮做完再改'); return; }
  const said = (m) => String(m.content).replace(/\n*\[已上传到工作区：[^\]]+\]$/, '').trim();
  let at = -1;
  if (kind === 'edit') at = app.history.findLastIndex((m) => m.role === 'user' && said(m) === text.trim());
  else {
    const reply = app.history.findLastIndex((m) => m.role === 'assistant' && stripEmotionTags(m.content).trim() === text.trim());
    if (reply > 0) for (let i = reply - 1; i >= 0; i--) if (app.history[i].role === 'user') { at = i; break; }
  }
  if (at < 0) { toast('找不到这条消息（可能已经翻页或改过）'); return; }
  const later = app.history.length - at - 1;
  let ok = true;
  if (later > 1) { try { ok = globalThis.confirm(`这句话后面还有 ${later} 条消息，会一起去掉。继续吗？`); } catch { /* 不支持弹窗就直接继续 */ } }
  if (!ok) return;
  const question = said(app.history[at]);
  if (app.server) {
    try { await app.server.truncateSession(app.session.id, at); } catch (e) { toast(`没改成：${e.message}`); return; }
  }
  app.history.splice(at);
  app.session.updatedAt = Date.now();
  // 本机模式下截成空的：空对话不会存盘，旧记录会留着；先删掉，重新发的时候再存
  if (!app.server && !app.history.length) sessionsApi.remove(app.session.id).catch(() => {}); else persistSession();
  replayTranscript();
  if (kind === 'edit') {
    prompt.value = question;
    autosize();
    prompt.focus();
    toast('改好后点发送');
  } else send(question);
}

// ---------------------------------------------------------------- 每条消息下面的“引用 / 朗读”（复制在 transcript.js 里直接做）
let readingBtn = null;
transcript.onAction = (kind, text, btn) => {
  if (kind === 'quote') {
    // 引用：把这条的开头放进输入框（“> ……”），接着打字问
    const plainText = toPlainText(text).replace(/\s+/g, ' ').trim();
    const excerpt = plainText.length > 100 ? `${plainText.slice(0, 100)}…` : plainText;
    prompt.value = `> ${excerpt}\n${prompt.value.replace(/^> .*\n/, '')}`;
    autosize();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    return;
  }
  if (kind === 'edit' || kind === 'retry') { rewindAndResend(kind, text); return; }
  if (kind === 'speak') {
    // 朗读这一条：再点一下停；只念正文，代码和表格不念
    const again = readingBtn === btn && speaker.speaking;
    speaker.cancel();
    if (readingBtn) { setActionIcon(readingBtn, 'speak'); readingBtn.removeAttribute('aria-pressed'); readingBtn = null; }
    if (again) return;
    speaker.unlock();
    noteAction('朗读一条回答');
    const chunker = new SentenceChunker();
    for (const s of [...chunker.push(toSpeech(text)), ...chunker.flush()]) speaker.speak(s);
    readingBtn = btn;
    setActionIcon(btn, 'stop');
    btn.setAttribute('aria-pressed', 'true');
    const watch = setInterval(() => {
      if (readingBtn !== btn || (!speaker.speaking && !speaker.pending)) {
        clearInterval(watch);
        if (readingBtn === btn) { setActionIcon(btn, 'speak'); btn.removeAttribute('aria-pressed'); readingBtn = null; }
      }
    }, 600);
  }
};

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
async function restoreDevice(permission, key, enable) {
  if (!settings[key]) return;
  let granted = false;
  try {
    granted = (await navigator.permissions.query({ name: permission })).state === 'granted';
  } catch { /* 不支持查询该权限：按未授权处理 */ }
  if (granted) enable(true);
  else setSetting(key, false);
}
restoreDevice('camera', 'faceFollow', setFaceFollow);
// 兼容显示（上次界面崩过）时不自动开麦克风：先让界面稳稳打开，需要时再手动开
if (!mic.hidden && !(MOBILE && document.documentElement.classList.contains('safe-render'))) restoreDevice('microphone', 'directVoice', setDirectVoice);


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
sessionsPanel = initSessionsPanel({
  getCurrentId: () => app.session.id,
  onOpen: (id) => openSession(id),
  onNew: () => newSession(),
  onDeleted: (id) => { if (id === app.session.id) switchTo(sessionsApi.create()); },
  settings,
  onSaveChange: (on) => {
    setSetting('saveSessions', on);
    if (on) persistSession();
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
      sessionsPanel.refresh();
      // 当前对话在另一台设备上接着聊过：没在回答时换成合并后的版本
      const fresh = !app.active && app.history.length ? await sessionsApi.get(app.session.id) : null;
      if (fresh && fresh.messages.length !== app.history.length) {
        app.session = fresh;
        app.reflectFrom = app.history.length;
        replayTranscript();
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
initServerPanel({ getLlmConfig: () => app.llmConfig, toast: (t) => toast(t), onConfigSaved: () => app.refreshServerModel(), onImported: () => { sessionsPanel?.refresh(); drawer?.refresh?.(); } });
syncController.start();

// 手机：底部菜单改成左侧抽屉（新对话 · 功能 · 历史对话）；面板全屏打开，左上角“返回对话”
let drawer = null;
if (COMPACT) {
  const icons = Object.fromEntries([...document.querySelectorAll('.rail-btn')].map((b) => [b.dataset.panel, b.querySelector('svg').outerHTML]));
  drawer = initDrawer({
    icons,
    onNew: () => { newSession(); app.closeSide(); },
    onOpenSession: (id) => { openSession(id); app.closeSide(); },
    onPanel: (name) => app.showPanel(name),
    listSessions: () => sessionsApi.list(),
    cachedSessions: () => sessionsApi.cachedList(),
    currentId: () => app.session.id,
    onRename: async (id, title) => {
      await sessionsApi.rename(id, title);
      if (id === app.session.id) { app.session.title = title; app.session.titleSet = true; showChatTitle(); }
      sessionsPanel?.refresh();
    },
    onPin: async (id, pinned) => { await sessionsApi.setPinned(id, pinned); if (id === app.session.id) app.session.pinned = pinned; sessionsPanel?.refresh(); },
    onExport: (id, kind) => exportSession(id, kind),
    searchContent: (q) => sessionsApi.searchContent(q),
    onDelete: async (id) => {
      await sessionsApi.remove(id);
      if (id === app.session.id) switchTo(sessionsApi.create());
      sessionsPanel?.refresh();
      toast('已删除');
    }
  });
  $('#btn-menu').hidden = false;
  $('#btn-menu').addEventListener('click', () => drawer.open());
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
    await switchTo(leftSession);
    if(checkpointNeedsReview(left.checkpoint)) {
      savePending(storage,left.sessionId,left);
      const card=document.createElement('section');card.className='task-recovery';card.setAttribute('role','status');
      const note=document.createElement('p');note.textContent='上次退出时有操作的结果未确认，先核对再继续，避免重复执行。';
      const resume=document.createElement('button');resume.type='button';resume.textContent='核对并继续';resume.onclick=()=>{card.remove();send(resumeText(left));};
      const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='不再继续';dismiss.onclick=()=>{clearPending(storage,left.sessionId,left.turnId);card.remove();};
      card.append(note,resume,dismiss);$('#transcript').append(card);
    } else {
      toast('上次退出时任务还没做完，正在核对进度后继续');send(resumeText(left));
    }
    sessionsPanel.refresh();
    return;
  }
  // 手机：只有刷新页面、或界面崩溃后自动重开时才接回刚才的对话；从后台关掉再打开就停在首页
  const reopened = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload' || globalThis.__jarvisRecentCrash === true;
  if ((!COMPACT || reopened) && recent && Date.now() - recent.updatedAt < 6 * 3600_000 && !app.history.length) {
    if (app.server) await openSession(recent.id); // 服务器的列表不带消息：先显示副本，再取完整的
    else await switchTo(recent);
  }
  sessionsPanel.refresh();
})();
agentMemory.maintain().catch(() => {});

// ---------------------------------------------------------------- 光核旁的建议标注
app.bootSequence();

app.initSuggestions();
app.updateStageMode();
app.callouts.set(openingSuggestions({ desktop: Boolean(DESKTOP), hasSkills: false }));
if (!app.history.length) openingCallouts(false);

// ---------------------------------------------------------------- 键盘快捷键
//   Esc 打断   /  聚焦输入框   Alt+1..6 面板   Alt+F 专注视图   Alt+V 直接对话
//   Alt+O / Alt+H / Alt+W 光核 / 胸像 / 线框   按住空格：按下说话（降级模式、焦点不在输入框时）
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (interrupt()) { e.preventDefault(); toast('已打断'); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyO') {
    e.preventDefault();
    newSession();
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const k = e.code;
    const n = /^Digit([1-8])$/.exec(k)?.[1];
    if (n) app.showPanel(PANES[n - 1]);
    else if (k === 'KeyF') app.setFocusView(!settings.focusView);
    else if (k === 'KeyV' && !mic.hidden) toggleDictation();
    else return;
    e.preventDefault();
    return;
  }
  if (typing(document.activeElement)) return;
  if (e.key === '/') {
    e.preventDefault();
    prompt.focus();
  } else if (e.code === 'Space' && voice.mode === 'ptt' && !e.repeat) {
    e.preventDefault();
    mic.classList.add('ptt-active');
    voice.pttStart();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && voice.mode === 'ptt' && mic.classList.contains('ptt-active')) {
    mic.classList.remove('ptt-active');
    voice.pttEnd();
  }
});

// 调试 / 自动化测试入口
window.__jarvis = {
  machine: app.machine,
  speaker,
  get voice() { return voice; },
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
  send,
  interrupt,
  showPanel: app.showPanel,
  newSession,
  openSession,
  get sessionId() { return app.session.id; },
  sessionGet: (id) => sessionsApi.get(id),
  get quality() { return app.quality; },
  workspace: ws
};

// 工作台界面只用在电脑上；手机 App 保留自己的界面（底部输入、左侧抽屉菜单、整页面板）
if (!COMPACT) initWorkbench({showPanel: app.showPanel,newSession,openSession,getSession:()=>app.session,getRunning:()=>app.active && !app.active.streamDone ? app.session.id : null,openFile:openInWorkspace});
mascots = initMascots();
companion = initCompanion({ send, startVoice: async () => { await setVoiceCall(true); return callActive; }, stopVoice: () => setVoiceCall(false), speak: text => { speaker.unlock(); speaker.speak(text); } });
const hologram = initHologramCompanion({send:async text=>{if(app.active)throw new Error('当前任务还在进行，请稍等完成后再发送。');await send(text);},onFull:()=>{body.classList.add('side-closed');body.classList.remove('side-open');document.querySelector('.wb-tabs button')?.click();},wallpaper:MOBILE?async()=>{const {registerPlugin}=await import('@capacitor/core');await registerPlugin('CompanionWallpaper').open();}:null});
const holoEntry=Object.assign(document.createElement('button'),{type:'button',className:'wy-hologram-entry',textContent:'✧ 全息陪伴'});
holoEntry.onclick=()=>{companion.close();hologram.open();};document.querySelector('.wy-companion-head span').after(holoEntry);
if(DESKTOP?.onWallpaperRequest)DESKTOP.onWallpaperRequest(async request=>{
  if(request.open){hologram.open();return;}
  if(!request.text)return;
  try{if(app.active)throw new Error('当前任务还在进行，请稍等完成后再发送。');await send(request.text);const reply=[...document.querySelectorAll('#transcript .msg.agent')].at(-1);const text=[...(reply?.querySelectorAll('.body')||[])].map(el=>el.textContent).join('\n');wp({say:text||'本轮已结束，可以打开完整对话查看结果。',requestId:request.id});}
  catch(error){wp({say:`这次没有完成：${error.message||error}`,requestId:request.id,error:true});}
});
if(MOBILE){import('@capacitor/core').then(({registerPlugin})=>{const plugin=registerPlugin('CompanionWallpaper');const check=async()=>{try{const r=await plugin.consumeOpen();if(r.open)hologram.open();}catch{}};check();document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});}).catch(()=>{});}
composer = initConversationComposer({cancelDictation:()=>stopDictation()});
initCompanionAppearance();
initRenderHealthPanel({ mobile: MOBILE, toast, onChange: () => { if (!app.active) replayTranscript(); } });

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
      const open=document.createElement('button');open.type='button';open.className='btn sm';open.textContent='查看并继续';open.onclick=async()=>{await openSession(rec.sessionId);prompt.value=resumeText(rec);autosize();app.showPanel('settings',{toggle:true});prompt.focus();};
      const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='btn ghost sm';dismiss.textContent='不再继续';dismiss.onclick=()=>{clearPending(storage,rec.sessionId,rec.turnId);draw();};card.append(title,open,dismiss);list.append(card);
    }
  };toggle.onclick=()=>{list.hidden=!list.hidden;if(!list.hidden)draw();};
}


