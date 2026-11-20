import { afterEach, expect, it, vi } from 'vitest';
import { createWorkshopNewsChat } from '../src/app/workshopNewsChat.js';
import { workshopNewsInstruction } from '../src/core/workshopNewsReference.js';
import { workshopMediaReply } from '../src/app/workshopChat.js';
import { workshopChannel } from '../src/ui/workshopMediaChannels.js';
import { classifyTaskText } from '../src/core/taskIntent.js';
import { createMessageQueue } from '../src/core/messageQueue.js';

const a = { title: '首条报道', url: 'https://news.cctv.com/a.shtml', source: '央视网', publishedAt: '2026-11-20 10:00' };
const b = { ...a, title: '第二条报道', url: 'https://news.cctv.com/b.shtml' };
function fixture() {
  vi.stubGlobal('document', { hidden: false });
  const app = {
    session: { id: 's' }, server: null, messageQueue: { scope: () => app.server || 'local' },
    prompt: { value: '', closest: vi.fn(() => ({})), focus: vi.fn(), setSelectionRange: vi.fn() },
    autosize: vi.fn(), send: vi.fn()
  };
  const chat = createWorkshopNewsChat(app);
  chat.select('s', a);
  return { chat, app };
}
afterEach(() => vi.unstubAllGlobals());

it('对话中「这条」附带当时显示的来源和时间，无关的输入不附带', () => {
  const { chat } = fixture();
  for (const text of ['请看看这条新闻', '这条对我们有什么影响？', '把这条整理成简报', '屏幕上的报道怎么解读？']) {
    const question = chat.bind(text);
    for (const value of [text, a.url, a.source, a.publishedAt, a.title]) expect(question).toContain(value);
    expect(workshopNewsInstruction(question)).toBe(text);
  }
  for (const text of ['请查今日新闻', '把这条合同条款改一下', '刚刚电视里讲了什么', '我饿了']) expect(chat.bind(text)).toBe(text);
});

it('输入框写到「这条」时锁住所见条目，轮播和队列都不会把它换成另一篇', () => {
  const { chat } = fixture(), queue = createMessageQueue();
  chat.draftChanged('这条');
  chat.select('s', b);
  const original = chat.bind('这条有何影响？');
  queue.add({ scope: 'local', sessionId: 's', text: original });
  chat.clear();
  expect(queue.take('local', 's').text).toContain(a.url);
  expect(original).not.toContain(b.url);
});

it('只在当前工作台、账号和当前会话引用，关闭、更换账号、后台及无效地址都不给新输入附加', () => {
  const { app, chat } = fixture();
  const ask = '这条新闻';
  app.session = { id: 's' };
  expect(chat.bind(ask)).toBe(ask);
  chat.select('s', a);
  app.server = { base: 'https://other.example' };
  expect(chat.bind(ask)).toBe(ask);
  chat.select('s', b);
  app.prompt.closest.mockReturnValue(null);
  expect(chat.bind(ask)).toBe(ask);
  app.prompt.closest.mockReturnValue({});
  document.hidden = true;
  expect(chat.bind(ask)).toBe(ask);
  document.hidden = false;
  chat.select('s', { ...b, url: 'javascript:bad' });
  expect(chat.bind(ask)).toBe(ask);
  chat.select('s', { ...b, url: 'https://pw@other.example/x' });
  expect(chat.bind(ask)).toBe(ask);
  chat.select('s', b);
  chat.clear();
  expect(chat.bind(ask)).toBe(ask);
});

it('追问保留手写草稿并聚焦；生成简报留住草稿和附件，使用带来源的 Word 按钮任务', () => {
  const { app, chat } = fixture();
  app.prompt.value = '对我们的订单有什么影响？';
  chat.ask('s', a);
  expect(app.prompt.value).toBe('关于这条新闻，对我们的订单有什么影响？');
  expect(app.prompt.focus).toHaveBeenCalledOnce();
  expect(app.send).not.toHaveBeenCalled();
  chat.brief('s', a);
  const [task, options] = app.send.mock.calls[0];
  expect(task).toContain(a.url);
  expect(task).toContain('.docx');
  expect(classifyTaskText(task)).toBe('write');
  expect(options).toEqual({ mode: 'queue', queuedFiles: [] });
  expect(app.prompt.value).toContain('订单');
  chat.select('s', b);
  chat.brief('s', a);
  chat.brief('other', b);
  expect(app.send).toHaveBeenCalledOnce();
});

it('报道里的 .shtml 和技术词不把问题分到代码线路，引用末尾追加的明确开发要求仍生效', () => {
  const { chat } = fixture();
  chat.select('s', { ...a, title: '部署系统：JavaScript 和 HTML 最新进展' });
  const question = chat.bind('这条对我们有什么影响？');
  expect(classifyTaskText(question)).not.toBe('code');
  expect(classifyTaskText(question + '\n请编写代码解释这个流程')).toBe('code');
});

it('恢复或再次发送已经绑定的排队问题时不重复添加另一条新闻，语音提问也不消耗手写草稿引用', () => {
  const { chat } = fixture();
  chat.draftChanged('这条');
  chat.select('s', b);
  const spoken = chat.bind('这条新闻', true);
  expect(spoken).toContain(b.url);
  expect(chat.bind(spoken)).toBe(spoken);
  chat.select('s', a);
  chat.draftChanged('这条');
  chat.select('s', b);
  chat.bind('这条', true);
  expect(chat.bind('这条新闻')).toContain(a.url);
});

it('工作台里明确换央视财经频道才选台，问频道、节目事实或编写相关文档不误执行', () => {
  expect(workshopMediaReply('未央，请换到财经频道')).toContain('CCTV-2 财经');
  expect(workshopChannel().id).toBe('cctv2');
  expect(workshopMediaReply('刚才电视里说了什么？')).toContain('没有节目字幕');
  expect(workshopMediaReply('换到新闻频道能看到什么？')).toBe('');
  expect(workshopMediaReply('写一个可以换到综合频道的方案')).toBe('');
  expect(workshopChannel().id).toBe('cctv2');
});
