import { it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createPageReader } from '../src/agent/pageReader.js';
import { readPageCandidates } from '../src/agent/pageCandidates.js';
import { readGovernmentGuide } from '../src/agent/governmentGuide.js';
import { LINK_MARKER } from '../src/agent/pageLinks.js';
import { isSmallTalk } from '../src/llm/router.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { runAgent } from '../src/agent/agent.js';

const context = { dynamic: '虚构测试', kbHits: [] };
const call = (id, name, args = {}) => ({ id, name, args });
const long = '真实网页正文材料。'.repeat(100);

it('DeepSeek、直读、代读和重试共用八秒，忽略signal也不死等', async () => {
  vi.useFakeTimers();
  try {
    const calls = [];
    const read = createPageReader({ deepseekSearchEnabled: true, deepseekSearchKey: 'fixture', tavilyKey: 'fixture', fetchViaGateway: url => { calls.push(url); return new Promise(() => {}); } });
    let settled = false;
    const result = read('https://fixture.example/page').catch(e => e).then(e => { settled = true; return e; });
    await vi.advanceTimersByTimeAsync(7999);expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);expect((await result).name).toBe('TimeoutError');
    expect(calls.some(x => x.includes('api.deepseek.com'))).toBe(true);
    expect(calls.some(x => x.includes('tavily.com'))).toBe(true);
    const count = calls.length;await vi.advanceTimersByTimeAsync(30000);expect(calls).toHaveLength(count);
  } finally { vi.useRealTimers(); }
});

it('正文流也受总期限限制，迟到正文不写缓存', async () => {
  vi.useFakeTimers();
  try {
    let finish;
    const fetchImpl = vi.fn(async () => ({ ok: true, headers: new Headers({'content-type':'text/plain'}), arrayBuffer: () => new Promise(r => { finish = r; }) }));
    const read = createPageReader({ fetchImpl });
    const result = read('https://fixture.example/body').catch(e => e);
    await vi.advanceTimersByTimeAsync(8000);expect((await result).name).toBe('TimeoutError');
    finish(new TextEncoder().encode(long).buffer);await vi.advanceTimersByTimeAsync(0);
    fetchImpl.mockResolvedValue(new Response(long));
    expect(await read('https://fixture.example/body')).toBe(long);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it('备选页并发，第二页先有足够资料即取消第一页；预算及用户停止不降级', async () => {
  let firstSignal;
  const urls = ['https://slow.example/a', 'https://ready.example/b'];
  const result = await readPageCandidates(urls, { read: async (url, signal) => { if (url === urls[0]) { firstSignal = signal; return new Promise(() => {}); } return long; } });
  expect(result).toEqual({ url: urls[1], text: long });expect(firstSignal.aborted).toBe(true);
  const error = Object.assign(Error('budget'), { code:'RETRIEVAL_BUDGET' });
  await expect(readPageCandidates(urls, { read: async () => { throw error; } })).rejects.toBe(error);
  const controller = new AbortController();
  const pending = readPageCandidates(urls, { signal:controller.signal, read: () => new Promise(() => {}) }).catch(e => e);
  controller.abort(Object.assign(Error('stop'), { name:'AbortError' }));expect((await pending).name).toBe('AbortError');
});

it('政务两个子页同时读，仅正文中的真实渠道算足够，取得后停止其它页', async () => {
  const started = [], signals = [];
  const result = await readGovernmentGuide({ url:'https://demo.gov.cn/index', requestText:'查询市政府信息公开申请渠道', text:'信息公开导航\n' + LINK_MARKER + '\n信息公开指南 https://demo.gov.cn/slow\n依申请公开 https://demo.gov.cn/channel', read: async (url, signal) => { started.push(url);signals.push(signal);return url.endsWith('/slow') ? new Promise(() => {}) : '申请渠道：在线申请 https://demo.gov.cn/apply；电子邮箱：open@demo.gov.cn'; } });
  expect(started).toHaveLength(2);expect(result.url).toBe('https://demo.gov.cn/channel');expect(signals[0].aborted).toBe(true);
});

it('日常短句正向白名单，不把查资料、办事、健康或延续请求降为闲聊', () => {
  for (const text of ['我有点失落','我今天心情不好','你能不能陪我聊一会儿','你能做什么？','我可以问你一个问题吗？','你想问我什么']) expect(isSmallTalk(text),text).toBe(true);
  for (const text of ['你能不能查一下南京天气','我有点难过，帮我查心理门诊','你能不能写代码','帮我定明天的提醒','我是谁','你记得我吗','继续修改那份文件','胸痛怎么办','你能不能把这个做成PPT','我有点失落，打开上次记录']) expect(isSmallTalk(text),text).toBe(false);
});

it('实际情绪短句请求不注入工具Schema，仍带回应处境的表达要求', async () => {
  const diagnostics = [];
  const adapter = { async stream(input) { expect(input.tools).toEqual([]);expect(input.system.join('\n')).toContain('先回应具体处境');return {text:'听起来有点失落，想和我说说吗？',toolCalls:[],stop:'end_turn'}; } };
  await runAgent({adapter,model:'fixture',userText:'我有点失落',history:[],tools:[{name:'web_search',description:'工具说明'.repeat(500),input_schema:{type:'object',properties:{}},run:async()=>''}],context,light:isSmallTalk('我有点失落'),emit:e=>diagnostics.push(e),quiet:true});
  expect(diagnostics.find(e=>e.phase==='model_start').toolSchemaChars).toBe(2);
});

it('单页Word真实渲染读回完成后不为行政清单多调一次模型，未完成业务/缺失渲染仍拦截', async () => {
  globalThis.indexedDB = new IDBFactory();
  try {
    let calls=0;const events=[];
    const adapter={async stream(){if(++calls===1)return {text:'',toolCalls:[call('p','update_plan',{steps:[{text:'编写正文',status:'done'},{text:'核对文件并交付',status:'doing'}]}),call('d','create_document',{path:'交付/单页.docx'})],stop:'tool_use'};return {text:'已生成：[单页Word](交付/单页.docx)。',toolCalls:[],stop:'end_turn'};}};
    const tool={name:'create_document',description:'fixture',input_schema:{type:'object',properties:{}},async run(args,{checkpoint}){await checkpoint({type:'artifact_validation',path:args.path,validation:{format:'docx',readback:'passed',structure:'passed',render:'passed',errors:0,pages:1}});return '已生成单页Word';}};
    await runAgent({adapter,model:'fixture',userText:'制作一页Word说明，先列计划',history:[],tools:[tool],context,emit:e=>events.push(e)});
    expect(calls).toBe(2);expect(events.filter(e=>e.type==='plan').at(-1).steps.every(s=>s.status==='done')).toBe(true);
    expect(events.filter(e=>e.phase==='model_start').map(e=>e.purpose)).not.toContain('finish_check');
    const review=createExecutionReview('制作一页Word说明');
    review.artifact({path:'交付/单页.docx',validation:{format:'docx',readback:'passed',structure:'passed',render:'not_checked',errors:0,pages:1}});
    const steps=[{text:'交付文件',status:'todo'}];
    expect(review.completeDelivery(steps,'交付/单页.docx')).toBeNull();
    review.artifact({path:'交付/单页.docx',validation:{format:'docx',readback:'passed',structure:'passed',render:'passed',errors:0,pages:1}});
    expect(review.completeDelivery([{text:'补充第二节正文',status:'todo'}],'交付/单页.docx')).toBeNull();
    review.checkAnswer('时间12:30');review.revise('不要时间');review.checkAnswer('时间12:30');
    expect(review.completeDelivery(steps,'交付/单页.docx 时间12:30')).toBeNull();
  } finally {delete globalThis.indexedDB;}
});

it('海报须先取得图片文件并实际读回，单有生成口头回执不能自动完成', () => {
  const review=createExecutionReview('生成一张图片');
  review.record({name:'generate_image',ok:true,output:'已生成，保存在 poster.png'});
  const steps=[{text:'交付文件',status:'todo'}];
  expect(review.completeDelivery(steps,'poster.png')).toBeNull();
  review.record({name:'read_file',args:{path:'poster.png'},ok:true,output:'图片已读取'});
  expect(review.completeDelivery(steps,'poster.png')).toEqual([{text:'交付文件',status:'done'}]);
});
