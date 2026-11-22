import { noteTaskFile } from '../agent/taskFileReceipts.js';
/**
 * 服务器模式：接上服务器上正在做的任务（另一台设备发起的、或 App 重新打开时），把服务器生成的文件取回本机。
 */
import { runRemote } from '../core/serverClient.js';
import { mergeMarketSnapshots } from '../../shared/marketSnapshot.js';
import { serverConnectionText, serverObservationActions, serverTaskMayBeRunning } from '../core/serverConnection.js';
import { toolLabel } from '../ui/transcript.js';
import { isRetrievalStop } from '../../shared/retrievalStop.js';
import * as ws from '../agent/workspace.js';
import * as sessionsApi from '../agent/sessions.js';
import { now, toast } from './env.js';
import { posterArtifactId } from '../../shared/posterArtifactPath.js';
import { scopedState } from '../agent/store.js';

const fileIdentity = scopedState('files', () => ({}));

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
      queueScope: app.messageQueue?.scope(),
      files: new Set(),
      inbox: [],
      t0: now(),
      steps: 0,
      status: '',
      background: false,
      remote: Boolean(app.server)
    };
    app.active = turn;
    app.studioActivity?.begin(turn, { resume: true });
    app.liveBubble = bubble;
    app.setTask('processing', '服务器上正在做');
    const cards = new Map();
    let failed = false;
    let elapsedMs;
    try {
      const result = await runRemote(app.server, {
        taskId: s.taskId,
        onStarted: (task) => {
          turn.remoteId = task.id;
        },
        signal: ctrl.signal,
        onFile: (p, version) => pullServerFile(p, turn, version),
        emit: (e) => {
          if (turn.streamDone || ctrl.signal.aborted) return;
          app.studioActivity?.record(turn, e);
          if (e.type === 'server_connection') {
            const message = serverConnectionText(e);
            turn.status = message;
            if (app.active === turn) app.setTask('processing', message);
            bubble.status?.(message);
          } else if (e.type === 'text') bubble.append(e.delta);
          else if (e.type === 'sports_scores') bubble.sports?.(e.value);
          else if (e.type === 'market_quote') {
            turn.markets = mergeMarketSnapshots(turn.markets, e.value);
            bubble.marketCards?.(turn.markets);
          } else if (e.type === 'plan') bubble.plan?.(e.steps);
          else if (e.type === 'tool_start' && e.name !== 'update_plan') {
            cards.set(e.id, bubble.toolCard(e.name, e.args));
            turn.steps++;
            turn.status = toolLabel(e.name);
            if (app.active === turn) app.setTask('processing', turn.status);
          } else if (e.type === 'tool_progress') cards.get(e.id)?.progress(e.text);
          else if (e.type === 'tool_end') {
            app.panels?.onWorkspaceToolEnd?.(e);
            if (isRetrievalStop(e)) {
              const card = cards.get(e.id);
              if (card) {
                card.omit?.();
                cards.delete(e.id);
                turn.steps = Math.max(0, turn.steps - 1);
              }
            } else cards.get(e.id)?.done(e.ok, e.output, e.ms);
          }
        }
      });
      turn.completedAt = result.completedAt ?? Date.now();
      elapsedMs = result.timing?.totalMs;
      bubble.setTimestamp?.(turn.completedAt);
      app.studioActivity?.finish(turn, 'done');
    } catch (e) {
      turn.completedAt = e.completedAt ?? Date.now();
      bubble.setTimestamp?.(turn.completedAt);
      app.studioActivity?.finish(turn, e.name === 'AbortError' ? 'stopped' : serverTaskMayBeRunning(e) ? 'waiting' : 'error');
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
      bubble.done(undefined, { elapsedMs });
      if (app.active === turn) {
        app.active = null;
        app.setTask(failed ? 'error' : 'idle', failed ? '请求失败' : undefined);
      }
    }
    // 观察失败不代表任务结束；保留提示和已收到的内容，避免旧历史覆盖它。
    if (failed) {
      app.messageQueue?.finished(turn, false);
      return;
    }
    // 换成服务器上记下的完整对话（回答、用到的工具、生成的文件）
    const fresh = await sessionsApi.get(s.id).catch(() => null);
    if (fresh && app.session.id === s.id && !app.active) {
      app.session = fresh;
      app.replayTranscript();
    }
    app.messageQueue?.finished(turn, !ctrl.signal.aborted);
  }

  /** 服务器模式：服务器上生成了文件，下载到本机工作区，照常预览、保存 */
  async function pullServerFile(path, turn, version) {
    turn ??= { files: new Set(), bubble: app.liveBubble };
    if (version?.path === path) noteTaskFile(turn, version);
    if (turn?.files.has(path)) return; // 同一轮里同一个文件只取一次（画图会同时报“新文件”和“显示图片”）
    const client = app.server;
    const owner = fileIdentity();
    const current = () => app.server === client && owner === fileIdentity() && !turn.ctrl?.signal.aborted;
    if (!client) return;
    app.studioActivity?.record(turn, { type: 'file', path });
    turn.pendingFiles ??= new Map();
    if (turn.pendingFiles.has(path)) return turn.pendingFiles.get(path);
    // 最多32件在途；未启动的文件不登记完成，之后可从服务器文件空间打开或再次通知重取。
    if (turn.pendingFiles.size >= 32) {
      if (!turn.fileQueueNotified && current()) toast('文件仍在取回，其余文件可稍后在文件空间打开');
      turn.fileQueueNotified = true;
      return;
    }
    const pull = async () => {
      try {
        const blob = await client.download(path);
        if (!current()) return;
        const saved = await ws.write(path, blob);
        if (!current()) return;
        const actual = saved.path;
        turn?.files.add(path);
        turn?.files.add(actual);
        app.panels.markFresh(actual);
        app.panels.refreshFiles();
        const out = turn?.bubble ?? app.liveBubble;
        // 本机文件夹可能把缓存另存为“(2)”，云端工作区仍按服务器原路径打开。
        const presented = app.panels.workspaceMode?.() === 'server' ? path : actual;
        // 服务器画的图、做的视频：和本机一样直接显示在回答里
        if (/^images\/.+\.(png|jpe?g|webp|gif)$/i.test(presented) || posterArtifactId(presented)) out?.image?.(URL.createObjectURL(blob), undefined, presented);
        else if (/^videos\/.+\.(mp4|webm|mov)$/i.test(path)) out?.video?.(URL.createObjectURL(blob));
        if (!/^skills\//.test(path)) {
          out?.fileLink?.(presented, app.openInWorkspace);
        }
      } catch (e) {
        turn?.files.delete(path);
        if (current()) toast('文件暂未取回，可重新打开下载：' + e.message);
      }
    };
    const pending = pull().finally(() => turn.pendingFiles.delete(path));
    turn.pendingFiles.set(path, pending);
    return pending;
  }

  return { followServerTask, pullServerFile };
}
