import { afterEach, expect, it, vi } from 'vitest';
import { createRecovery } from '../src/app/recovery.js';
import { list, get } from '../src/agent/sessions.js';
import { takePending } from '../src/core/pendingTask.js';

vi.mock('../src/config.js', () => ({ MOBILE: true }));
vi.mock('../src/app/env.js', () => ({ COMPACT: true, storage: {}, toast: vi.fn() }));
vi.mock('../src/agent/store.js', () => ({ storageProblem: async () => '' }));
vi.mock('../src/agent/sessions.js', () => ({ list: vi.fn(), get: vi.fn() }));
vi.mock('../src/core/pendingTask.js', () => ({ takePending: vi.fn(), resumeText: () => '继续' }));
vi.mock('../src/app/shareReturn.js', () => ({ createShareRecovery: () => ({ restore: async () => false }) }));

function start() {
  const app = { settings: {}, session: { id: 'home' }, history: [], switchTo: vi.fn(), send: vi.fn(), sessionsPanel: { refresh: vi.fn() } };
  return { app, ready: createRecovery(app).resumeOnStart() };
}

afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

it('手机正常进首页时恢复模块不读取全部对话', async () => {
  await start().ready;
  expect(list).not.toHaveBeenCalled();
});

it('已知待恢复任务的会话 ID 时直接取会话', async () => {
  takePending.mockReturnValue({ sessionId: 'pending' });
  get.mockResolvedValue({ id: 'pending', messages: [] });
  const { app, ready } = start();
  await ready;
  expect(get).toHaveBeenCalledWith('pending');
  expect(app.switchTo).toHaveBeenCalledWith({ id: 'pending', messages: [] });
  expect(list).not.toHaveBeenCalled();
});

it('崩溃重开仍会恢复近六小时的对话，迟到结果不会抢走新打开的会话', async () => {
  vi.stubGlobal('__jarvisRecentCrash', true);
  const recent = { id: 'recent', updatedAt: Date.now() };
  list.mockResolvedValueOnce([recent]);
  const first = start();
  await first.ready;
  expect(first.app.switchTo).toHaveBeenCalledWith(recent);
  let resolve;
  const loaded = new Promise(done => {
    list.mockImplementationOnce(() => { done(); return new Promise(finish => { resolve = finish; }); });
  });
  const next = start();
  await loaded;
  next.app.session = { id: 'new' };
  resolve([recent]);
  await next.ready;
  expect(next.app.switchTo).not.toHaveBeenCalled();
});
