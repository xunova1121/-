/**
 * 一轮对话：发消息（本机做 / 交给服务器做 / 团队分工）、显示进度和工具卡片、朗读、出错恢复；
 * 干活时插话、打断、切到别的对话后转到后台接着做。
 */
import { MOBILE } from '../config.js';
import { checkpointEvent } from '../../shared/taskCheckpoint.js';
import { stripEmotionTags } from '../../shared/emotionTag.js';
import { createAdapter, providerById } from '../llm/config.js';
import { classifyTask, routeFor, TASKS, fallbackRoutes, effortFor, isSmallTalk, computerTaskKind } from '../llm/router.js';
import { runTeam, shouldTeam } from '../agent/team.js';
import { runAgent } from '../agent/agent.js';
import { collectRequirements } from '../agent/taskRequirements.js';
import { preApproved } from '../agent/commandSafety.js';
import * as ws from '../agent/workspace.js';
import * as agentMemory from '../agent/memory.js';
import * as compress from '../agent/compress.js';
import * as skillPacks from '../agent/skillPacks.js';
import { STATUS_ASK, STOP_ASK, turnStatus } from '../core/interject.js';
import { SentenceChunker } from '../core/sentenceChunker.js';
import { followUpSuggestions, interruptionMark } from '../core/suggest.js';
import { savePending, clearPending } from '../core/pendingTask.js';
import { runRemote } from '../core/serverClient.js';
import { createPCModelAdapter } from '../core/pcModelClient.js';
import { toolLabel, summarizeArgs, searchBrand } from '../ui/transcript.js';
import { createTaskKeeper } from '../mobile/backgroundTasks.js';
import { noteAction } from '../mobile/renderDiagnostics.js';
import { isAuto } from '../ui/modelPicker.js';
import { $, DESKTOP, COMPACT, now, storage, toast, wp, markActivity } from './env.js';

export function createTurn(app) {
  let turns = 0;
  const recentImages = new Map(); // 消息时间 → 这条消息带的图片（只在内存里，不存盘）
  const taskKeeper = createTaskKeeper(globalThis.__jarvisBackgroundTask, e => toast(e.message));


  /** 打断（barge-in）：停止朗读并中止正在执行的任务 */
  function interrupt() {
    const had = app.speaker.speaking || app.active;
    if (app.active) app.callouts?.show();
    if (app.active) {
      const turn=app.active;
      if(!turn.streamDone&&(turn.shown?.trim()||turn.files?.size))app.rememberTurn('assistant',(turn.shown||'').trim()+'\n\n（已打断，还没完成；以上内容已保留）',{...(turn.usedTools?.length&&{tools:[...new Set(turn.usedTools)]}),...(turn.files?.size&&{files:[...turn.files]})},turn.session);
      app.active.ctrl.abort();
      app.active.bubble?.done('已打断');
      app.active = null;
      app.setTask('idle');
    }
    app.speaker.cancel();
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
    let chunker = new SentenceChunker({ maxLen:app.callActive ? 24 : 60 });
    let full = '';
    let fed = 0, speechGeneration = app.speaker.gen;
    const speechTurn = app.active;
    return {
      resume() { if (speechTurn) speechTurn.muteSpeech = false; full = ''; fed = 0; chunker = new SentenceChunker({maxLen:app.callActive ? 24 : 60}); speechGeneration = app.speaker.gen; },
      push(delta) {
        if (speechTurn?.muteSpeech) return;
        full += delta;
        const spoken = full.replace(/```[\s\S]*?```/g, '\n').replace(/```[\s\S]*$/, '');
        if (!app.speaker.foreground || speechGeneration !== app.speaker.gen) { chunker = new SentenceChunker({ maxLen:app.callActive ? 24 : 60 }); speechGeneration = app.speaker.gen; if (!app.speaker.foreground) { fed = spoken.length; return; } }
        if (spoken.length > fed) {
          for (const s of chunker.push(spoken.slice(fed))) app.speaker.speak(s.replace(/[*#`|>]/g, ''));
          fed = spoken.length;
        }
      },
      flush() { if (speechTurn?.muteSpeech || !app.speaker.foreground || speechGeneration !== app.speaker.gen) return; for (const s of chunker.flush()) app.speaker.speak(s.replace(/[*#`|>]/g, '')); }
    };
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
    app.transcript.add('user', text, Date.now(), { thumbs });
    const reply = (words) => { const b = app.transcript.add('agent', words); b.done(); };
    if (STOP_ASK.test(text)) { interrupt(); reply('好的，已经停下。上面是停下前做到的地方，要接着做跟我说一声。'); return; }
    if (STATUS_ASK.test(text)) { reply(`${turnStatus(turn, now())}。做完会直接给你结果；想停的话点右下角的方块，或者说“停”。`); return; }
    app.rememberTurn('user', text, thumbs.length ? { thumbs } : {}, turn.session);
    if (!turn.remote) {
      turn.inbox.push(text);
      if (MOBILE) { turn.checkpoint=checkpointEvent(turn.checkpoint,{type:'user_note',text}); savePending(storage,turn.session.id,{checkpoint:turn.checkpoint}); }
    } else if (!turn.remoteId) {
      turn.inbox.push(text); reply('收到补充，连接到原任务后会送达。'); return;
    } else {
      try { await app.server.appendTaskNote(turn.remoteId,text); }
      catch(e) { if (!app.prompt.value.trim()) { app.prompt.value=text; app.autosize(); } reply('补充没有送达，已放回输入框。原任务不会重复执行；服务器较旧时请先更新服务器。'); return; }
    }
    reply(`收到，做完手上这一步就看这句话（${turnStatus(turn, now())}）。`);
  }
  /** 切到别的对话：正在干的任务转到后台接着做 */
  function toBackground(turn) {
    turn.background = true;
    backgroundTurns.add(turn);
    app.active = null;
    app.speaker.cancel();
    app.setTask('idle');
    toast('刚才的任务在后台接着做，做完会提醒你');
  }
  /** 后台任务做完（或出错）：记回原来的对话，提醒用户 */
  function finishBackground(turn, { text = '', error = '', shown = '', usedTools = [], files = new Set() }) {
    backgroundTurns.delete(turn);
    const extra = { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(files.size && { files: [...files].slice(-12) }) };
    const title = turn.session.title || '另一个对话';
    if (error) {
      if (shown.trim() || usedTools.length) app.rememberTurn('assistant', `${shown.trim()}\n\n${interruptionMark(error)}`, extra, turn.session);
      toast(`「${title}」里的任务没做完：${error.slice(0, 40)}`);
    } else {
      app.rememberTurn('assistant', text || '（完成）', extra, turn.session);
      toast(`「${title}」里的任务做完了，切回去就能看到`);
    }
    turn.bubble.done();
    app.sessionsPanel?.refresh();
  }

  async function send(text, { echo = true, byVoice = false } = {}) {
    noteAction(byVoice ? '语音提问' : '发消息');
    app.askNotifyOnce();
    text = String(text || '').trim();
    if (!text && !app.attachments.length) return;
    if (!app.attachments.length && app.companion?.perform(text)) return;
    if (!text && app.attachments.some((a) => a.image)) text = '请看看这张图片。';
    // 正在干活时又发了一句：不打断，问进度就直接答，别的话交给正在干的未央；说“停”才停
    if (echo && app.active && !app.active.streamDone) {
      const extra = app.attachments.splice(0); app.renderAttachments();
      if (app.server && extra.length) {
        try { for (const f of extra) await app.server.upload(f.path, await ws.readBlob(f.path)); }
        catch (e) { app.attachments.unshift(...extra); app.renderAttachments(); if (!app.prompt.value.trim()) { app.prompt.value=text; app.autosize(); } toast(`附件未送达，已保留：${e.message}`); return; }
        if (!app.active || app.active.streamDone) { app.attachments.unshift(...extra); app.renderAttachments(); return send(text,{echo,byVoice}); }
      }
      const content = extra.length ? text + '\n\n[已上传到工作区：' + extra.map(f=>f.path).join('、') + ']' : text;
      return interject(content, { thumbs:extra.filter(f=>f.image).map(f=>({src:f.image.thumb,path:f.path})) });
    }
    if (app.active) { app.active.ctrl.abort(); app.active = null; }
    app.speaker.cancel();
    app.speaker.unlock(); // 发送多由点击 / 回车触发：顺便启动音频上下文，云端语音才能播放

    // 持续聊天也保持有界；先重画已完成的历史，再追加本轮，避免重复消息。
    if (MOBILE && (app.historyViewEnd !== null || $('#transcript').querySelectorAll('.msg').length >= app.visibleHistory().limit)) app.replayTranscript();
    const files = app.attachments.splice(0);
    app.renderAttachments();
    const userText = files.length ? `${text}\n\n[已上传到工作区：${files.map((f) => f.path).join('、')}]` : text;
    const imgs = files.filter((f) => f.image).map((f) => f.image);
    const thumbs = files.filter(f => f.image).map(f => ({ src:f.image.thumb, path:f.path }));
    if (echo) app.transcript.add('user', userText, Date.now(), { thumbs }); // echo=false：这句话之前已经显示并记下了
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
    if (echo) app.rememberTurn('user', userText, thumbs.length ? { thumbs } : {});
    if (imgs.length) {
      recentImages.set(app.history.at(-1).ts, imgs.map(({ mime, data }) => ({ mime, data })));
      while (recentImages.size > 2) recentImages.delete(recentImages.keys().next().value);
    }

    if (app.machine.task !== 'listening') app.machine.beginUserTurn();
    const ctrl = new AbortController();
    const bubble = app.transcript.add('agent');
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
    const task = computerKind === 'gui' ? 'vision' : shouldTeam(text, app.settings.teamMode === 'auto' && !app.helperLlm() ? 'off' : app.settings.teamMode) ? 'reason' : classifyTask(text, { images: imgs.length + withImages.size });
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
    const spoken = app.callActive || byVoice || app.settings.readTyped;
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
    const team = !app.server && !computerKind && shouldTeam(text, app.settings.teamMode === 'auto' && !app.helperLlm() ? 'off' : app.settings.teamMode);
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
            catch(e) { app.prompt.value += (app.prompt.value.trim()?'\n':'')+note; app.autosize(); toast('补充未送达原任务，已保留在输入框，请更新服务器或重新发送'); }
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
        voice: app.callActive || byVoice,
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
            if(app.callActive&&app.callTiming?.recognizedAt&&!app.callTiming.firstTextAt)app.callTiming.firstTextAt=now();
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
            if (app.callActive) app.callStatus('已收到，正在按补充要求处理…');
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
      app.rememberTurn('assistant', result.text || '（完成）', { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(madeFiles.size && { files: [...madeFiles].slice(-12) }) }, turn.session);
      // 做完时人不在（App 在后台 / 窗口没在看）：发通知，点开就能看结果
      if (document.hidden) app.notify('未央做完了', `${(turn.session.title || text).slice(0, 30)}：${stripEmotionTags(result.text || '').replace(/\s+/g, ' ').slice(0, 120)}`);
      // 在本机做的这一轮也记回服务器上的这段对话（手机上能看到）
      if (here) app.server.appendSession(turn.session.id, turn.session.messages.slice(-2).map(({ role, content, ts, tools }) => ({ role, content, ts, ...(tools && { tools }) }))).catch((e) => toast(`这一轮没能记到服务器上：${e.message}`));
      $('#mode-pill').classList.remove('offline');
      turn.streamDone = true;
      app.callouts?.set(followUpSuggestions({ tools: usedTools, userText: text, desktop: Boolean(DESKTOP) }));
      app.scheduleReflect();
      app.compressHistory();
      if (!app.speaker.speaking) finishTurn();
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
      if (resumable) app.rememberTurn('assistant', `${shown.trim()}\n\n${interruptionMark(err)}`, { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(madeFiles.size && { files: [...madeFiles].slice(-12) }) }, turn.session);
      app.callouts?.set(followUpSuggestions({ error: true, resumable, userText: text, desktop: Boolean(DESKTOP) }));
    } finally {
      if (MOBILE) clearPending(storage, turn.session.id, turn.t0);
      await app.persistSession(turn.session);
      releaseTask();
      app.endControl();
      // 回答写完的一瞬间又收到的话（没来得及交给模型）：接着当一句新话处理
      const left = turn.inbox.splice(0);
      if(left.length&&turn.remote){app.prompt.value+=(app.prompt.value.trim()?'\n':'')+left.join('\n');app.autosize();toast('未送达的补充已放回输入框，没有另开任务');}
      else if (left.length && !ctrl.signal.aborted && !turn.background && app.session === turn.session) setTimeout(() => send(left.join('\n'), { echo: false }), 0);
    }
  }

  return {
    send, interrupt, finishTurn, makeSpeech, interject, toBackground, finishBackground, taskKeeper, backgroundTurns, recentImages,
    get turns() { return turns; }
  };
}
