/**
 * 对话管理：当前对话、记消息、重画对话区（手机上分页）、切换 / 新建 / 打开对话、从服务器刷新进度、
 * 导出对话、编辑重发 / 重新生成、标题。
 */
import { MOBILE } from '../config.js';
import { Transcript, toolLabel, copyText } from '../ui/transcript.js';
import { transcriptWindow } from '../mobile/transcriptWindow.js';
import { noteAction } from '../mobile/renderDiagnostics.js';
import { openingSuggestions, followUpSuggestions } from '../core/suggest.js';
import { toPlainText } from '../core/markdown.js';
import { stripEmotionTags } from '../../shared/emotionTag.js';
import * as ws from '../agent/workspace.js';
import * as agentMemory from '../agent/memory.js';
import * as sessionsApi from '../agent/sessions.js';
import { $, DESKTOP, COMPACT, toast } from './env.js';
import { sportsCardRefresh } from './sportsCards.js';

export function createConversations(app) {
  const transcript = new Transcript($('#transcript'), { progress: COMPACT, refreshSports: sportsCardRefresh(app) });
  // 当前会话；app.history 就是它的消息列表（换对话只改 app.session）
  app.session = sessionsApi.create();
  /** 记一条消息：默认记进当前会话；后台任务记进它自己的会话（切到别的对话后仍然记对地方） */
  function rememberTurn(role, content, extra = {}, target = app.session) {
    // 回的是主动问候里“要接着做吗”，而且说了不用：把那件事划掉（往前看几条：隔了一两句再抱怨“为啥一直问”也算）
    const asked = target.messages
      .slice(-6)
      .reverse()
      .find((m) => m.role === 'assistant' && m.proactive && m.openItem);
    if (role === 'user' && asked && agentMemory.DECLINE_OPEN.test(String(content).trim())) agentMemory.resolveOpen([asked.openItem]).catch(() => {});
    target.messages.push({ role, content, ts: Date.now(), ...extra });
    target.updatedAt = Date.now();
    persistSession(target);
  }
  function persistSession(target = app.session) {
    if (app.settings.saveSessions === false) return;
    return sessionsApi
      .save(target)
      .then(() => {
        app.sessionsPanel?.refresh();
        if (target === app.session) showChatTitle();
      })
      .catch(() => {});
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
    try {
      next = globalThis.prompt('给这段对话起个名字', now);
    } catch {
      /* 不支持弹窗 */
    }
    next = String(next ?? '')
      .trim()
      .slice(0, 60);
    if (!next || next === now) return;
    app.session.title = next;
    app.session.titleSet = true;
    await sessionsApi.rename(app.session.id, next).catch(() => {});
    showChatTitle();
    app.sessionsPanel?.refresh();
    app.drawer?.refresh?.();
  });

  // ---------------------------------------------------------------- 多会话
  /** 把当前会话的消息重新画到对话区 */
  let historyViewEnd = null;
  function visibleHistory(end = app.history.length) {
    return transcriptWindow(app.history.length, { mobile: MOBILE, safe: document.documentElement.classList.contains('safe-render'), end });
  }
  function replayTranscript(end = app.history.length, { fromTop = false } = {}) {
    showChatTitle();
    const root = $('#transcript'),
      range = visibleHistory(end);
    historyViewEnd = range.newer ? range.end : null;
    root.replaceChildren();
    transcript.follow = true;
    document.body.classList.remove('wy-reading-history');
    if (!app.history.length) {
      app.renderWelcome();
      return;
    }
    const pageNav = (buttons) => {
      const nav = Object.assign(document.createElement('nav'), { className: 'wy-history-pages' });
      nav.setAttribute('aria-label', '对话翻页');
      for (const [label, target, top] of buttons) {
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
        button.onclick = () => {
          if (app.active) {
            toast('当前回复完成后，可以翻看更早的对话');
            return;
          }
          replayTranscript(target, { fromTop: top });
        };
        nav.append(button);
      }
      return nav;
    };
    const latest = ['回到最近对话', app.history.length, false];
    transcript.batch(() => {
      if (range.older || range.newer) {
        const buttons = [];
        if (range.older) buttons.push([`查看更早的对话（还有 ${range.older} 条）`, range.start, false]);
        if (range.newer) buttons.push(['下一页', Math.min(app.history.length, range.end + range.limit), true], latest);
        root.append(pageNav(buttons));
      }
      // 翻看旧消息：很长的回答（除了最后一条）先只显示开头，点“展开全文”再显示，手机上少画很多内容
      const shown = app.history.slice(range.start, range.end);
      const lastAgent = shown.findLastIndex((m) => m.role !== 'user');
      shown.forEach((m, i) => {
        if (m.role === 'user') transcript.add('user', m.content, m.ts, { thumbs: m.thumbs });
        else {
          const b = transcript.add('agent', '', m.ts);
          b.append(m.content);
          if (m.sports) b.sports(m.sports);
          for (const f of m.files || []) b.fileLink(f, openInWorkspace);
          b.done(m.tools?.length ? `用了：${m.tools.map(toolLabel).join('、')}` : '', { fold: i !== lastAgent });
        }
      });
      // 翻到旧的一页时，底部也要能接着往后看：以前按钮只在顶上，滑到底就“卡住”了
      if (range.newer) root.append(pageNav([[`继续往后看（还有 ${range.newer} 条）`, Math.min(app.history.length, range.end + range.limit), true], latest]));
    });
    // 往后翻：从这一页开头接着读
    if (fromTop) root.scrollTop = 0;
  }
  /** 新对话的开场建议：之前没做完的事 > 上一段对话 */
  async function resumeSuggestion() {
    try {
      const [open] = await agentMemory.openItems({ exclude: app.session.id, k: 1 });
      if (open) return { title: `继续：${open.text.slice(0, 18)}`, prompt: `接着之前说的：${open.text}` };
      const [last] = await sessionsApi.recent({ exclude: app.session.id, k: 1 });
      if (last && Date.now() - last.updatedAt < 3 * 86400000)
        return { title: `接着上次：${last.title.slice(0, 16)}`, prompt: `接着上次「${last.title}」的对话继续` };
    } catch {
      /* 没有历史 */
    }
    return null;
  }
  async function openingCallouts(hasSkills = true) {
    app.callouts?.set(openingSuggestions({ desktop: Boolean(DESKTOP), hasSkills, resume: await resumeSuggestion() }));
  }

  async function switchTo(next) {
    // 正在干活：不停下，转到后台接着做（做完记回原来的对话）；只是在朗读就停掉
    if (app.active && !app.active.streamDone) app.toBackground(app.active);
    else app.interrupt();
    if (app.settings.autoMemory) await app.reflectNow();
    app.session = next;
    app.reflectFrom = app.history.length;
    replayTranscript();
    // 切回一个还在后台干活的对话：把正在写的那条回答接回来
    const bg = [...app.backgroundTurns].find((t) => t.session.id === app.session.id);
    if (bg) {
      app.backgroundTurns.delete(bg);
      bg.background = false;
      app.active = bg;
      app.liveBubble = bg.bubble;
      transcript.root.append(bg.bubble.el);
      app.setTask('processing', bg.status || '思考中');
    } else if (app.server && next.taskId) app.followServerTask(next); // 服务器上这个对话还在干活（比如 App 重新打开）：接上它的进度
    app.dashboard.setTurns(app.history.filter((m) => m.role === 'user').length);
    if (app.history.length)
      app.callouts?.set(
        followUpSuggestions({
          tools: app.history.at(-1)?.tools ?? [],
          userText: [...app.history].reverse().find((m) => m.role === 'user')?.content ?? '',
          desktop: Boolean(DESKTOP)
        })
      );
    else openingCallouts();
    app.sessionsPanel?.refresh();
    app.setTask('idle');
  }
  function newSession() {
    if (!app.history.length) {
      $('#prompt').focus();
      return;
    }
    switchTo(sessionsApi.create());
    $('#prompt').focus();
  }
  addEventListener('jarvis:open-session', (e) => {
    openSession(e.detail).then(() => app.showPanel('sessions'));
  });
  /** 手机：第一次交任务时问一次能不能发“做完了”的通知（之后不再问） */
  let askedNotify = false;
  function askNotifyOnce() {
    if (!MOBILE || askedNotify) return;
    askedNotify = true;
    try {
      if (localStorage.getItem('jarvis.askedNotify')) return;
      localStorage.setItem('jarvis.askedNotify', '1');
    } catch {
      /* 存不了也只问这一次 */
    }
    globalThis.__jarvisBackgroundTask?.askNotify?.().catch(() => {});
  }
  let opening = 0; // 连点了好几段对话：只认最后点的那段
  async function openSession(id) {
    noteAction('切换对话');
    // 点的就是当前对话：服务器模式下从服务器取一次最新进度（另一台设备可能接着聊过）
    if (id === app.session.id) {
      if (app.server) refreshFromServer();
      return;
    }
    const mine = ++opening;
    // 服务器模式：先用手机 / 电脑上留的副本马上切过去，再从服务器取最新的换上
    const cached = app.server ? sessionsApi.cachedGet(id) : null;
    if (cached) await switchTo(cached);
    else if (app.server) app.setTask('processing', '正在打开对话');
    const s = await sessionsApi.get(id).catch((e) => {
      if (!cached) toast(`打不开这段对话：${e.message}`);
      return null;
    });
    if (mine !== opening) return;
    if (!s) {
      if (!cached) app.setTask('idle');
      return;
    }
    if (!cached) await switchTo(s);
    else if (app.session.id === id && !app.active && changed(app.session, s)) {
      app.session = s;
      app.reflectFrom = app.history.length;
      replayTranscript();
    }
    if (app.server && app.session.id === id && s.taskId && !app.active) app.followServerTask(s); // 另一台设备正在做：接上进度
  }
  /** 服务器上的这段对话比手上的新吗（另一台设备接着聊过、或者做完了任务） */
  const changed = (a, b) =>
    b.messages.length !== a.messages.length || (b.updatedAt ?? 0) > (a.updatedAt ?? 0) || b.messages.at(-1)?.content !== a.messages.at(-1)?.content;
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
      if (changed(app.session, s)) {
        app.session = s;
        app.reflectFrom = app.history.length;
        replayTranscript();
      }
      if (s.taskId) app.followServerTask(s);
      try {
        app.drawer?.refresh?.();
      } catch {
        /* 抽屉还没建好 */
      }
    } finally {
      refreshing = false;
    }
  }
  // App 从后台切回来 / 电脑窗口重新获得焦点：拉一次最新进度（两台设备轮着用时不会对不上）
  let lastPull = 0;
  const pullSoon = () => {
    if (Date.now() - lastPull < 3000) return;
    lastPull = Date.now();
    refreshFromServer();
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pullSoon();
  });
  addEventListener('focus', pullSoon);

  /** 对话里点生成的文件：切到工作区并打开它 */
  /** 导出一段对话：复制全部内容，或存成 Word / Markdown 放进工作区“导出”文件夹（在工作区里能下载、分享） */
  async function exportSession(id, kind) {
    const s = id === app.session.id ? app.session : ((await sessionsApi.get(id).catch(() => null)) ?? sessionsApi.cachedGet(id));
    if (!s?.messages?.length) {
      toast('这段对话还没有内容');
      return;
    }
    const title = s.title || '对话';
    const said = (m) =>
      stripEmotionTags(String(m.content))
        .replace(/\n*\[已上传到工作区：[^\]]+\]$/, '')
        .trim();
    const when = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '');
    const md = `# ${title}\n\n${s.messages.map((m) => `### ${m.role === 'user' ? '我' : '未央'}${m.ts ? `　${when(m.ts)}` : ''}\n\n${said(m)}`).join('\n\n')}\n`;
    if (kind === 'copy') {
      toast((await copyText(toPlainText(md))) ? '整段对话已复制' : '复制失败');
      return;
    }
    const name = title.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || '对话';
    try {
      let path;
      if (kind === 'md') path = (await ws.write(`导出/${name}.md`, md)).path;
      else {
        const { generate } = await import('../agent/docs.js');
        const out = await generate('docx', { title, content: md.replace(/^# .*\n/, '') });
        path = (await ws.write(`导出/${name}.${out.ext}`, out.blob)).path;
      }
      app.panels.refreshFiles();
      toast(`已导出到工作区：${path}`);
      openInWorkspace(path);
    } catch (e) {
      toast(`导出没成功：${e.message}`);
    }
  }
  function openInWorkspace(path) {
    app.showPanel('workspace');
    app.panels.openFile(path);
  }

  // ---------------------------------------------------------------- 编辑重发 / 重新生成
  /**
   * 回到某句话之前重新来：
   *   edit  把你的这句话放回输入框，改好再发（这句话和它后面的都去掉）
   *   retry 去掉这条回答（和它后面的），把它前面那句话重新发一次
   */
  async function rewindAndResend(kind, text) {
    if (app.active) {
      toast('等这一轮做完再改');
      return;
    }
    const said = (m) =>
      String(m.content)
        .replace(/\n*\[已上传到工作区：[^\]]+\]$/, '')
        .trim();
    let at = -1;
    if (kind === 'edit') at = app.history.findLastIndex((m) => m.role === 'user' && said(m) === text.trim());
    else {
      const reply = app.history.findLastIndex((m) => m.role === 'assistant' && stripEmotionTags(m.content).trim() === text.trim());
      if (reply > 0)
        for (let i = reply - 1; i >= 0; i--)
          if (app.history[i].role === 'user') {
            at = i;
            break;
          }
    }
    if (at < 0) {
      toast('找不到这条消息（可能已经翻页或改过）');
      return;
    }
    const later = app.history.length - at - 1;
    let ok = true;
    if (later > 1) {
      try {
        ok = globalThis.confirm(`这句话后面还有 ${later} 条消息，会一起去掉。继续吗？`);
      } catch {
        /* 不支持弹窗就直接继续 */
      }
    }
    if (!ok) return;
    const question = said(app.history[at]);
    if (app.server) {
      try {
        await app.server.truncateSession(app.session.id, at);
      } catch (e) {
        toast(`没改成：${e.message}`);
        return;
      }
    }
    app.history.splice(at);
    app.session.updatedAt = Date.now();
    // 本机模式下截成空的：空对话不会存盘，旧记录会留着；先删掉，重新发的时候再存
    if (!app.server && !app.history.length) sessionsApi.remove(app.session.id).catch(() => {});
    else persistSession();
    replayTranscript();
    if (kind === 'edit') {
      app.prompt.value = question;
      app.autosize();
      app.prompt.focus();
      toast('改好后点发送');
    } else app.send(question);
  }

  return {
    transcript,
    rememberTurn,
    persistSession,
    showChatTitle,
    visibleHistory,
    replayTranscript,
    openingCallouts,
    switchTo,
    newSession,
    askNotifyOnce,
    openSession,
    refreshFromServer,
    exportSession,
    openInWorkspace,
    rewindAndResend,
    get historyViewEnd() {
      return historyViewEnd;
    }
  };
}
