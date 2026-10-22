/** 一轮事件转换为原气泡、进度和状态；后台任务仍只更新自身气泡。 */
import { MOBILE } from '../config.js';
import { savePending } from '../core/pendingTask.js';
import { toolLabel, summarizeArgs, searchBrand } from '../ui/transcript.js';
import { now, storage, toast, markActivity } from './env.js';

export function createTurnEvents(app) {
  /** 这一轮的进度事件 → 界面：文字、工具卡片、模型切换、团队分工……（切到别的对话后只记进这一轮的气泡） */
  function turnEvents(turn, st, { bubble, speech, cards, doneSteps, model }) {
    return (e) => {
      if (e.type === 'tool_start' && e.name !== 'update_plan') {
        turn.steps++;
        turn.status = toolLabel(e.name);
      } else if (e.type === 'tool_progress') turn.status = e.text;
      else if (e.type === 'text') turn.status = '写回答';
      if (turn.background) {
        // 切到别的对话了：只把内容记在这一轮的气泡里（切回来时接上），不朗读、不改界面状态
        if (e.type === 'text') {
          bubble.append(e.delta);
          st.shown += e.delta;
          turn.shown = st.shown;
        } else if (e.type === 'tool_start' && e.name !== 'update_plan') {
          cards.set(e.id, bubble.toolCard(e.name, e.args));
          st.usedTools.push(e.name);
        } else if (e.type === 'tool_progress') cards.get(e.id)?.progress(e.text);
        else if (e.type === 'tool_end') cards.get(e.id)?.done(e.ok, e.output, e.ms);
        else if (e.type === 'plan') bubble.plan?.(e.steps);
        return;
      }
      if (app.active !== turn) return;
      if (e.type === 'text') {
        if (app.callActive && app.callTiming?.recognizedAt && !app.callTiming.firstTextAt) app.callTiming.firstTextAt = now();
        if (!st.firstToken) {
          st.firstToken = now();
          app.hud.think('生成回答');
        }
        if (!st.outMarked) {
          st.outMarked = true;
          markActivity(`正在输出回答${st.shown.length ? `（已 ${st.shown.length} 字）` : ''}`);
        }
        if (st.serverCard) {
          st.serverCard.done(true, '由模型服务端完成', Math.round(now() - st.serverCard.t0));
          st.serverCard = null;
        }
        bubble.append(e.delta);
        st.shown += e.delta;
        st.textChunks++;
        app.machine.feedResponseText(e.delta);
        speech.push(e.delta);
      } else if (e.type === 'interjection_accepted') {
        speech.resume();
        bubble.status?.('已收到补充，正在调整…');
        if (app.callActive) app.callStatus('已收到，正在按补充要求处理…');
      } else if (e.type === 'fallback') {
        st.usedModel = e.to;
        st.fellFrom = st.fellFrom || e.from;
        const note = `${e.from} 出错（${e.reason}），已换成 ${e.to} 接着做`;
        app.hud.think(`⇄ ${note}`, 'sub');
        toast(note);
        app.setTask('processing', `已换成 ${e.to}`.slice(0, 30));
      } else if (e.type === 'retry') {
        const note = e.resume ? `网络中断，第 ${e.attempt} 次重连，接着刚才的地方写` : `连接出错，第 ${e.attempt} 次自动重试`;
        app.hud.think(`↻ ${note}`, 'sub');
        app.setTask('processing', note.slice(0, 30));
      } else if (e.type === 'tier') {
        st.tier = { asked: e.asked, sent: e.sent, served: e.served };
      } else if (e.type === 'route') {
        // 服务器模式：服务器告诉我们这句话交给了谁
        st.serverRoute = { model: e.model, task: e.task, routed: e.routed };
      } else if (e.type === 'seeing') {
        st.seenBy = e.model;
        bubble.status?.(e.text);
        app.setTask('processing', '正在看图');
      } else if (e.type === 'emotion') {
        app.machine.setStreamHint(e.value);
        app.director.onEmotion(e.value);
        bubble.mood?.(e.value);
      } else if (e.type === 'state' && e.value !== 'done') app.setTask(e.value, e.value === 'listening' ? '生成回答' : '');
      else if (e.type === 'plan')
        bubble.plan?.(e.steps); // 任务清单：卡片里实时打勾
      else if ((e.type === 'tool_start' || e.type === 'tool_end') && e.name === 'update_plan') {
        /* 更新清单本身不单独占一张工具卡片 */
      } else if (e.type === 'tool_start') {
        app.director.onToolStart(e.name);
        app.hud.toolStart(e.id, toolLabel(e.name));
        app.hud.think(`▸ ${toolLabel(e.name)}  ${summarizeArgs(e.name, e.args)}`);
        cards.set(e.id, bubble.toolCard(e.name, e.args));
        st.usedTools.push(e.name);
        bubble.status?.(`正在${toolLabel(e.name)}…`);
        app.setTask('processing', toolLabel(e.name));
        markActivity(`${toolLabel(e.name)} ${summarizeArgs(e.name, e.args)}`.slice(0, 80));
        st.outMarked = false;
      } else if (e.type === 'tool_progress') {
        cards.get(e.id)?.progress(e.text);
        app.hud.think(`  ${e.text}`, 'sub');
        app.setTask('processing', e.text.slice(0, 30));
      } else if (e.type === 'tool_end') {
        cards.get(e.id)?.done(e.ok, e.output, e.ms);
        app.hud.toolEnd(e.id, e.ok);
        if (MOBILE && !turn.remote) {
          if (e.ok) doneSteps.push(toolLabel(e.name));
          savePending(storage, turn.session.id, { ts: Date.now(), steps: doneSteps, files: [...turn.files] });
        }
        if (!e.ok) app.hud.think(`✕ ${toolLabel(e.name)} 失败`, 'bad');
        if (/remember|forget|save_skill/.test(e.name)) app.panels.refreshMind();
      } else if (e.type === 'server_tool') {
        st.serverCard = Object.assign(bubble.toolCard('web_search', { query: `${searchBrand(model)}自带联网搜索` }), { t0: now() });
      } else if (e.type === 'sources') bubble.sources(e.items);
      else if (e.type === 'timing') st.ctxMs = e.contextMs;
      else if (e.type === 'team_plan') {
        app.hud.think(`团队分工 · ${e.steps.map((x) => x.roleName).join(' → ')}`);
        st.teamCard = bubble.teamCard(e.steps);
        app.setTask('processing', `团队分工 · ${e.steps.length} 步`);
      } else if (e.type === 'team_step') {
        st.teamCard?.step(e.index, e.status, e.note);
        if (e.status === 'running' || e.status === 'redo') app.setTask('processing', `第 ${e.index + 1} 步${e.status === 'redo' ? ' · 返工' : ''}`);
      } else if (e.type === 'team_review') {
        st.teamCard?.review(e);
        app.setTask('processing', e.pass ? '审核通过，汇总中' : '审核发现问题');
      }
    };
  }

  return { turnEvents };
}
