import { afterEach, expect, it, vi } from 'vitest';
import { createNestTaskStatus } from '../src/ui/nestTaskStatus.js';

function fixture() {
  vi.useFakeTimers();
  const events = new EventTarget();
  const form = { prepend(el) { el.parentElement = form; el.isConnected = true; } };
  const attrs = new Map();
  const line = { setAttribute: (k,v) => attrs.set(k,v), remove() { this.parentElement = null; this.isConnected = false; } };
  vi.stubGlobal('document', { hidden: false, createElement: () => line });
  vi.stubGlobal('window', events);
  const scene = {isConnected:true, querySelector:vi.fn()};
  const receipt = {answer: {}, scope:'a', fileScope:'local:virtual', sessionId:'s'};
  const options = {getReceipt:()=>receipt, readResults:vi.fn(), useResult:vi.fn(async () => {})};
  const status = createNestTaskStatus(form, scene, options);
  return { status, options, line, events, receipt };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const idle = {active:false,entries:[]};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

it('短暂网络错误后按退避恢复；连续状态刷新不反复请求，也可在重新联网时立即取回成品', async () => {
  const {status, options, line, events, receipt} = fixture();
  const file = {path:'简报.docx',mtime:100,size:30};
  options.readResults.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([file]);
  status.update(idle);
  await flush();
  for (let i=0;i<5;i++) status.update(idle);
  expect(options.readResults).toHaveBeenCalledTimes(1);
  expect(line.hidden).toBe(true);
  events.dispatchEvent(new Event('online'));
  await flush();
  expect(line.textContent).toContain(file.path);
  line.onclick();
  expect(options.useResult).toHaveBeenCalledWith(receipt,file,line,false);
  status.clear();
  await vi.advanceTimersByTimeAsync(80000);
  expect(options.readResults).toHaveBeenCalledTimes(2);
});
it('新任务已经开始但尚无事件时不显示上一轮成品，迟到的读取结果也不能重新打开它', async () => {
  const {status, options, line} = fixture();
  let resolve;
  options.readResults.mockImplementation(() => new Promise(done => { resolve = done; }));
  status.update(idle);
  status.update({active:true, entries:[]});
  resolve([{path:'曾经生成.docx'}]);
  await flush();
  expect(line.hidden).toBe(true);
  status.update({active:true,entries:[{title:'正在阅读网页',status:'running'}]});
  expect(line.textContent).toContain('正在阅读网页');
  expect(line.title).toBe('查看任务步骤');
  status.clear();
});
