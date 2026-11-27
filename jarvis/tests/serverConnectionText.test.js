import { describe, it, expect, vi } from 'vitest';
import { friendlyError } from '../src/core/friendlyError.js';
import { createServerClient } from '../src/core/serverClient.js';
import { createPCModelAdapter } from '../src/core/pcModelClient.js';
import { serverRequestLabel, serverRequestDiagnostic, serverConnectionText, serverObservationActions, serverTaskMayBeRunning } from '../src/core/serverConnection.js';
import { createTurnEvents } from '../src/app/turnEvents.js';

vi.mock('../src/app/env.js', () => ({ now: () => 0, storage: undefined, toast: vi.fn(), markActivity: vi.fn() }));

describe('云服务器连接错误与模型错误分开显示', () => {
  it('提交任务网络失败说明阶段，不猜Key/CORS根因且不泄露地址正文', async () => {
    const client = createServerClient({
      base: 'https://private.invalid', token: 'fixture-private-token',
      fetchImpl: async () => { throw new TypeError('Failed to fetch private-value'); }
    });
    const failure = await client.startTask({ sessionId: 'private-session', text: 'private-message' }).catch(e => e);
    const shown = friendlyError(failure);
    expect(shown).toContain('提交任务失败');
    expect(shown).toContain('未收到可读取的服务器响应');
    expect(shown).toContain('无法确认任务是否已被接收');
    expect(serverTaskMayBeRunning(failure)).toBe(true);
    expect(shown).not.toMatch(/API Key|启动.bat|private|额度/);
  });

  it('服务器登录401与模型401区分，保留原模型提示', async () => {
    const client = createServerClient({ base: 'https://fixture.invalid', fetchImpl: async () => new Response('{"error":"private-error"}', { status: 401 }) });
    const failure = await client.getConfig().catch(e => e);
    expect(friendlyError(failure)).toContain('服务器登录已失效');
    expect(friendlyError(failure)).not.toMatch(/API Key|private-error/);
    expect(friendlyError({ status: 401, message: 'model failure' })).toContain('API Key');
    expect(serverTaskMayBeRunning(failure)).toBe(false);
  });

  it.each([[403, '当前账号权限'], [502, 'HTTP 502']])('服务器HTTP%s保留状态，不改成模型或网络错误', (status, expected) => {
    expect(friendlyError({ status, requestTiming: { path: '/api/tasks', status, kind: 'api' } })).toContain(expected);
  });

  it('电脑模型桥HTTP鉴权失败与SSE内模型Key失败分别说明', async () => {
    const modelEvents = vi.fn(async () => new Response('', { status: 401 }));
    const client = { status: async () => ({ features: { pcModelBridge: true } }), modelEvents };
    const adapter = createPCModelAdapter(client);
    const failure = await adapter.stream({}).catch(e => e);
    expect(friendlyError(failure)).toContain('电脑模型连接：服务器登录已失效');
    modelEvents.mockResolvedValueOnce(new Response('data: {"type":"error","status":401,"message":"model failure"}\n\n'));
    const upstream = await adapter.stream({}).catch(e => e);
    expect(friendlyError(upstream)).toContain('API Key');
    expect(friendlyError(upstream)).not.toContain('服务器登录');
  });

  it('超时保留阶段，接收暂停保留任务并不建议重新发送', () => {
    expect(friendlyError({ requestTiming: { path: '/api/tasks/private-id/events', kind: 'timeout' } })).toContain('接收回答超时');
    const shown = friendlyError({ code: 'TASK_OBSERVATION_LOST', kind: 'network', message: 'private-error' });
    expect(shown).toContain('服务器可能仍在执行');
    expect(shown).toContain('打开原对话');
    expect(shown).not.toContain('private-error');
    expect(serverObservationActions().every(action => action.panel && !action.prompt)).toBe(true);
    expect(serverTaskMayBeRunning({ requestTiming: { path: '/api/tasks', method: 'POST', status: 0, kind: 'timeout' } })).toBe(true);
    expect(serverTaskMayBeRunning({ requestTiming: { path: '/api/tasks', method: 'POST', status: 429, kind: 'api' } })).toBe(false);
  });

  it('设置诊断不暴露路径中的任务号、查询、未知字段或服务正文', () => {
    expect(serverRequestLabel('/api/tasks/private-task/events?token=private')).toBe('接收回答');
    expect(serverRequestLabel('/api/private-path?key=private')).toBe('服务器请求');
    expect(serverRequestDiagnostic({ status: 503, ok: false, response: 'private' })).toBe('HTTP 503');
    expect(serverRequestDiagnostic({ status: 0, kind: 'network', ok: false })).toBe('未收到可读取的响应');
    expect(serverRequestDiagnostic({ status: 0, kind: 'timeout', ok: false })).toBe('等待超时');
  });

  it('断线与恢复事件只更新原气泡/状态，不增加工具或模型步骤', () => {
    const bubble = { status: vi.fn(), append: vi.fn() };
    const turn = { steps: 2, background: false };
    // 实际stage.setTask会刷新气泡活动，最终必须仍显示断线文案。
    const app = { active: turn, setTask: vi.fn(() => bubble.status('思考中')) };
    const handler = createTurnEvents(app).turnEvents(turn, {}, { bubble });
    handler({ type: 'server_connection', state: 'reconnecting', error: 'private-error' });
    expect(bubble.status).toHaveBeenLastCalledWith('回答连接中断，正在重连原任务…');
    expect(app.setTask).toHaveBeenLastCalledWith('processing', turn.status);
    handler({ type: 'server_connection', state: 'connected' });
    expect(bubble.status).toHaveBeenLastCalledWith(serverConnectionText({ state: 'connected' }));
    expect(turn.steps).toBe(2);
    expect(bubble.append).not.toHaveBeenCalled();
    turn.background = true;
    app.setTask.mockClear();
    handler({ type: 'server_connection', state: 'reconnecting' });
    expect(app.setTask).not.toHaveBeenCalled();
  });
});
