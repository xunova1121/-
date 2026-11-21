/** 智能体底层第二批：模型出错自动换备用模型、项目规则文件、长任务中途提醒 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { fallbackRoutes, canFallback } from '../src/llm/router.js';
import { loadRules, rulesBlock, RULES_MAX } from '../src/agent/projectRules.js';

const call = (id, name, args = {}) => ({ id, name, args });
const ctx = { dynamic: '测试', kbHits: [] };
const done = (text) => ({ async stream({ onText }) { onText(text); return { text, toolCalls: [], stop: 'end_turn' }; } });

it('电视剧原话使用较短问答说明，并把快速卡住检测与零内部重试传给模型',async()=>{
 const adapter={async stream(o){expect(o.stallTimeouts).toMatchObject({first:20_000,between:25_000});expect(o.maxTransientRetries).toBe(0);expect(o.system[0].length).toBeLessThan(agent.STABLE_PROMPT.length);o.onText('已核实的回答');return{text:'已核实的回答',toolCalls:[],stop:'end_turn'};}};
 await agent.runAgent({adapter,model:'m',history:[],userText:'现在播放的电视剧伟大的长征播放哪一集了，内容是什么',tools:[],context:ctx,emit:()=>{},quiet:true});
});

it('真正经过Claude适配器的主模型卡住20秒后，执行器直接换备用模型，不等待三次120秒',async()=>{
 const {createAnthropicAdapter}=await import('../src/llm/anthropic.js');let calls=0;
 const primary=createAnthropicAdapter({client:{beta:{messages:{stream(){calls++;return{[Symbol.asyncIterator]:()=>({next:()=>new Promise(()=>{})}),finalMessage:()=>new Promise(()=>{})};}}}}});
 vi.useFakeTimers();
 try{
   const result=agent.runAgent({adapter:primary,model:'primary',fallbacks:[{adapter:done('备用模型的回答'),model:'backup'}],history:[],userText:'现在播放的电视剧伟大的长征播放哪一集了，内容是什么',tools:[],context:ctx,emit:()=>{},quiet:true});
   await vi.advanceTimersByTimeAsync(20_001);expect((await result).text).toBe('备用模型的回答');expect(calls).toBe(1);
 }finally{vi.useRealTimers();}
});

it('闲聊中追加文档任务时恢复工具与完整任务规则，避免闲聊模式吞掉任务',async()=>{
 const inbox=[];let n=0,writes=0;
 const adapter={async stream(o){if(++n===1){expect(o.tools).toEqual([]);inbox.push('写一份完整报告并保存文件');o.onText('你好。');return{text:'你好。',toolCalls:[],stop:'end_turn'};}if(n===2){expect(o.tools.some(t=>t.name==='write_file')).toBe(true);expect(o.system[0]).toBe(agent.STABLE_PROMPT);return{text:'',toolCalls:[call('w','write_file')],stop:'tool_use'};}o.onText('已保存。');return{text:'已保存。',toolCalls:[],stop:'end_turn'};}};
 await agent.runAgent({adapter,model:'m',history:[],userText:'你好',light:true,inbox,tools:[{name:'write_file',description:'x',input_schema:{type:'object',properties:{}},run:async()=>{writes++;return'ok';}}],context:ctx,emit:()=>{},quiet:true});expect(writes).toBe(1);
});

it('简单闲聊不扫描知识库、技能清单和跨会话历史，仍读取核心记忆与项目规则',async()=>{
 const kb=await import('../src/agent/knowledge.js'),packs=await import('../src/agent/skillPacks.js'),sessions=await import('../src/agent/sessions.js');
 const search=vi.spyOn(kb,'search'),skills=vi.spyOn(packs,'enabled'),past=vi.spyOn(sessions,'searchMessages');
 try{await agent.buildContext('你好',{light:true});expect(search).not.toHaveBeenCalled();expect(skills).not.toHaveBeenCalled();expect(past).not.toHaveBeenCalled();}finally{search.mockRestore();skills.mockRestore();past.mockRestore();}
});

let agent;
beforeEach(async () => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  agent = await import('../src/agent/agent.js');
});
afterEach(() => { delete globalThis.indexedDB; });

describe('模型出错自动换备用模型', () => {
  it('哪些错误换模型：临时故障、限流、模型不存在、余额不足换；点停止、参数错误不换', () => {
    for (const e of [{ status: 503 }, { status: 524 }, { status: 429 }, { status: 404 }, { status: 402 }, { name: 'TypeError', message: 'Failed to fetch' }, { message: '无可用渠道' }, { message: 'The model `x` does not exist or is not available' }]) {
      expect(canFallback(Object.assign(new Error(e.message ?? ''), e)), JSON.stringify(e)).toBe(true);
    }
    expect(canFallback(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(canFallback(Object.assign(new Error('模型接口返回 400：参数不对'), { status: 400 }))).toBe(false);
    expect(canFallback(null)).toBe(false);
  });

  it('备用模型：分工里设过的其他模型、默认模型、其他填了密钥的服务商；不重复、不含当前、最多 2 个', () => {
    const cfg = {
      provider: 'relay-multi', models: { 'relay-multi': 'claude-haiku-5-5', deepseek: 'deepseek-chat' }, keys: { 'relay-multi': 'k', deepseek: 'k2' },
      routing: { enabled: true, provider: 'relay-multi', routes: { chat: 'relay-multi::claude-haiku-5-5', reason: 'relay-multi::gpt-6.1-sol', code: 'gpt-6.1-sol' } }
    };
    const r = fallbackRoutes(cfg, { provider: 'relay-multi', model: 'claude-haiku-5-5' });
    expect(r.map((x) => `${x.provider}/${x.model}`)).toEqual(['relay-multi/gpt-6.1-sol', 'deepseek/deepseek-chat']);
    expect(r[1].cfg.provider).toBe('deepseek');
    // 没开分工、只有一家：当前就是默认模型，没有备用
    expect(fallbackRoutes({ provider: 'relay-multi', models: { 'relay-multi': 'm' }, keys: { 'relay-multi': 'k' } }, { provider: 'relay-multi', model: 'm' })).toEqual([]);
  });

  it('重试后还是出错、这一步还没输出：换备用模型接着做，通知界面，后面的步骤都用新模型', async () => {
    const broken = { async stream() { throw Object.assign(new Error('模型接口返回 503'), { status: 503 }); } };
    const events = [];
    const models = [];
    let n = 0;
    const backup = { async stream({ model, onText }) {
      models.push(model);
      if (++n === 1) return { text: '', toolCalls: [call('1', 'update_plan', { steps: [{ text: '回答', status: 'done' }] })], stop: 'tool_use' };
      onText('换了模型也答出来了'); return { text: '换了模型也答出来了', toolCalls: [], stop: 'end_turn' };
    } };
    const r = await agent.runAgent({ adapter: broken, model: 'claude-haiku-5-5', fallbacks: [{ adapter: backup, model: 'gpt-6.1-sol' }], history: [], userText: '你好', tools: [], context: ctx, emit: (e) => events.push(e) });
    expect(r.text).toBe('换了模型也答出来了');
    expect(events.find((e) => e.type === 'fallback')).toEqual({ type: 'fallback', from: 'claude-haiku-5-5', to: 'gpt-6.1-sol', reason: '模型接口返回 503' });
    expect(models).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol']);
  });

  it('已经输出了一半、点了停止、或者参数错误：不换，照常报错', async () => {
    const half = { async stream({ onText }) { onText('写到一半'); throw Object.assign(new Error('连接断开'), { status: 502 }); } };
    const backup = { stream: vi.fn() };
    await expect(agent.runAgent({ adapter: half, model: 'a', fallbacks: [{ adapter: backup, model: 'b' }], history: [], userText: 'x', tools: [], context: ctx, emit: () => {} })).rejects.toThrow('连接断开');
    const bad = { async stream() { throw Object.assign(new Error('参数不对'), { status: 400 }); } };
    await expect(agent.runAgent({ adapter: bad, model: 'a', fallbacks: [{ adapter: backup, model: 'b' }], history: [], userText: 'x', tools: [], context: ctx, emit: () => {} })).rejects.toThrow('参数不对');
    expect(backup.stream).not.toHaveBeenCalled();
  });

  it('备用模型也出错：一个个试完再报错', async () => {
    const down = (msg) => ({ async stream() { throw Object.assign(new Error(msg), { status: 503 }); } });
    const events = [];
    await expect(agent.runAgent({ adapter: down('一'), model: 'a', fallbacks: [{ adapter: down('二'), model: 'b' }, { adapter: down('三'), model: 'c' }], history: [], userText: 'x', tools: [], context: ctx, emit: (e) => events.push(e) })).rejects.toThrow('三');
    expect(events.filter((e) => e.type === 'fallback').map((e) => e.to)).toEqual(['b', 'c']);
  });
});

describe('长任务中途提醒', () => {
  it('提醒内容：用户这次的要求、计划做到哪、还剩哪几步', () => {
    const t = agent.progressReminder({ userText: '做一份 8 页的汇报 PPT', steps: [{ text: '查资料', status: 'done' }, { text: '写提纲', status: 'doing' }, { text: '生成 PPT', status: 'todo' }], toolCount: 6 });
    expect(t).toMatch(/已经调用了 6 次工具。用户这次要的是：“做一份 8 页的汇报 PPT”。计划共 3 步，已完成 1 步，还剩：写提纲；生成 PPT。/);
    expect(agent.progressReminder({ userText: 'x', steps: [], toolCount: 6 })).toMatch(/还没有列计划/);
    expect(agent.progressReminder({ userText: '长'.repeat(300), toolCount: 6 })).toMatch(/长{200}…/);
  });

  it('每调用 6 次工具附一次提醒（附在最后一条工具结果后面），工具少时不提醒', async () => {
    const seen = [];
    let n = 0;
    const adapter = { async stream({ messages, onText }) {
      seen.push(messages.map((m) => String(m.content)));
      if (++n <= 7) return { text: '', toolCalls: [call(String(n), 'noop', { n })], stop: 'tool_use' };
      onText('好了'); return { text: '好了', toolCalls: [], stop: 'end_turn' };
    } };
    const tools = [{ name: 'noop', description: '什么都不做', input_schema: { type: 'object', properties: { n: { type: 'number' } } }, run: async () => 'ok' }];
    await agent.runAgent({ adapter, model: 'm', history: [], userText: '整理资料', tools, context: ctx, emit: () => {} });
    const reminders = (msgs) => msgs.filter((c) => c.includes('进度提醒')).length;
    expect(reminders(seen[5])).toBe(0); // 调了 5 次：不提醒
    expect(reminders(seen[6])).toBe(1); // 第 6 次之后：提醒一次
    expect(seen[6].at(-1)).toMatch(/^ok\n\n（进度提醒：已经调用了 6 次工具。用户这次要的是：“整理资料”/);
    expect(reminders(seen[7])).toBe(1); // 第 7 次：不再重复
    const few = { async stream({ onText }) { onText('答'); return { text: '答', toolCalls: [], stop: 'end_turn' }; } };
    expect((await agent.runAgent({ adapter: few, model: 'm', history: [], userText: 'x', tools, context: ctx, emit: () => {} })).text).toBe('答');
  });
});

describe('项目规则文件', () => {
  it('读工作区根目录的“未央规则.md”，没有再找 AGENTS.md；空文件、读不到当没有', async () => {
    const files = { 'AGENTS.md': '用英文写代码注释', '未央规则.md': '﻿  文件一律存到 报告/ 目录\n称呼我王总  ' };
    const fs = { exists: async (p) => p in files, readText: async (p) => files[p] };
    expect(await loadRules(fs)).toEqual({ path: '未央规则.md', text: '文件一律存到 报告/ 目录\n称呼我王总', truncated: false });
    delete files['未央规则.md'];
    expect((await loadRules(fs)).path).toBe('AGENTS.md');
    files['AGENTS.md'] = '   ';
    expect(await loadRules(fs)).toBeNull();
    expect(await loadRules({ exists: async () => true, readText: async () => { throw new Error('坏了'); } })).toBeNull();
  });

  it('太长时截断并提示去读原文件；放进上下文时写明优先级', async () => {
    const r = await loadRules({ exists: async () => true, readText: async () => '规'.repeat(RULES_MAX + 10) });
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(RULES_MAX);
    const block = rulesBlock(r);
    expect(block).toMatch(/^## 项目规则（工作区 未央规则.md，用户写的长期规矩：照着做，优先于默认做法；和用户这次说的冲突时以这次为准）/);
    expect(block).toMatch(/用 read_file 读 未央规则.md/);
    expect(rulesBlock(null)).toBe('');
  });

  it('每轮自动带进上下文：工作区里有规则文件时出现在给模型的说明里', async () => {
    const ws = await import('../src/agent/workspace.js');
    await ws.write('未央规则.md', '所有报告都用公文格式');
    const { buildContext } = agent;
    const c = await buildContext('写个通知');
    expect(c.dynamic).toMatch(/## 项目规则（工作区 未央规则.md[\s\S]*所有报告都用公文格式/);
    expect(agent.STABLE_PROMPT).toMatch(/记进项目规则/);
  });
});

describe('干活时插话不打断', () => {
  it('认出问进度和要停下的话；别的话不算', async () => {
    const { STATUS_ASK, STOP_ASK, turnStatus } = await import('../src/core/interject.js');
    for (const t of ['好了吗', '好了吗？', '进度呢', '还要多久', '做完了吗？？', '在吗']) expect(STATUS_ASK.test(t), t).toBe(true);
    for (const t of ['好了吗，顺便把字调大', '查一下最近的新闻', '把第二页改一下']) expect(STATUS_ASK.test(t), t).toBe(false);
    for (const t of ['停', '先别做了', '取消！', 'stop']) expect(STOP_ASK.test(t), t).toBe(true);
    expect(STOP_ASK.test('停车场在哪')).toBe(false);
    expect(turnStatus({ t0: 0, steps: 5, status: '生成 PPT…' }, 125_000)).toBe('还在做，已经 2 分 5 秒、第 5 步，现在在生成 PPT');
    expect(turnStatus({ t0: 0, steps: 0, status: '' }, 8_000)).toBe('还在做，已经 8 秒');
  });

  it('认出明说是“另一件事”的话：排到手上这件做完后单独做；补充和修改不算（用户 2026-10-30）', async () => {
    const { separateRequest } = await import('../src/core/interject.js');
    for (const t of ['另外帮我查下明天天气', '还有件事，下午三点提醒我开会', '换个话题，今天油价多少', '顺便问一下，社保怎么交', '跟这个无关，帮我写个请假条', '对了，问一下医保报销比例'])
      expect(separateRequest(t), t).toBe(true);
    for (const t of ['字再大一点', '再加一页总结', '另外把标题也改了，这份要红头', '顺便把上面的表格也改一下', '另外', '还有，第二页删掉', '对了，标题用黑体', '好了吗'])
      expect(separateRequest(t), t).toBe(false);
  });

  it('干活中途收到的话：下一步开始前交给模型（附在工具结果后面），任务接着做，不重新开始', async () => {
    const inbox = [];
    const seen = [];
    let n = 0;
    const tools = [{ name: 'noop', description: 'x', input_schema: { type: 'object', properties: { n: { type: 'number' } } }, run: async () => { if (n === 1) inbox.push('字再大一点'); return 'ok'; } }];
    const adapter = { async stream({ messages, onText }) {
      seen.push(messages.at(-1).content);
      if (++n <= 2) return { text: '', toolCalls: [call(String(n), 'noop', { n })], stop: 'tool_use' };
      onText('做好了，字也调大了'); return { text: '做好了，字也调大了', toolCalls: [], stop: 'end_turn' };
    } };
    const r = await agent.runAgent({ adapter, model: 'm', history: [], userText: '做个 PPT', tools, context: ctx, emit: () => {}, inbox });
    expect(r.text).toBe('做好了，字也调大了');
    expect(seen[1]).toMatch(/^ok\n\n（用户在你干活时发来：“字再大一点”。是补充或修改这件事就照着调整/);
    expect(seen.filter((c) => String(c).includes('字再大一点'))).toHaveLength(1); // 只交一次（之后留在前面的对话里，不重复附）
    expect(inbox).toEqual([]);
  });

  it('模型正要结束时又收到话：接着处理，不结束', async () => {
    const inbox = [];
    let n = 0;
    const adapter = { async stream({ messages, onText }) {
      n++;
      if (n === 1) { onText('PPT 做好了。'); inbox.push('再加一页总结'); return { text: 'PPT 做好了。', toolCalls: [], stop: 'end_turn' }; }
      expect(messages.at(-1)).toMatchObject({ role: 'user' });
      expect(messages.at(-1).content).toMatch(/“再加一页总结”/);
      onText('总结页也加上了。'); return { text: '总结页也加上了。', toolCalls: [], stop: 'end_turn' };
    } };
    const r = await agent.runAgent({ adapter, model: 'm', history: [], userText: '做个 PPT', tools: [], context: ctx, emit: () => {}, inbox });
    expect(n).toBe(2);
    expect(r.text).toMatch(/PPT 做好了。[\s\S]*总结页也加上了。/);
  });
});

it('执行器先等待检查点写入，再运行有副作用的工具',async()=>{
 const events=[];let n=0;const adapter={async stream(){return ++n===1?{text:'',toolCalls:[call('a','write_probe',{})],stop:'tool_use'}:{text:'完成',toolCalls:[],stop:'end_turn'};}};
 await agent.runAgent({adapter,model:'m',history:[],userText:'执行',context:ctx,tools:[{name:'write_probe',description:'x',input_schema:{type:'object',properties:{}},run:async()=>{events.push('run');return 'ok';}}],emit:()=>{},checkpoint:async e=>{await Promise.resolve();events.push(e.type);}});
 expect(events).toEqual(['tool_start','run','tool_end']);
});

describe('普通查询停止无效检索', () => {
  it('搜索接口失败真实上报错误；批量搜索部分成功仍保留有效来源', async () => {
    const {createTools}=await import('../src/agent/tools.js');
    const fetchViaGateway=async(url,init)=>{
      if(!url.includes('bochaai')) throw new Error('ECONNRESET');
      const q=JSON.parse(init.body).query;
      if(q==='失败') return new Response('{}',{status:503});
      return new Response(JSON.stringify({code:200,data:{webPages:{value:Array.from({length:6},(_,i)=>({name:'来源',url:`https://source.example/${i}`,snippet:'正文'}))}}}));
    };
    const search=createTools({bochaKey:'test',searchRegion:'cn',fetchViaGateway}).find(t=>t.name==='web_search');
    await expect(search.run({query:'失败'})).rejects.toThrow('搜索失败');
    const partial=await search.run({queries:['成功','失败']});
    expect(partial).toContain('https://source.example/');expect(partial).toContain('搜索失败');
  });
  it('连续换不同链接仍在三次失败后收尾，并关闭原生搜索与工具', async () => {
    let n=0, reads=0; const events=[];
    const adapter={async stream({tools,allowWebSearch,onText,messages}) {
      if (!allowWebSearch) {
        expect(tools).toEqual([]); expect(messages.at(-1).content).toContain('连续 3 次');
        onText('这些网页未能读取，尚未核实结局。'); return {text:'这些网页未能读取，尚未核实结局。',toolCalls:[],stop:'end_turn'};
      }
      return {text:'',toolCalls:[call(String(++n),'fetch_url',{url:`https://site${n}.example/a`})],stop:'tool_use'};
    }};
    const tool={name:'fetch_url',description:'x',input_schema:{type:'object',properties:{url:{type:'string'}}},run:async()=>{reads++;throw new Error('HTTP 403');}};
    const r=await agent.runAgent({adapter,model:'m',history:[],userText:'仙逆中姚冰云的结局',tools:[tool],context:ctx,emit:e=>events.push(e)});
    expect(reads).toBe(3); expect(r.text).toContain('尚未核实'); expect(events.filter(e=>e.type==='tool_end'&&!e.ok)).toHaveLength(3);
  });
  it('Claude原生搜索 pause_turn 也计入45秒预算，不会绕过收尾', async () => {
    let t=0,n=0;
    const adapter={async stream({onText,allowWebSearch,tools}) {
      n++;
      if (n===1) {onText('',{serverTool:'web_search'});t=46_000;return {text:'',toolCalls:[],raw:[],stop:'pause_turn'};}
      expect(allowWebSearch).toBe(false);expect(tools).toEqual([]);
      onText('现有来源不足，无法确认。');return {text:'现有来源不足，无法确认。',toolCalls:[],stop:'end_turn'};
    }};
    const r=await agent.runAgent({adapter,model:'m',history:[],userText:'查一下结局',tools:[],context:ctx,emit:()=>{},now:()=>t});
    expect(n).toBe(2);expect(r.text).toContain('无法确认');
  });
  it('原生搜索同一请求卡住时取消检索，再以禁用搜索的请求收尾', async () => {
    let n=0;
    const adapter={async stream({onText,allowWebSearch,signal}) {
      if (++n===1) {onText('',{serverTool:'web_search'});return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}
      expect(allowWebSearch).toBe(false);onText('检索超时，未获得足够依据。');return {text:'检索超时，未获得足够依据。',toolCalls:[],stop:'end_turn'};
    }};
    const r=await agent.runAgent({adapter,model:'m',history:[],userText:'查结局',tools:[],context:ctx,emit:()=>{},timeBudgetMs:15});
    expect(n).toBe(2);expect(r.text).toContain('检索超时');
  });
  it('深度报告联网超时后，仍能生成文件，不被普通查询预算拦掉', async () => {
    let n=0,t=0,writes=0;
    const tools=[{name:'fetch_url',description:'x',input_schema:{type:'object',properties:{}},run:async()=>{t=500_000;return '来源正文';}},
      {name:'write_file',description:'x',input_schema:{type:'object',properties:{}},run:async()=>{writes++;return '保存完成';}}];
    const adapter={async stream({allowWebSearch,tools,onText}) {
      n++;if(n===1)return {text:'',toolCalls:[call('r','fetch_url')],stop:'tool_use'};
      if(n===2){expect(allowWebSearch).toBe(false);expect(tools.some(t=>t.name==='write_file')).toBe(true);return {text:'',toolCalls:[call('w','write_file')],stop:'tool_use'};}
      onText('报告已保存，资料限制已注明。');return {text:'报告已保存，资料限制已注明。',toolCalls:[],stop:'end_turn'};
    }};
    await agent.runAgent({adapter,model:'m',history:[],userText:'写一份调研报告',tools,context:ctx,emit:()=>{},now:()=>t});
    expect(writes).toBe(1);
  });
});


