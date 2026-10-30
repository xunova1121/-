import { it, expect, vi } from 'vitest';
import { readPublicJson, publicDataHosts, createPublicJsonTool, PUBLIC_JSON_LIMIT } from '../src/agent/publicJson.js';
const domains = ['data.example.com'];
it('可信域名须显式匹配；HTTPS/公网/无凭据/无端口，空清单可禁用', async () => {
  const get = vi.fn();
  for (const url of ['http://data.example.com/a','https://127.0.0.1/a','https://169.254.169.254/a','https://data.example.com.evil.com/a','https://user:pwd@data.example.com/a','https://data.example.com:8443/a','https://data.example.com/a?access_token=secret']) await expect(readPublicJson(url,{domains,get})).rejects.toBeDefined();
  await expect(readPublicJson('https://data.example.com/a',{domains:[],get})).rejects.toBeDefined(); expect(get).not.toHaveBeenCalled();
  for(const hosts of [['*.example.com'],['localhost'],['https://example.com'],['example.com:443']])expect(()=>publicDataHosts(hosts)).toThrow();
});
it('只读GET、不带Cookie/鉴权、拒绝重定向，读取预算在请求前扣', async () => {
  const consume = vi.fn(); const get = vi.fn(async (url, init) => {
    expect(consume).toHaveBeenCalledWith('read'); expect(init).toMatchObject({method:'GET',credentials:'omit',redirect:'error',headers:{Accept:'application/json'}});
    expect(Object.keys(init.headers)).toEqual(['Accept']); return new Response('{"value":18}');
  });
  expect((await readPublicJson('https://data.example.com/a',{domains,get,consume})).data).toEqual({value:18}); expect(get).toHaveBeenCalledTimes(1);
  await expect(readPublicJson('https://data.example.com/a',{domains,get:async()=>({ok:true,redirected:true})})).rejects.toMatchObject({code:'REDIRECT_BLOCKED'});
});
it('响应头及流均受200KB限制；不是JSON拒绝，长JSON只给有标记预览', async () => {
  const base = {domains,get:async()=>new Response('x',{headers:{'content-length':String(PUBLIC_JSON_LIMIT+1)}})};
  await expect(readPublicJson('https://data.example.com/a',base)).rejects.toMatchObject({code:'WEB_BODY_LIMIT'});
  await expect(readPublicJson('https://data.example.com/a',{domains,get:async()=>new Response('x'.repeat(PUBLIC_JSON_LIMIT+1))})).rejects.toMatchObject({code:'WEB_BODY_LIMIT'});
  await expect(readPublicJson('https://data.example.com/a',{domains,get:async()=>new Response('<html>login</html>')})).rejects.toMatchObject({code:'PUBLIC_JSON_PARSE'});
  const result = JSON.parse(await createPublicJsonTool({publicDataHosts:domains,fetchImpl:async()=>new Response(JSON.stringify({value:'x'.repeat(17000)}))}).run({url:'https://data.example.com/a'}));
  expect(result.truncated).toBe(true); expect(result.preview.length).toBe(16000); expect(result.data).toBeUndefined();
});
it('8秒含正文读取，停止取消流；未发请求前预算失败即停止', async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn(); const get=vi.fn(async()=>new Response(new ReadableStream({cancel})));
    const p=readPublicJson('https://data.example.com/a',{domains,get}); const assertion=expect(p).rejects.toMatchObject({name:'TimeoutError'});
    await vi.advanceTimersByTimeAsync(8001); await assertion; expect(cancel).toHaveBeenCalled();
    const error=Object.assign(new Error('budget'),{code:'RETRIEVAL_BUDGET'}); get.mockClear(); await expect(readPublicJson('https://data.example.com/a',{domains,get,consume:()=>{throw error;}})).rejects.toBe(error); expect(get).not.toHaveBeenCalled();
  } finally {vi.useRealTimers();}
});
it('缺少可做DNS校验的本机网关时不借原生网络绕过公网检查',async()=>{
  const get=vi.fn();await expect(createPublicJsonTool({publicJsonAvailable:false,fetchImpl:get}).run({url:'https://api.github.com/repos/example/demo'})).rejects.toMatchObject({code:'PUBLIC_JSON_GATEWAY_REQUIRED'});expect(get).not.toHaveBeenCalled();
});
it('普通key及常见鉴权查询参数也不能夹带；匿名JSON网关不复用任何带Key的服务商代理',async()=>{
  const {publicJsonGatewayFetch}=await import('../src/core/publicJsonGateway.js');
  const get=vi.fn();for(const key of ['key','api_key','x-api-key','client_secret','app_secret','auth','jwt','signature'])await expect(readPublicJson('https://data.example.com/a?'+key+'=dummy',{domains,get})).rejects.toMatchObject({code:'PUBLIC_JSON_CREDENTIALS'});expect(get).not.toHaveBeenCalled();
  const requests=[];const send=async(...args)=>{requests.push(args);return new Response('{}');};const signal=new AbortController().signal;
  for(const host of ['api.deepseek.com/v1/tools/fetch','api.tavily.com/extract','api.bochaai.com/api','queue.fal.run/test'])await publicJsonGatewayFetch('https://'+host,{signal,headers:{Authorization:'must-not-forward',Cookie:'must-not-forward'}},send);
  expect(requests).toHaveLength(4);for(const [url,init]of requests){expect(url.startsWith('/api/fetch?')).toBe(true);expect(url).toContain('publicJson=1');expect(init).toEqual({method:'GET',credentials:'omit',signal});expect(url).not.toContain('/api/llm/');}
});
it('实际工具优先独立匿名通道，原DeepSeek/图片/音色代理不参与JSON读取',async()=>{
  const {publicJsonGatewayFetch}=await import('../src/core/publicJsonGateway.js');const legacy=vi.fn(()=>{throw Error('不得走鉴权代理');});const calls=[];
  const tool=createPublicJsonTool({publicDataHosts:['api.deepseek.com'],fetchViaGateway:legacy,fetchPublicJson:(url,init)=>publicJsonGatewayFetch(url,init,async(...args)=>{calls.push(args);return new Response('{"count":18}');})});
  const result=JSON.parse(await tool.run({url:'https://api.deepseek.com/v1/tools/public'}));expect(result.data.count).toBe(18);expect(legacy).not.toHaveBeenCalled();expect(calls[0][0]).toContain('/api/fetch?');expect(calls[0][1].headers).toBeUndefined();
});
it('只有旧通用代理时失败关闭，不借可能带Key的通道代读',async()=>{
  const legacy=vi.fn();await expect(createPublicJsonTool({fetchViaGateway:legacy}).run({url:'https://api.github.com/repos/example/demo'})).rejects.toMatchObject({code:'PUBLIC_JSON_GATEWAY_REQUIRED'});expect(legacy).not.toHaveBeenCalled();
});
