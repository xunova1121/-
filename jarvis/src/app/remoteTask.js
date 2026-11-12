/**
 * 服务器模式：接上服务器上正在做的任务（另一台设备发起的、或 App 重新打开时），把服务器生成的文件取回本机。
 */
import { runRemote } from '../core/serverClient.js';
import { serverConnectionText, serverObservationActions } from '../core/serverConnection.js';
import { toolLabel } from '../ui/transcript.js';
import * as ws from '../agent/workspace.js';
import * as sessionsApi from '../agent/sessions.js';
import { now, toast } from './env.js';

export function createRemoteTask(app) {
  /** 服务器模式：打开一个服务器上还在干活的对话，从头补上它的进度，做完后换成服务器记下的完整对话 */
  async function followServerTask(s) {
    const ctrl = new AbortController();
    const bubble = app.transcript.add('agent');
    bubble.el.classList.add('streaming');
    const turn = {
      ctrl,
      streamDone: false,
      bubble,
      session: s,
      files: new Set(),
      inbox: [],
      t0: now(),
      steps: 0,
      status: '',
      background: false,
      remote: Boolean(app.server)
    };
    app.active = turn;
    app.liveBubble = bubble;
    app.setTask('processing', '服务器上正在做');
    const cards = new Map();
    let failed = false;
    try {
      await runRemote(app.server, {
        taskId: s.taskId,
        onStarted: (task) => {
          turn.remoteId = task.id;
        },
        signal: ctrl.signal,
        onFile: (p) => pullServerFile(p, turn),
        emit: (e) => {
          if (turn.streamDone || ctrl.signal.aborted) return;
          if (e.type === 'server_connection') {
            const message = serverConnectionText(e);
            turn.status = message;
            if (app.active === turn) app.setTask('processing', message);
            bubble.status?.(message);
          } else if (e.type === 'text') bubble.append(e.delta);
          else if (e.type === 'sports_scores') bubble.sports?.(e.value);
          else if (e.type === 'plan') bubble.plan?.(e.steps);
          else if (e.type === 'tool_start' && e.name !== 'update_plan') {
            cards.set(e.id, bubble.toolCard(e.name, e.args));
            turn.steps++;
            turn.status = toolLabel(e.name);
            if (app.active === turn) app.setTask('processing', turn.status);
          } else if (e.type === 'tool_progress') cards.get(e.id)?.progress(e.text);
          else if (e.type === 'tool_end') cards.get(e.id)?.done(e.ok, e.output, e.ms);
        }
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        failed = true;
        const message = app.friendlyError(e);
        bubble.append(`\n（${message}）`);
        if (app.active === turn) {
          toast(message);
          if (e.code === 'TASK_OBSERVATION_LOST') app.callouts?.set(serverObservationActions());
        }
      }
    } finally {
      turn.streamDone = true;
      app.backgroundTurns?.delete(turn);
      bubble.done();
      if (app.active === turn) {
        app.active = null;
        app.setTask(failed ? 'error' : 'idle', failed ? '请求失败' : undefined);
      }
    }
    // 观察失败不代表任务结束；保留提示和已收到的内容，避免旧历史覆盖它。
    if (failed) return;
    // 换成服务器上记下的完整对话（回答、用到的工具、生成的文件）
    const fresh = await sessionsApi.get(s.id).catch(() => null);
    if (fresh && app.session.id === s.id && !app.active) {
      app.session = fresh;
      app.replayTranscript();
    }
  }

  /** 服务器模式：服务器上生成了文件，下载到本机工作区，照常预览、保存 */
  async function pullServerFile(path, turn) {
    if (turn?.files.has(path)) return; // 同一轮里同一个文件只取一次（画图会同时报“新文件”和“显示图片”）
    turn?.files.add(path);
    try {
      const blob = await app.server.download(path);
      await ws.write(path, blob);
      app.panels.markFresh(path);
      app.panels.refreshFiles();
      const out = turn?.bubble ?? app.liveBubble;
      // 服务器画的图、做的视频：和本机一样直接显示在回答里
      if (/^images\/.+\.(png|jpe?g|webp|gif)$/i.test(path)) out?.image?.(URL.createObjectURL(blob));
      else if (/^videos\/.+\.(mp4|webm|mov)$/i.test(path)) out?.video?.(URL.createObjectURL(blob));
      if (!/^skills\//.test(path)) {
        out?.fileLink?.(path, app.openInWorkspace);
        turn?.files.add(path);
      }
    } catch (e) {
      toast(e.message);
    }
  }

  return { followServerTask, pullServerFile };
}
