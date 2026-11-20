import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { answerWorkshopCommand, createWorkshopChat, shouldAnswerWorkshopCommand, workshopCommand } from '../src/app/workshopChat.js';
import { dispatchWorkshopCommand, getWorkshopLife } from '../src/app/workshopLife.js';
import { playWorkshopHum } from '../src/ui/workshopHum.js';

vi.mock('../src/ui/workshopHum.js', () => ({ playWorkshopHum: vi.fn(), stopWorkshopHum: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 20, 12, 10));
  dispatchWorkshopCommand('auto');
  dispatchWorkshopCommand('lamp-auto');
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each([
  ['你在干嘛', 'status'], ['小未央，你现在在做什么呀？', 'status'], ['现在你在忙什么呢', 'status'],
  ['请打开工作台的台灯', 'lamp-on'], ['把房间里的台灯关掉', 'lamp-off'], ['恢复自动灯光', 'lamp-auto'],
  ['未央，去泡杯咖啡吧', 'coffee'], ['给自己冲一杯咖啡', 'coffee'], ['你先去吃饭吧', 'eat'], ['去睡一会儿', 'sleep'],
  ['休息一下', 'rest'], ['去看会儿电视', 'tv'], ['沉思一会儿吧', 'think'], ['粉碎桌上的废纸', 'shred'],
  ['你能不能哼一支小曲', 'sing'], ['给我唱首歌听听', 'sing'], ['恢复自己的作息吧', 'auto']
])('房间短句 %s 匹配 %s', (text, command) => expect(workshopCommand(text)).toBe(command));

it.each([
  '打开文件', '查找并删除以前的文件', '把昨天的工作区文件销毁', '把废纸.pdf送进碎纸机', '帮我删除资料架中的文件夹',
  '查一下泡咖啡的步骤', '开灯流程写进交接方案', '买个台灯', '我吃饭多少钱', '你在干嘛，继续把表格做好',
  '播放周杰伦的歌', '我想听《晴天》', '生成一首歌', '唱个歌并导出MP3', '帮我生成喝咖啡的歌单', '睡觉有什么用'
])('交给原任务路由 %s', (text) => expect(workshopCommand(text)).toBeNull());

it('家中无人打扰时自动作息不会发声；直接明确点唱复用本地音效', () => {
  expect(answerWorkshopCommand('status')).toContain('午饭');
  expect(playWorkshopHum).not.toHaveBeenCalled();
  playWorkshopHum.mockReturnValueOnce(true);
  expect(answerWorkshopCommand('sing')).toContain('正在哼歌');
  expect(playWorkshopHum).toHaveBeenCalledTimes(1);
  expect(answerWorkshopCommand('sing')).toContain('暂时无法播放');
});

it('默认输入的纯状态询问即时答，明确排队的状态询问保留在队列，穿插指令遵循工作优先', () => {
  expect(shouldAnswerWorkshopCommand('status', { busy: true, mode: 'queue', instantStatus: true })).toBe(true);
  expect(shouldAnswerWorkshopCommand('status', { busy: true, mode: 'queue' })).toBe(false);
  expect(shouldAnswerWorkshopCommand('sleep', { busy: true, mode: 'queue', instantStatus: true })).toBe(false);
  expect(shouldAnswerWorkshopCommand('lamp-off', { busy: true, mode: 'steer' })).toBe(true);
  expect(answerWorkshopCommand('sleep', { busy: true })).toContain('当前任务');
  expect(getWorkshopLife().manual).toBe(false);
});

function fixture(server) {
  const session = { id: 'example', messages: [] };
  const rememberTurn = (role, content, extra, target = session) => target.messages.push({ role, content, ts: Date.now(), ...extra });
  const app = {
    session, server, active: null,
    rememberTurn,
    takeTurnInput: (text, echo) => { if (echo) rememberTurn('user', text); },
    transcript: { add: vi.fn(() => ({ done: vi.fn() })) },
    dashboard: { setTurns: vi.fn() },
    settings: { readTyped: false },
    speaker: { cancel: vi.fn(), speak: vi.fn() },
    setTask: vi.fn()
  };
  const warn = vi.fn();
  return { app, chat: createWorkshopChat(app, warn), warn };
}

it('运行中“你在干嘛”取实际活跃步骤与文件，避免向模型任务或锁定云会话追加消息', async () => {
  const server = { appendSession: vi.fn() };
  const { app, chat } = fixture(server);
  app.active = { status: '思考中' };
  const snapshot = { active: true, entries: [{ title: '写入文件', file: '出库.md', status: 'running' }, { title: '上一步', status: 'done' }] };
  await chat.reply('status', '你在干嘛', { busy: true, echo: true, snapshot });
  expect(app.transcript.add.mock.calls).toEqual([['user', '你在干嘛'], ['agent', expect.stringContaining('写入文件”（出库.md）')]]);
  expect(app.session.messages).toEqual([]);
  expect(server.appendSession).not.toHaveBeenCalled();
  expect(app.setTask).not.toHaveBeenCalled();
});

it('空闲房间指令立即执行，按会话顺序持久化，切换账户不改写目标', async () => {
  let release;
  const server = { appendSession: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValue({ ok: true }) };
  const { app, chat } = fixture(server);
  const first = chat.reply('lamp-on', '开灯', { echo: true });
  const second = chat.reply('coffee', '泡杯咖啡', { echo: true });
  await Promise.resolve();
  expect(server.appendSession).toHaveBeenCalledTimes(1);
  expect(getWorkshopLife()).toMatchObject({ activity: 'coffee', lampOn: true });
  const original = app.session;
  app.server = { appendSession: vi.fn() };
  app.session = { id: 'second', messages: [] };
  release();
  await Promise.all([first, second, chat.pending(server, original.id)]);
  expect(chat.pending(server, original.id)).toBeUndefined();
  expect(original.messages.map(({ role }) => role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(server.appendSession.mock.calls.map(([id, messages]) => [id, messages[0].content])).toEqual([['example', '开灯'], ['example', '泡杯咖啡']]);
  expect(app.server.appendSession).not.toHaveBeenCalled();
});

it('同步失败保留已显示的消息，报告失败而且不重复执行房间指令', async () => {
  const error = new Error('offline');
  const server = { appendSession: vi.fn().mockRejectedValue(error) };
  const { app, chat, warn } = fixture(server);
  await chat.reply('rest', '休息一会', { echo: true });
  expect(app.session.messages).toHaveLength(2);
  expect(warn).toHaveBeenCalledWith(error);
  expect(server.appendSession).toHaveBeenCalledTimes(1);
  expect(chat.pending(server, 'example')).toBeUndefined();
});

it('别的会话在工作时说出忙碌状态而不透露私信；空闲会话仍保存问答、可控灯', async () => {
  const server = { appendSession: vi.fn().mockResolvedValue({ ok: true }) };
  const { app, chat } = fixture(server);
  const options = { echo: true, busy: false, snapshot: { active: false, otherWork: true, entries: [] } };
  await chat.reply('status', '你在干嘛', options);
  await chat.reply('coffee', '泡杯咖啡', options);
  await chat.reply('lamp-off', '关灯', options);
  expect(app.session.messages[1].content).toBe('我正在后台处理另一段对话的任务。');
  expect(app.session.messages[3].content).toContain('忙完');
  expect(app.session.messages[5].content).toContain('关了');
  expect(getWorkshopLife()).toMatchObject({ manual: false, lampOn: false });
  expect(server.appendSession).toHaveBeenCalledTimes(3);
});
