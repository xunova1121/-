import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoteTask } from '../src/app/remoteTask.js';

const mocks = vi.hoisted(() => ({ runRemote: vi.fn(), getSession: vi.fn(), toast: vi.fn() }));
vi.mock('../src/core/serverClient.js', () => ({ runRemote: mocks.runRemote }));
vi.mock('../src/agent/sessions.js', () => ({ get: mocks.getSession }));
vi.mock('../src/agent/workspace.js', () => ({}));
vi.mock('../src/ui/transcript.js', () => ({ toolLabel: name => name }));
vi.mock('../src/app/env.js', () => ({ now: () => 0, toast: mocks.toast }));

const lost = () => Object.assign(new Error('任务已提交，服务器可能继续运行，请打开原对话'), { code: 'TASK_OBSERVATION_LOST' });
function fixture() {
  const session = { id: 'original', taskId: 'original-task' };
  const bubble = { el: { classList: { add: vi.fn() } }, append: vi.fn(), status: vi.fn(), done: vi.fn() };
  const app = {
    session, server: {}, active: null, backgroundTurns: new Set(),
    transcript: { add: vi.fn(() => bubble) }, setTask: vi.fn(), replayTranscript: vi.fn(),
    friendlyError: error => error.message
  };
  return { session, app, bubble, remote: createRemoteTask(app) };
}
beforeEach(() => { vi.clearAllMocks(); mocks.runRemote.mockReset(); mocks.getSession.mockReset().mockResolvedValue(null); });

describe('重新接上服务器任务时的观察故障', () => {
  it('状态机重绘活动文案后仍保留明确的断线提示', async () => {
    const { session, app, bubble, remote } = fixture();
    let finish, emit;
    mocks.runRemote.mockImplementation((_client, options) => {
      emit = options.emit;
      return new Promise(resolve => { finish = resolve; });
    });
    app.setTask.mockImplementation(() => bubble.status('思考中'));
    const pending = remote.followServerTask(session);
    try {
      emit({ type: 'server_connection', state: 'reconnecting' });
      expect(bubble.status).toHaveBeenLastCalledWith('回答连接中断，正在重连原任务…');
      emit({ type: 'server_connection', state: 'connected' });
      expect(bubble.status).toHaveBeenLastCalledWith('连接已恢复，继续接收原任务回答');
    } finally { finish({ text: '完成' }); await pending; }
  });

  it('当前对话观察失败保留明确提示，不用服务器旧历史覆盖', async () => {
    const { session, app, bubble, remote } = fixture();
    let turn;
    mocks.runRemote.mockImplementation(async () => { turn = app.active; throw lost(); });
    mocks.getSession.mockResolvedValue({ ...session, messages: [] });
    await remote.followServerTask(session);
    expect(bubble.append).toHaveBeenCalledWith(expect.stringContaining('任务已提交'));
    expect(bubble.done).toHaveBeenCalledTimes(1);
    expect(turn.streamDone).toBe(true);
    expect(app.active).toBeNull();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(app.replayTranscript).not.toHaveBeenCalled();
  });

  it('切走后只更新原任务气泡，后台失败清理记录且不污染当前会话', async () => {
    const { session, app, bubble, remote } = fixture();
    let rejectRun, emit;
    mocks.runRemote.mockImplementation((_client, options) => {
      emit = options.emit;
      return new Promise((_resolve, reject) => { rejectRun = reject; });
    });
    const pending = remote.followServerTask(session);
    const turn = app.active;
    turn.background = true;
    app.backgroundTurns.add(turn);
    const current = { id: 'current-turn' };
    app.active = current;
    app.session = { id: 'other-conversation' };
    app.setTask.mockClear();
    emit({ type: 'server_connection', state: 'reconnecting' });
    emit({ type: 'text', delta: '原任务收到的半句' });
    expect(bubble.status).toHaveBeenCalledWith('回答连接中断，正在重连原任务…');
    expect(bubble.append).toHaveBeenCalledWith('原任务收到的半句');
    rejectRun(lost());
    await pending;
    expect(turn.streamDone).toBe(true);
    expect(app.backgroundTurns.has(turn)).toBe(false);
    expect(bubble.append).toHaveBeenLastCalledWith(expect.stringContaining('任务已提交'));
    expect(app.active).toBe(current);
    expect(app.session.id).toBe('other-conversation');
    expect(app.setTask).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(app.replayTranscript).not.toHaveBeenCalled();
    bubble.status.mockClear();
    emit({ type: 'server_connection', state: 'connected' });
    expect(bubble.status).not.toHaveBeenCalled();
  });

  it('正常完成仍刷新原会话，并结束观察记录', async () => {
    const { session, app, bubble, remote } = fixture();
    let turn;
    mocks.runRemote.mockImplementation(async () => { turn = app.active; return { text: '完成' }; });
    const fresh = { id: session.id, taskId: null, messages: [{ role: 'assistant', content: '完成' }] };
    mocks.getSession.mockResolvedValue(fresh);
    await remote.followServerTask(session);
    expect(app.session).toBe(fresh);
    expect(app.replayTranscript).toHaveBeenCalledTimes(1);
    expect(turn.streamDone).toBe(true);
    expect(bubble.done).toHaveBeenCalledTimes(1);
  });

  it('后台正常完成也清除旧观察，不改变当前任务', async () => {
    const { session, app, remote } = fixture();
    let finish;
    mocks.runRemote.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = remote.followServerTask(session);
    const turn = app.active;
    turn.background = true;
    app.backgroundTurns.add(turn);
    const current = { id: 'current-turn' };
    app.active = current;
    app.session = { id: 'other' };
    app.setTask.mockClear();
    mocks.getSession.mockResolvedValue({ id: session.id, messages: [] });
    finish({ text: '完成' });
    await pending;
    expect(turn.streamDone).toBe(true);
    expect(app.backgroundTurns.has(turn)).toBe(false);
    expect(app.active).toBe(current);
    expect(app.setTask).not.toHaveBeenCalled();
    expect(app.replayTranscript).not.toHaveBeenCalled();
  });
});
