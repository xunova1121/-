import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { createTaskRunner as makeRunner, SERVER_BLOCKED, DRAFT_MARK, DRAFT_MS, CHECKPOINT_MS, publicFetch } from '../server/taskRunner.mjs';
import { INTERRUPTED_MARK } from '../src/core/suggest.js';
import { useBackend } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

let dir;
// 每个测试建的执行器：收尾前等它们的后台活（整理记忆、压缩对话）做完，不然会写进下一个测试的存储
let runners = [];

it('服务器抓取带浏览器头，保留API头、停止信号与同一重定向总期限', async () => {
  const requests=[];const ctrl=new AbortController();
  const fetchImpl=async(url,init)=>{requests.push({url:String(url),init});return requests.length===1?new Response('',{status:302,headers:{location:'https://good.example/next'}}):new Response('ok');};
  const lookup=async()=>[{address:'93.184.216.34'}];
  await publicFetch('https://good.example/a',{signal:ctrl.signal,headers:{'Content-Type':'application/json','Authorization':'Bearer test-only'}},fetchImpl,lookup);
  expect(requests).toHaveLength(2);
  for(const r of requests){expect(r.init.headers.get('user-agent')).toContain('Mozilla/5.0');expect(r.init.headers.get('accept-language')).toContain('zh-CN');expect(r.init.headers.get('content-type')).toBe('application/json');expect(r.init.signal).toBe(ctrl.signal);}
});
const createTaskRunner = (o) => { const r = makeRunner(o); runners.push(r); return r; };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-task-')); useBackend(createFileStore(dir)); });
afterEach(async () => {
  for (const r of runners) { for (const t of r.list()) r.stop(t.id); }
  await Promise.all(runners.map((r) => r.settled()));
  runners = [];
  useBackend(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 20)); } };
const mockCfg = async () => ({ ...DEFAULT_CONFIG, provider: 'mock' });

/** 并发测试保持任务运行直到叫停；已经取消的信号也立即结束，不靠定时等待。 */
function heldAdapter() {
  return { stream: ({ signal }) => new Promise((resolve, reject) => {
    const stop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  }) };
}

/** 假模型：按脚本一步步回复（tool 调用或文字），可以设置每步之前等多久 */
function scripted(steps, { delay = 0 } = {}) {
  let i = 0;
  return { stream: async ({ onText, signal }) => {
    await new Promise((r, j) => { const t = setTimeout(r, delay); signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true }); });
    const s = steps[Math.min(i++, steps.length - 1)];
    if (s.text) onText?.(s.text);
    return { text: s.text ?? '', toolCalls: s.tools ?? [], stop: s.tools?.length ? 'tool_use' : 'end_turn' };
  } };
}

describe('服务器任务执行器', () => {
  it('真实执行路径的耗时随任务、最终事件和回答持久化，首字不计空白', async () => {
    let time = 100;
    const adapter = { async stream({onText}) { time=150;onText(' ');time=200;onText('实际回答');time=250;return {text:'实际回答',toolCalls:[],stop:'end_turn'}; } };
    const runner=createTaskRunner({getConfig:mockCfg,makeAdapter:()=>({adapter,model:'m'}),now:()=>time});
    const {id,sessionId}=await runner.start({text:'你好'});
    await until(()=>runner.get(id).status==='done');
    const timing=runner.get(id).timing;
    expect(timing).toMatchObject({version:1,queueMs:0,firstTextMs:100,totalMs:150,modelMs:150,modelCalls:1});
    expect(runner.events(id).at(-1).timing).toEqual(timing);
    const s=await sessions.get(sessionId);expect(s.messages.at(-1).timing).toEqual(timing);expect(s.taskCheckpoint.timing).toEqual(timing);
  });

  it('没有输出就失败的任务也保留诊断，不能丢在内存日志里', async () => {
    let time=0;
    const adapter={async stream(){time=100;throw new Error('controlled failure');}};
    const runner=createTaskRunner({getConfig:mockCfg,makeAdapter:()=>({adapter,model:'m'}),now:()=>time});
    const {id,sessionId}=await runner.start({text:'你好'});
    await until(()=>runner.get(id).status==='error');
    expect(runner.get(id).timing).toMatchObject({firstTextMs:null,modelMs:100,modelCalls:1});
    expect((await sessions.get(sessionId)).taskCheckpoint.timing).toEqual(runner.get(id).timing);
  });

  it('排队时停止有排队耗时但没有虚构执行或模型耗时', async () => {
    let time=0;const adapter=heldAdapter();
    const runner=createTaskRunner({getConfig:mockCfg,makeAdapter:()=>({adapter,model:'m'}),now:()=>time});
    const first=await runner.start({text:'先做报告'});await until(()=>runner.get(first.id).status==='running');
    const queued=await runner.start({text:'再做一份报告'});time=250;runner.stop(queued.id);
    await until(()=>runner.get(queued.id).status==='stopped');
    expect(runner.get(queued.id).timing).toMatchObject({queueMs:250,executionMs:null,firstTextMs:null,modelCalls:0});
  });

  it('发任务 → 服务器做完 → 回答存进对话；进度事件按序号可补发', async () => {
    const runner = createTaskRunner({ getConfig: mockCfg });
    const { id, sessionId } = await runner.start({ text: '你好，介绍一下你自己' });
    await until(() => runner.get(id).status === 'done');
    const s = await sessions.get(sessionId);
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.messages[1].content.length).toBeGreaterThan(0);
    const all = runner.events(id, 0);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all.at(-1)).toMatchObject({ type: 'task_state', status: 'done' });
    expect(runner.events(id, all.at(-2).seq)).toHaveLength(1); // 断线重连：只补发漏掉的
  });

  it('真的动手：用工具在服务器上写文件，文件记在任务和回答里', async () => {
    const adapter = scripted([
      { tools: [{ id: 'a', name: 'write_file', args: { path: '报告/说明.md', content: '# 说明\n内容' } }] },
      { text: '已写好 报告/说明.md。' }
    ]);
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter, model: 'm' }) });
    const { id, sessionId } = await runner.start({ text: '写一份说明' });
    await until(() => runner.get(id).status === 'done');
    expect(runner.get(id).files).toEqual(['报告/说明.md']);
    const ws = await import('../src/agent/workspace.js');
    expect(await ws.readText('报告/说明.md')).toContain('内容');
    const last = (await sessions.get(sessionId)).messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', content: '已写好 报告/说明.md。', files: ['报告/说明.md'], tools: ['write_file'] });
  });

  it('同一个对话正在干活时又发一句：不另起任务，交给正在干的；用户可以叫停', async () => {
    const adapter = scripted([{ text: '做了一半' }], { delay: 5000 });
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter, model: 'm' }) });
    const a = await runner.start({ text: '做个很长的任务' });
    await until(() => runner.get(a.id).status === 'running');
    const b = await runner.start({ sessionId: a.sessionId, text: '顺便加一页总结' });
    expect(b).toMatchObject({ id: a.id, joined: true });
    expect(runner.stop(a.id)).toBe(true);
    await until(() => runner.get(a.id).status === 'stopped');
    const s = await sessions.get(a.sessionId);
    expect(s.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['做个很长的任务', '顺便加一页总结']);
  });


  it('同一会话并发提交只创建一个任务，两个用户原话都保留', async () => {
    const adapter = heldAdapter();
    const runner = createTaskRunner({ getConfig: mockCfg, maxRunning: 2, makeAdapter: () => ({ adapter, model: 'm' }) });
    const results = await Promise.all([
      runner.start({ sessionId: 'concurrent-chat', text: '整理报告' }),
      runner.start({ sessionId: 'concurrent-chat', text: '再加一页总结' })
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.joined)).toHaveLength(1);
    expect(runner.list()).toHaveLength(1);
    const messages = (await sessions.get('concurrent-chat')).messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(messages).toEqual(['整理报告', '再加一页总结']);
    expect(runner.events(results[0].id).filter((e) => e.type === 'user_note').map((e) => e.text)).toEqual(['再加一页总结']);
  });

  it('排队中的同一会话并发补充不新增任务，不丢原话', async () => {
    const adapter = heldAdapter();
    const runner = createTaskRunner({ getConfig: mockCfg, maxRunning: 1, makeAdapter: () => ({ adapter, model: 'm' }) });
    await runner.start({ sessionId: 'blocking-chat', text: '先处理另一份文件' });
    const results = await Promise.all([
      runner.start({ sessionId: 'waiting-chat', text: '整理项目材料' }),
      runner.start({ sessionId: 'waiting-chat', text: '附上风险清单' })
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.joined)).toHaveLength(1);
    expect(runner.get(results[0].id).status).toBe('queued');
    expect(runner.list()).toHaveLength(2);
    expect((await sessions.get('waiting-chat')).messages.map((m) => m.content)).toEqual(['整理项目材料', '附上风险清单']);
  });

  it('不同会话仍按 maxRunning 并行，不被同会话锁串成一个任务', async () => {
    const adapter = heldAdapter();
    const runner = createTaskRunner({ getConfig: mockCfg, maxRunning: 2, makeAdapter: () => ({ adapter, model: 'm' }) });
    const results = await Promise.all([
      runner.start({ sessionId: 'parallel-a', text: '任务甲' }),
      runner.start({ sessionId: 'parallel-b', text: '任务乙' })
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(2);
    expect(results.some((r) => r.joined)).toBe(false);
    expect(runner.running).toBe(2);
    expect(runner.list().every((t) => t.status === 'running')).toBe(true);
  });

  it('同时只做 maxRunning 个，其余排队；排队中的也能取消', async () => {
    const adapter = scripted([{ text: '好' }], { delay: 300 });
    const runner = createTaskRunner({ getConfig: mockCfg, maxRunning: 1, makeAdapter: () => ({ adapter, model: 'm' }) });
    const a = await runner.start({ text: '任务一' });
    const b = await runner.start({ text: '任务二' });
    const c = await runner.start({ text: '任务三' });
    expect(runner.get(b.id).status).toBe('queued');
    runner.stop(c.id);
    await until(() => runner.get(a.id).status === 'done' && runner.get(b.id).status === 'done');
    expect(runner.get(c.id).status).toBe('stopped');
    expect(runner.running).toBe(0);
  });

  it('连续没有进展就中断，记为失败；服务器上不给运行代码、预览这类工具', async () => {
    const adapter = scripted([{ text: '…' }], { delay: 5000 });
    let names = [];
    const runner = createTaskRunner({ getConfig: mockCfg, idleMs: 100, makeAdapter: () => ({ adapter, model: 'm' }), makeTools: (ctx) => { const t = [{ name: 'run_python' }, { name: 'read_file', description: '', input_schema: { type: 'object', properties: {} }, run: async () => '' }]; names = t.map((x) => x.name); return t; } });
    const { id } = await runner.start({ text: '卡住的任务' });
    await until(() => runner.get(id).status === 'error');
    expect(runner.get(id).error).toMatch(/没有进展/);
    expect(names).toContain('run_python');
    expect(SERVER_BLOCKED.has('run_python')).toBe(true);
  });
});

describe('服务器中途重启：写了一半的回答不丢', () => {
  it('做的过程中先存半截回答；做完换成完整的', async () => {
    DRAFT_MS.value = 30;
    try {
      let release;
      const gate = new Promise((r) => { release = r; });
      let n = 0;
      const adapter = { stream: async ({ onText }) => { if (n++ === 0) { onText('写了一半，'); await gate; return { text: '写了一半，', toolCalls: [], stop: 'end_turn' }; } return { text: '', toolCalls: [], stop: 'end_turn' }; } };
      const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter, model: 'm' }) });
      const { id, sessionId } = await runner.start({ text: '写个东西' });
      await until(async () => (await sessions.get(sessionId)).messages.some((m) => m.draftOf === id));
      const mid = (await sessions.get(sessionId)).messages.at(-1);
      expect(mid.content).toContain('写了一半');
      expect(mid.content).toContain(DRAFT_MARK);
      release();
      await until(() => runner.get(id).status === 'done');
      const msgs = (await sessions.get(sessionId)).messages;
      expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1);
      expect(msgs.some((m) => m.draftOf)).toBe(false);
    } finally { DRAFT_MS.value = 10_000; }
  });
  it('重启后：上次没做完的半截回答标成“没完成”', async () => {
    const s = { ...sessions.create(), id: 'cdraft1', messages: [{ role: 'user', content: '写个东西', ts: 1 }, { role: 'assistant', content: `写了一半\n\n${DRAFT_MARK}`, ts: 2, draftOf: 'tgone' }] };
    await sessions.save(s);
    const runner = createTaskRunner({ getConfig: mockCfg });
    await runner.start({ text: '你好' }).catch(() => {}); // start 会等恢复做完
    await until(async () => !(await sessions.get('cdraft1')).messages.at(-1).draftOf); // 机器忙时多等一会儿
    const got = (await sessions.get('cdraft1')).messages.at(-1);
    expect(got.draftOf).toBeUndefined();
    expect(got.content).toContain(INTERRUPTED_MARK);
    expect(got.content).not.toContain(DRAFT_MARK);
  });
});

describe('服务器上画图', () => {
  it('generate_image 工具接上了服务器的模型设置（不再报“当前环境不能画图”）', async () => {
    let ctxSeen;
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter: scripted([{ text: '好' }]), model: 'm' }), makeTools: (ctx) => { ctxSeen = ctx; return []; } });
    const { id } = await runner.start({ text: '画一只猫' });
    await until(() => runner.get(id).status === 'done');
    expect(typeof ctxSeen.imageGen).toBe('function');
    expect(typeof ctxSeen.videoGen).toBe('function');
  });
});

describe('服务器模式补齐：和手机 / 电脑上一样', () => {
  /** 记下每次请求模型时带的参数 */
  const recording = (seen) => ({ stream: async (req) => { seen.push(req); req.onText?.('好'); return { text: '好', toolCalls: [], stop: 'end_turn' }; } });

  it('日常闲聊少想一点（首字更快）；要查证、分析的不省', async () => {
    const seen = [];
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter: recording(seen), model: 'm' }), makeTools: () => [] });
    const a = await runner.start({ text: '你好呀' });
    await until(() => runner.get(a.id).status === 'done');
    const b = await runner.start({ text: '帮我查一下今天的新闻' });
    await until(() => runner.get(b.id).status === 'done');
    expect(seen[0].effort).toBe('low');
    expect(seen.at(-1).effort).toBeUndefined();
  });

  it('随消息发来的图片交给模型看；不是图片的、太多的不收', async () => {
    const seen = [];
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter: recording(seen), model: 'm' }), makeTools: () => [] });
    const img = { mime: 'image/png', data: 'iVBORw0KGgo=' };
    const { id } = await runner.start({ text: '这张图里是什么', images: [img, { mime: 'text/html', data: 'x' }, img, img, img, img] });
    await until(() => runner.get(id).status === 'done');
    const user = seen[0].messages.find((m) => m.images);
    expect(user.images).toHaveLength(4);
    expect(user.images.every((i) => i.mime === 'image/png')).toBe(true);
  });

  it('做完以后整理记忆；对话太长时把较早部分并进前情提要', async () => {
    const memory = await import('../src/agent/memory.js');
    const id0 = 'long-chat';
    const old = Array.from({ length: 34 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 句`, ts: i + 1 }));
    await sessions.save({ ...sessions.create(), id: id0, messages: old });
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter: scripted([{ text: '记住了' }]), model: 'm' }), makeTools: () => [] });
    const { id } = await runner.start({ sessionId: id0, text: '我住在杭州，以后天气默认查杭州' });
    await until(() => runner.get(id).status === 'done');
    await until(async () => (await sessions.get(id0)).summary);
    await until(async () => (await memory.listAll()).episodes?.length > 0);
    expect((await sessions.get(id0)).messages.at(-1)).toMatchObject({ role: 'assistant', content: '记住了' });
  });

  it('联网只许访问公网：内网地址、解析到内网的域名、跳到内网的重定向都拦下', async () => {
    const ok = new Response('ok', { status: 200 });
    const fetchImpl = async (u) => (String(u).includes('jump') ? new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8888/' } }) : ok);
    const lookup = async (h) => [{ address: h === 'evil.example' ? '127.0.0.1' : '93.184.216.34' }];
    await expect(publicFetch('http://127.0.0.1:6379/', {}, fetchImpl, lookup)).rejects.toThrow('公网');
    await expect(publicFetch('http://evil.example/', {}, fetchImpl, lookup)).rejects.toThrow('公网');
    await expect(publicFetch('https://good.example/jump', {}, fetchImpl, lookup)).rejects.toThrow('公网');
    expect(await (await publicFetch('https://good.example/', {}, fetchImpl, lookup)).text()).toBe('ok');
  });

  it('搜索、读网页的工具拿到了服务器上的联网方式（不填搜索密钥也能搜）', async () => {
    let ctxSeen;
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter: scripted([{ text: '好' }]), model: 'm' }), makeTools: (ctx) => { ctxSeen = ctx; return []; } });
    const { id } = await runner.start({ text: '搜一下' });
    await until(() => runner.get(id).status === 'done');
    expect(typeof ctxSeen.fetchViaGateway).toBe('function');
  });
});

describe('服务器上：语音对话和寒暄', () => {
  it('语音对话的任务让模型口语短答；“你好”不带工具', async () => {
    const seen = [];
    const adapter = { stream: async (req) => { seen.push(req); req.onText?.('好'); return { text: '好', toolCalls: [], stop: 'end_turn' }; } };
    const tool = { name: 'tick', description: 't', input_schema: { type: 'object', properties: {} }, run: async () => 'ok' };
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter, model: 'm' }), makeTools: () => [tool] });
    const a = await runner.start({ text: '你好', voice: true });
    await until(() => runner.get(a.id).status === 'done');
    expect(seen[0].tools).toEqual([]);
    expect(seen[0].system[1]).toContain('语音对话');
    const b = await runner.start({ text: '写一份周报' });
    await until(() => runner.get(b.id).status === 'done');
    expect(seen.at(-1).tools.some((t) => t.name === 'tick')).toBe(true);
    expect(seen.at(-1).system[1]).not.toContain('语音对话');
  });
});

describe('服务器提交去重和检查点',()=>{
 it('同一提交编号并发/重试只保存一次、只启动一个任务；编号不能换内容',async()=>{
  const runner=createTaskRunner({getConfig:mockCfg,makeAdapter:()=>({adapter:heldAdapter(),model:'m'})});
  const [a,b]=await Promise.all([runner.start({sessionId:'dedup',text:'原始要求',requestId:'r_one'}),runner.start({sessionId:'dedup',text:'原始要求',requestId:'r_one'})]);
  expect(a.id).toBe(b.id);expect(runner.list()).toHaveLength(1);expect((await sessions.get('dedup')).messages.filter(x=>x.role==='user')).toHaveLength(1);
  await expect(runner.start({sessionId:'dedup',text:'不同内容',requestId:'r_one'})).rejects.toMatchObject({status:409});
 });
 it('指定原任务补充；原任务结束后不暗中启动一个新任务',async()=>{
  const runner=createTaskRunner({getConfig:mockCfg,makeAdapter:()=>({adapter:heldAdapter(),model:'m'})});
  const a=await runner.start({sessionId:'notes',text:'原始任务'});
  const b=await runner.start({sessionId:'notes',targetTaskId:a.id,text:'补充要求',requestId:'note_one'});expect(b.joined).toBe(true);
  await runner.start({sessionId:'notes',targetTaskId:a.id,text:'补充要求',requestId:'note_one'});
  expect((await sessions.get('notes')).messages.filter(x=>x.content==='补充要求')).toHaveLength(1);
  runner.stop(a.id);await until(()=>runner.get(a.id).status==='stopped');
  await expect(runner.start({sessionId:'notes',targetTaskId:a.id,text:'迟到的补充'})).rejects.toMatchObject({status:409});expect(runner.list()).toHaveLength(1);
 });
 it('工具真正执行前检查点已落盘，结束后才标成功',async()=>{
  let atExecution;
  const runner=createTaskRunner({getConfig:mockCfg,makeAdapter:()=>({adapter:scripted([{tools:[{id:'w',name:'write_probe',args:{}}]},{text:'完成'}]),model:'m'}),makeTools:()=>[{name:'write_probe',description:'t',input_schema:{type:'object',properties:{}},run:async()=>{atExecution=(await sessions.get('check')).taskCheckpoint;return '已执行';}}]});
  const a=await runner.start({sessionId:'check',text:'运行一次'});await until(()=>runner.get(a.id).status==='done');
  expect(atExecution.inFlight).toMatchObject([{id:'w',name:'write_probe'}]);
  const final=(await sessions.get('check')).taskCheckpoint;expect(final.status).toBe('done');expect(final.inFlight).toEqual([]);expect(final.steps).toMatchObject([{name:'write_probe',ok:true}]);
 });
 it('重启只标记不确定的操作，不自动重新执行，也不接受同一提交重放',async()=>{
  const s=sessions.create();s.id='restarted';s.messages=[{role:'user',content:'发消息',ts:1}];s.taskCheckpoint={text:'发消息',status:'running',inFlight:[{id:'u',name:'mcp_send_email'}]};
  await sessions.save(s);const runner=createTaskRunner({getConfig:mockCfg});await runner.settled();
  expect((await sessions.get(s.id)).taskCheckpoint.status).toBe('needs_review');expect(runner.list()).toHaveLength(0);
 });
});

it('开始新任务不会覆盖未完成检查点，明确继续时带回完整要求和未知操作',async()=>{
 const s=sessions.create();s.id='resume-full';const original='完整要求'.repeat(300)+'末尾不能遗漏';s.messages=[{role:'user',content:original,ts:1}];s.taskCheckpoint={text:original,taskId:'old-task',status:'needs_review',inFlight:[{id:'m',name:'mcp_send_email'}]};await sessions.save(s);
 let seen;const runner=createTaskRunner({getConfig:mockCfg,makeAdapter:()=>({model:'m',adapter:{async stream(req){seen=req.messages;return {text:'已核对',toolCalls:[],stop:'end_turn'};}}})});
 const task=await runner.start({sessionId:s.id,text:'继续核对上次的任务'});await until(()=>runner.get(task.id).status==='done');
 const saved=await sessions.get(s.id);expect(saved.recoveryCheckpoints[0].text).toBe(original);expect(JSON.stringify(seen)).toContain('末尾不能遗漏');expect(JSON.stringify(seen)).toContain('不得自动重放');
});




it('只读工具的检查点合并写盘（不再每个工具都重写整段对话），最终状态照样完整',async()=>{
 const store=createFileStore(dir);let puts=0;useBackend({...store,all:(...a)=>store.all(...a),get:(...a)=>store.get(...a),delete:(...a)=>store.delete(...a),clear:(...a)=>store.clear(...a),put:(name,obj)=>{if(name==='sessions')puts++;return store.put(name,obj);}});
 const old=CHECKPOINT_MS.value;CHECKPOINT_MS.value=60_000;
 try{
  const probe={name:'read_file',description:'t',input_schema:{type:'object',properties:{}},run:async()=>'内容'};
  const calls=[1,2,3,4].map(n=>({id:'r'+n,name:'read_file',args:{}}));
  const runner=createTaskRunner({getConfig:mockCfg,makeAdapter:()=>({adapter:scripted([{tools:calls},{text:'读完了'}]),model:'m'}),makeTools:()=>[probe]});
  const a=await runner.start({sessionId:'coalesce',text:'读四个文件'});await until(()=>runner.get(a.id).status==='done');await runner.settled();
  expect(puts).toBeLessThanOrEqual(5); // 以前：开始 + 每个工具开始、结束各一次（8 次）+ 结束，至少 10 次
  const final=(await sessions.get('coalesce')).taskCheckpoint;expect(final.status).toBe('done');expect(final.steps).toHaveLength(4);
 }finally{CHECKPOINT_MS.value=old;}
});

it('恢复归档最多留 5 次，旧版检查点里的网页正文归档时去掉',async()=>{
 const s=sessions.create();s.id='archive';s.messages=[{role:'user',content:'查',ts:1}];
 s.recoveryCheckpoints=Array.from({length:7},(_,i)=>({key:'k'+i,text:'旧'+i,evidence:[{key:'q',sources:[{url:'https://a.example',text:'正文'}]}]}));
 s.taskCheckpoint={text:'上次',taskId:'last',status:'error',evidence:[{key:'q',sources:[{url:'https://a.example',text:'大段网页正文'}]}]};await sessions.save(s);
 const runner=createTaskRunner({getConfig:mockCfg,makeAdapter:()=>({adapter:scripted([{text:'好'}]),model:'m'})});
 const t=await runner.start({sessionId:s.id,text:'新问题'});await until(()=>runner.get(t.id).status==='done');
 const saved=await sessions.get(s.id);expect(saved.recoveryCheckpoints).toHaveLength(5);expect(saved.recoveryCheckpoints.at(-1).text).toBe('上次');
 expect(JSON.stringify(saved.recoveryCheckpoints)).not.toContain('正文');
});
