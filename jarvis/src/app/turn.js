/**
 * 一轮对话：发消息（本机做 / 交给服务器做 / 团队分工）、显示进度和工具卡片、朗读、出错恢复；
 * 干活时插话、打断、切到别的对话后转到后台接着做。
 */
import { MOBILE } from '../config.js';
import { remoteTurnImages } from '../core/imageFollowup.js';
import { checkpointEvent } from '../../shared/taskCheckpoint.js';
import { stripEmotionTags } from '../../shared/emotionTag.js';
import { createAdapter, providerById } from '../llm/config.js';
import { TASKS, fallbackRoutes, isSmallTalk } from '../llm/router.js';
import { runTeam, shouldTeam } from '../agent/team.js';
import { runAgent } from '../agent/agent.js';
import { collectRequirements } from '../agent/taskRequirements.js';
import { preApproved } from '../agent/commandSafety.js';
import * as ws from '../agent/workspace.js';
import * as agentMemory from '../agent/memory.js';
import { STATUS_ASK, STOP_ASK, turnStatus } from '../core/interject.js';
import { SentenceChunker } from '../core/sentenceChunker.js';
import { followUpSuggestions, interruptionMark } from '../core/suggest.js';
import { savePending, clearPending } from '../core/pendingTask.js';
import { runRemote } from '../core/serverClient.js';
import { createTaskKeeper } from '../mobile/backgroundTasks.js';
import { noteAction } from '../mobile/renderDiagnostics.js';
import { providerLabel } from '../llm/modelLibrary.js';
import { $, DESKTOP, now, storage, toast, wp, markActivity } from './env.js';

export function createTurn(app) {
  let turns = 0;
  const taskKeeper = createTaskKeeper(globalThis.__jarvisBackgroundTask, (e) => toast(e.message));

  /** 打断（barge-in）：停止朗读并中止正在执行的任务 */
  function interrupt() {
    const had = app.speaker.speaking || app.active;
    if (app.active) app.callouts?.show();
    if (app.active) {
      const turn = app.active;
      if (!turn.streamDone && (turn.shown?.trim() || turn.files?.size))
        app.rememberTurn(
          'assistant',
          (turn.shown || '').trim() + '\n\n（已打断，还没完成；以上内容已保留）',
          { ...(turn.usedTools?.length && { tools: [...new Set(turn.usedTools)] }), ...(turn.files?.size && { files: [...turn.files] }) },
          turn.session
        );
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
    setTimeout(() => {
      if (!app.active) app.setTask('idle');
    }, 3000);
    app.panels.refreshMind();
  }

  /** 朗读只读正文：代码块（``` 包围的部分，包括还没闭合的）不读。auto 为 false（打字提问）时不念 */
  function makeSpeech(auto = true) {
    if (!auto) return { push() {}, flush() {}, resume() {} };
    let chunker = new SentenceChunker({ maxLen: app.callActive ? 24 : 60 });
    let full = '';
    let fed = 0,
      speechGeneration = app.speaker.gen;
    const speechTurn = app.active;
    return {
      resume() {
        if (speechTurn) speechTurn.muteSpeech = false;
        full = '';
        fed = 0;
        chunker = new SentenceChunker({ maxLen: app.callActive ? 24 : 60 });
        speechGeneration = app.speaker.gen;
      },
      push(delta) {
        if (speechTurn?.muteSpeech) return;
        full += delta;
        const spoken = full.replace(/```[\s\S]*?```/g, '\n').replace(/```[\s\S]*$/, '');
        if (!app.speaker.foreground || speechGeneration !== app.speaker.gen) {
          chunker = new SentenceChunker({ maxLen: app.callActive ? 24 : 60 });
          speechGeneration = app.speaker.gen;
          if (!app.speaker.foreground) {
            fed = spoken.length;
            return;
          }
        }
        if (spoken.length > fed) {
          for (const s of chunker.push(spoken.slice(fed))) app.speaker.speak(s.replace(/[*#`|>]/g, ''));
          fed = spoken.length;
        }
      },
      flush() {
        if (speechTurn?.muteSpeech || !app.speaker.foreground || speechGeneration !== app.speaker.gen) return;
        for (const s of chunker.flush()) app.speaker.speak(s.replace(/[*#`|>]/g, ''));
      }
    };
  }

  // —— 干活时插话、切换对话后台继续
  const backgroundTurns = new Set();
  /** 干活时又发来一句：问进度直接答；说停就停；其他的交给正在干的未央（下一步开始前看到），不打断 */
  async function interject(text, { thumbs = [] } = {}) {
    const turn = app.active;
    app.transcript.add('user', text, Date.now(), { thumbs });
    const reply = (words) => {
      const b = app.transcript.add('agent', words);
      b.done();
    };
    if (STOP_ASK.test(text)) {
      interrupt();
      reply('好的，已经停下。上面是停下前做到的地方，要接着做跟我说一声。');
      return;
    }
    if (STATUS_ASK.test(text)) {
      reply(`${turnStatus(turn, now())}。做完会直接给你结果；想停的话点右下角的方块，或者说“停”。`);
      return;
    }
    app.rememberTurn('user', text, thumbs.length ? { thumbs } : {}, turn.session);
    if (!turn.remote) {
      turn.inbox.push(text);
      if (MOBILE) {
        turn.checkpoint = checkpointEvent(turn.checkpoint, { type: 'user_note', text });
        savePending(storage, turn.session.id, { checkpoint: turn.checkpoint });
      }
    } else if (!turn.remoteId) {
      turn.inbox.push(text);
      reply('收到补充，连接到原任务后会送达。');
      return;
    } else {
      try {
        await app.server.appendTaskNote(turn.remoteId, text);
      } catch (e) {
        if (!app.prompt.value.trim()) {
          app.prompt.value = text;
          app.autosize();
        }
        reply('补充没有送达，已放回输入框。原任务不会重复执行；服务器较旧时请先更新服务器。');
        return;
      }
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

  /** 正在干活时又发来一句（可能带附件）：附件先传到服务器，再按插话处理 */
  async function addToRunningTurn(text, { echo, byVoice }) {
    const extra = app.attachments.splice(0);
    app.renderAttachments();
    if (app.server && extra.length) {
      try {
        for (const f of extra) await app.server.upload(f.path, await ws.readBlob(f.path));
      } catch (e) {
        app.attachments.unshift(...extra);
        app.renderAttachments();
        if (!app.prompt.value.trim()) {
          app.prompt.value = text;
          app.autosize();
        }
        toast(`附件未送达，已保留：${e.message}`);
        return;
      }
      if (!app.active || app.active.streamDone) {
        app.attachments.unshift(...extra);
        app.renderAttachments();
        return send(text, { echo, byVoice });
      }
    }
    const content = extra.length ? text + '\n\n[已上传到工作区：' + extra.map((f) => f.path).join('、') + ']' : text;
    return interject(content, { thumbs: extra.filter((f) => f.image).map((f) => ({ src: f.image.thumb, path: f.path })) });
  }

  async function send(text, { echo = true, byVoice = false } = {}) {
    noteAction(byVoice ? '语音提问' : '发消息');
    app.askNotifyOnce();
    text = String(text || '').trim();
    if (!text && !app.attachments.length) return;
    if (!app.attachments.length && app.companion?.perform(text)) return;
    if (!text && app.attachments.some((a) => a.image)) text = '请看看这张图片。';
    // 正在干活时又发了一句：不打断，问进度就直接答，别的话交给正在干的未央；说“停”才停
    if (echo && app.active && !app.active.streamDone) return addToRunningTurn(text, { echo, byVoice });
    if (app.active) {
      app.active.ctrl.abort();
      app.active = null;
    }
    app.speaker.cancel();
    app.speaker.unlock(); // 发送多由点击 / 回车触发：顺便启动音频上下文，云端语音才能播放

    const { files, userText, imgs, withImages, llmHistory } = app.takeTurnInput(text, echo);

    if (app.machine.task !== 'listening') app.machine.beginUserTurn();
    const ctrl = new AbortController();
    const bubble = app.transcript.add('agent');
    app.liveBubble = bubble;
    bubble.el.classList.add('streaming');
    // 这一轮属于哪个会话：切到别的对话后在后台接着做，结果、文件都记回这个会话
    const turn = { ctrl, streamDone: false, bubble, session: app.session, files: new Set(), inbox: [], t0: now(), steps: 0, status: '', background: false };
    app.active = turn;
    app.setTask('processing', '思考中');
    // 这一轮的进度记录：事件处理（turnEvents）边收边改，做完 / 出错时用来显示和记进对话
    const st = {
      shown: '', // 这一轮已经显示出来的回答（中断时保留，点“继续”接着写）
      firstToken: 0,
      outMarked: false, // 崩溃记录：这一段在输出文字
      textChunks: 0, // 回答分几次收到：1 次说明是整段一次性到的（中转站或网络没有边生成边给）
      serverCard: null,
      ctxMs: null,
      teamCard: null,
      usedModel: '',
      usedTools: []
    };
    // 手机：记下正在做的任务（App 被划掉时，下次打开接着做）
    const doneSteps = [];
    turn.checkpoint = { text: userText, notes: [], inFlight: [], steps: [], files: [], status: 'running' };
    if (MOBILE && !app.server)
      savePending(storage, app.session.id, {
        turnId: turn.t0,
        text: userText,
        title: app.session.title || '',
        ts: Date.now(),
        steps: [],
        files: [],
        checkpoint: turn.checkpoint
      });

    const { computerKind, task, route, remotePC, model, adapter, problem, effort, here } = app.chooseTurnModel(text, turn, st, { imgs, withImages });
    if (problem && (!app.server || here)) {
      // 服务器模式：用服务器上的模型设置
      bubble.append(problem);
      bubble.done();
      app.callouts?.set(followUpSuggestions({ error: true, userText: text }));
      app.active = null;
      app.setTask('error', '需要配置模型');
      app.showPanel('models');
      return;
    }

    // 备用模型：当前模型出错（重试后还不行）时自动换着用
    const fallbacks = remotePC
      ? []
      : fallbackRoutes(app.llmConfig, { provider: route.cfg.provider, model, task })
          .map((f) => ({ ...createAdapter(f.cfg, { gateway: app.gateway }), label: `${providerLabel(f.cfg, f.provider)} · ${f.model}` }))
          .filter((f) => !f.problem && f.adapter && f.model);

    // 语音对话中、或者是说话提问的：念回答；打字提问只显示（设置里打开“打字提问也朗读”除外）
    const spoken = app.callActive || byVoice || app.settings.readTyped;
    const speech = makeSpeech(spoken);
    const cards = new Map();
    const t0 = now();
    const usedTools = st.usedTools;
    turn.usedTools = usedTools;
    const madeFiles = turn.files;
    app.callouts?.retract();
    // 内置演示模式下“自动”不触发（规则拆步效果有限），只认明确的“/团队 …”或“总是”
    const team = !app.server && !computerKind && shouldTeam(text, app.settings.teamMode === 'auto' && !app.helperLlm() ? 'off' : app.settings.teamMode);
    const releaseTask = taskKeeper.begin();
    try {
      // 服务器模式：服务器做，进度事件和本机一样显示（runRemote 的用法和 runAgent 一样）
      const serverRun = async (o) => {
        for (const f of files) await app.server.upload(f.path, await ws.readBlob(f.path)); // 发来的附件先传到服务器的工作区
        // 追问前面发过的图（“这个图……”）：本机模式靠历史里带图，服务器那边没有这些图，一起发过去（最多 4 张）
        return runRemote(app.server, {
          sessionId: o.sessionId,
          userText: o.userText,
          images: remoteTurnImages(o.images, llmHistory),
          voice: o.voice,
          emit: o.emit,
          signal: o.signal,
          onFile: (p) => app.pullServerFile(p, turn),
          onStarted: async (remoteTask) => {
            turn.remoteId = remoteTask.id;
            for (const note of turn.inbox.splice(0)) {
              try {
                await app.server.appendTaskNote(remoteTask.id, note);
              } catch (e) {
                app.prompt.value += (app.prompt.value.trim() ? '\n' : '') + note;
                app.autosize();
                toast('补充未送达原任务，已保留在输入框，请更新服务器或重新发送');
              }
            }
          }
        });
      };
      const sight = app.imageDescriber?.(); // 当前模型看不了图时替它看图
      const result = await (app.server && !here ? serverRun : team ? runTeam : runAgent)({
        llm: team ? app.helperLlm('reason') : undefined,
        pickModel: team ? app.modelForRole : undefined,
        effort,
        adapter,
        model,
        history: llmHistory,
        userText: team ? userText : await app.expandSlash(userText),
        signal: ctrl.signal,
        computerTask: computerKind,
        sessionId: app.session.id,
        summary: app.session.summary ?? null,
        requirements: collectRequirements(app.history, app.session.requirements),
        requirementText: userText, // 保留斜杠命令展开前的原话，避免当成缺失历史重复注入
        fallbacks,
        describeImages: sight?.describe,
        visionLabel: sight?.label,
        inbox: team ? null : turn.inbox,
        checkpoint:
          MOBILE && !turn.remote
            ? async (event) => {
                turn.checkpoint = checkpointEvent(turn.checkpoint, event);
                savePending(storage, turn.session.id, { checkpoint: turn.checkpoint, ts: Date.now(), files: [...turn.files] });
              }
            : null,
        // 语音对话：让模型用口语短答；“你好 / 谢谢”这类寒暄不带工具，回得快
        voice: app.callActive || byVoice,
        light: !files.length && isSmallTalk(text),
        maxSteps: DESKTOP ? 40 : 28, // 用鼠标键盘操作电脑、逐项联网核实时步数多
        images: imgs.map(({ mime, data }) => ({ mime, data })),
        tools: app.server && !here ? [] : await app.buildTools({ turn }),
        approve: async (req) => {
          if (preApproved(req, { sessionKeys: app.sessionApprovals })) return true; // 危险命令每次都问
          // 看屏幕后主窗口已隐藏，确认卡必须先恢复可见；保持紧急停止热键有效。
          if (app.controlActive && DESKTOP) await DESKTOP.invoke('controlPause');
          if (ctrl.signal.aborted) return false;
          app.setTask('processing', '等待你确认');
          let cancel;
          const aborted = new Promise((r) => {
            cancel = () => r('deny');
            ctrl.signal.addEventListener('abort', cancel, { once: true });
          });
          try {
            const v = await Promise.race([bubble.confirm(req), aborted]);
            if (v === 'session' && req.key) app.sessionApprovals.add(req.key);
            return v !== 'deny';
          } finally {
            ctrl.signal.removeEventListener('abort', cancel);
          }
        },
        emit: app.turnEvents(turn, st, { bubble, speech, cards, doneSteps, model })
      });
      if (turn.background) {
        finishBackground(turn, { text: result.text, shown: st.shown, usedTools, files: madeFiles });
        return;
      }
      if (app.active !== turn) return;
      speech.flush();
      const total = now() - t0;
      // 回答底下写明用了谁：看图模型（主模型看不了图时）→ 回答的模型（按能力表换了的写上是哪一项）
      const seen = st.seenBy ? `看图 ${st.seenBy} → ` : '';
      const remote = st.serverRoute;
      const modelTag =
        app.server && !here
          ? `服务器 · ${seen}${remote ? `${st.fellFrom ? `${st.usedModel}（${remote.model} 出错后换用）` : `${remote.model}${remote.routed ? `（${TASKS[remote.task]?.name ?? remote.task}）` : ''}`} · ` : ''}`
          : here
            ? `本机工具 · ${st.usedModel} · `
            : providerById(app.llmConfig.provider)?.kind === 'mock'
              ? ''
              : st.usedModel !== model
                ? `${seen}${st.usedModel}（${model} 出错后换用） · `
                : `${seen}${model}${route.routed ? `（${TASKS[task].name}）` : ''} · `;
      bubble.done(
        `${modelTag}${team ? `团队 ${result.steps} 步 · ` : ''}${st.ctxMs !== null && st.ctxMs >= 300 ? `准备 ${(st.ctxMs / 1000).toFixed(1)}s · ` : ''}${st.firstToken ? `首字 ${((st.firstToken - t0) / 1000).toFixed(1)}s · ` : ''}耗时 ${(total / 1000).toFixed(1)}s${result.toolCalls ? ` · 工具 ${result.toolCalls} 次` : ''}${MOBILE && st.textChunks ? ` · 分 ${st.textChunks} 次收到${globalThis.__jarvisNetVia?.(app.llmConfig.baseURLs?.[app.llmConfig.provider] || '') === 'native' ? '（原生网络）' : ''}` : ''}`,
        {
          onFeedback: async (kind, comment) => {
            if (kind === 'up') await agentMemory.noteTask(`获得好评：${text.slice(0, 30)}`);
            else {
              await agentMemory.addLesson(`关于「${text.slice(0, 40)}」的回答，用户不满意：${comment || '未说明原因，下次先确认需求再回答'}`, text);
              toast('已记下这条教训，之后遇到类似问题会注意');
            }
            app.panels.refreshMind();
          }
        }
      );
      app.dashboard.setLatency(st.firstToken ? st.firstToken - t0 : null, total);
      app.hud.think(`✓ 完成 · ${(total / 1000).toFixed(1)}s${result.toolCalls ? ` · ${result.toolCalls} 个工具` : ''}`, 'ok');
      $('#hud-latency').textContent = st.firstToken ? `${Math.round(st.firstToken - t0)} ms` : '—';
      if (result.text)
        wp({
          say: result.text
            .replace(/```[\s\S]*?```/g, '')
            .replace(/[#*>`|]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 4000)
        });
      app.rememberTurn(
        'assistant',
        result.text || '（完成）',
        { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(madeFiles.size && { files: [...madeFiles].slice(-12) }) },
        turn.session
      );
      // 做完时人不在（App 在后台 / 窗口没在看）：发通知，点开就能看结果
      if (document.hidden)
        app.notify(
          '未央做完了',
          `${(turn.session.title || text).slice(0, 30)}：${stripEmotionTags(result.text || '')
            .replace(/\s+/g, ' ')
            .slice(0, 120)}`
        );
      // 在本机做的这一轮也记回服务器上的这段对话（手机上能看到）
      if (here)
        app.server
          .appendSession(
            turn.session.id,
            turn.session.messages.slice(-2).map(({ role, content, ts, tools }) => ({ role, content, ts, ...(tools && { tools }) }))
          )
          .catch((e) => toast(`这一轮没能记到服务器上：${e.message}`));
      $('#mode-pill').classList.remove('offline');
      turn.streamDone = true;
      app.callouts?.set(followUpSuggestions({ tools: usedTools, userText: text, desktop: Boolean(DESKTOP) }));
      app.scheduleReflect();
      app.compressHistory();
      if (!app.speaker.speaking) finishTurn();
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (turn.background) {
        finishBackground(turn, { error: app.friendlyError(err), shown: st.shown, usedTools, files: madeFiles });
        return;
      }
      if (app.active !== turn) return;
      const msg = app.friendlyError(err);
      const cors = !MOBILE && /Failed to fetch|NetworkError|Load failed|CORS/i.test(msg);
      bubble.append(
        `\n（出错了：${msg}${cors ? '。多半是该服务商不允许网页直接调用：双击 jarvis 文件夹里的 启动.bat（或 start.sh）并保持窗口开着，本页面会自动连上本机网关，然后重试即可' : ''}）`
      );
      if (cors && !app.gateway) app.detectGateway();
      bubble.done();
      bubble.activity('error');
      $('#mode-pill').classList.add('offline');
      app.active = null;
      app.setTask('error', '请求失败');
      app.hud.think(`✕ ${msg.slice(0, 40)}`, 'bad');
      // 已经写了一部分或做了几步：记进对话，点“继续”从断开的地方接着做，而不是从头再来
      const resumable = Boolean(st.shown.trim() || usedTools.length);
      if (resumable)
        app.rememberTurn(
          'assistant',
          `${st.shown.trim()}\n\n${interruptionMark(err)}`,
          { ...(usedTools.length && { tools: [...new Set(usedTools)] }), ...(madeFiles.size && { files: [...madeFiles].slice(-12) }) },
          turn.session
        );
      app.callouts?.set(followUpSuggestions({ error: true, resumable, userText: text, desktop: Boolean(DESKTOP) }));
    } finally {
      if (MOBILE) clearPending(storage, turn.session.id, turn.t0);
      await app.persistSession(turn.session);
      releaseTask();
      app.endControl();
      // 回答写完的一瞬间又收到的话（没来得及交给模型）：接着当一句新话处理
      const left = turn.inbox.splice(0);
      if (left.length && turn.remote) {
        app.prompt.value += (app.prompt.value.trim() ? '\n' : '') + left.join('\n');
        app.autosize();
        toast('未送达的补充已放回输入框，没有另开任务');
      } else if (left.length && !ctrl.signal.aborted && !turn.background && app.session === turn.session)
        setTimeout(() => send(left.join('\n'), { echo: false }), 0);
    }
  }

  return {
    send,
    interrupt,
    finishTurn,
    makeSpeech,
    interject,
    toBackground,
    finishBackground,
    taskKeeper,
    backgroundTurns,
    get turns() {
      return turns;
    }
  };
}
