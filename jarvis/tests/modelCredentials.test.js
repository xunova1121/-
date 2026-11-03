import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverModelConfig } from '../server/modelCredentials.mjs';
import { createAdapter } from '../src/llm/config.js';
import { credentialInfo, keySuffix } from '../src/llm/credentialContext.js';
import { routeFor, fallbackRoutes } from '../src/llm/router.js';
import { friendlyError } from '../src/core/friendlyError.js';
import { mergeConfig, maskConfig } from '../server/serverMode.mjs';
import { createModelScopes } from '../src/llm/modelScopes.js';
const NEW = 'sk-or-v1-test-new-4321', OLD = 'sk-or-v1-test-old-9876';
const cfg = { provider:'openrouter', keys:{openrouter:NEW}, models:{openrouter:'deepseek/deepseek-v4.1-flash-1017'}, pinModel:true };
const req = {model:cfg.models.openrouter,system:[],messages:[{role:'user',content:'你好'}],tools:[],onText:()=>{},maxTransientRetries:0};
const sse = () => new Response('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
afterEach(()=>vi.unstubAllGlobals());
describe('云端模型Key实际发送与诊断',()=>{
  it('云端新Key优先于旧环境Key；只向OpenRouter发送一次正确Bearer',async()=>{
    const fetcher=vi.fn(async()=>sse());vi.stubGlobal('fetch',fetcher);
    const runtime=serverModelConfig(cfg,{OPENROUTER_API_KEY:OLD});
    await createAdapter(routeFor(runtime,'chat').cfg).adapter.stream(req);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer '+NEW);
    expect(credentialInfo(runtime)).toMatchObject({source:'云服务器设置',suffix:'4321'});
    expect(cfg.keys.openrouter).toBe(NEW);
  });
  it.each(['','  ','use-gateway-key','••••9876'])('无真实设置Key %s 才使用环境Key且不写回配置',key=>{
    const saved={...cfg,keys:{openrouter:key}};
    const runtime=serverModelConfig(saved,{OPENROUTER_API_KEY:OLD});
    expect(runtime.keys.openrouter).toBe(OLD);
    expect(saved.keys.openrouter).toBe(key);
    expect(credentialInfo(runtime).source).toBe('环境变量 OPENROUTER_API_KEY');
    expect(JSON.stringify(runtime)).not.toContain('环境变量');
  });
  it('自定义OpenRouter不混用内置条目Key，不向相似域名发送环境Key',()=>{
    const custom={...cfg,provider:'custom',baseURLs:{custom:'https://openrouter.ai/api/v1'},keys:{openrouter:NEW,custom:OLD}};
    expect(serverModelConfig(custom,{OPENROUTER_API_KEY:NEW}).keys.custom).toBe(OLD);
    expect(credentialInfo(serverModelConfig(custom,{})).provider).toContain('custom');
    expect(serverModelConfig({...custom,keys:{},baseURLs:{custom:'https://openrouter.ai.evil.invalid/api/v1'}},{OPENROUTER_API_KEY:NEW}).keys.custom).toBe('');
    expect(serverModelConfig({...custom,keys:{}},{OPENROUTER_API_KEY:NEW}).keys.custom).toBe(NEW);
  });
  it('缺Key不请求，短Key不暴露全文',()=>{
    expect(createAdapter(serverModelConfig({...cfg,keys:{}},{})).problem).toContain('没有 Key');
    expect(keySuffix('abc')).toBe('已隐藏');
  });
  it.each([401,403])('实际失败线路 %i 保留来源和末四位，剔除上游回显的完整Key',async status=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{message:'secret '+OLD}}),{status})));
    const runtime=serverModelConfig({...cfg,keys:{}},{OPENROUTER_API_KEY:OLD});
    const error=await createAdapter(runtime).adapter.stream(req).catch(e=>e);
    expect(error.status).toBe(status);
    expect(error.message).toContain('OpenRouter');
    expect(error.message).toContain('环境变量 OPENROUTER_API_KEY');
    expect(error.message).toContain('9876');
    expect(error.stack).not.toContain(OLD);
    expect(JSON.stringify(error)).not.toContain(OLD);
    expect(friendlyError({message:error.message})).toBe(error.message);
  });
  it('地区限制不伪报Key无效',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"error":{"code":"model_region_restricted"}}',{status:403})));
    await expect(createAdapter(serverModelConfig(cfg,{})).adapter.stream(req)).rejects.toMatchObject({code:'MODEL_REGION_RESTRICTED',message:expect.stringContaining('当前地区')});
  });
  it('能力表/备用选择后诊断仍属于实际线路，不显示默认OpenRouter的Key',()=>{
    const runtime=serverModelConfig({...cfg,pinModel:false,keys:{...cfg.keys,custom:OLD},models:{...cfg.models,custom:'another'},baseURLs:{custom:'https://example.invalid/v1'},abilities:{chat:{main:{provider:'custom',model:'another'}}}},{});
    expect(credentialInfo(routeFor(runtime,'chat').cfg)).toMatchObject({suffix:'9876',source:'云服务器设置'});
    const back=fallbackRoutes({...runtime,fallbackPolicy:'explicit',fallbackModels:[{provider:'custom',model:'another'}]},{provider:'openrouter',model:req.model});
    expect(credentialInfo(back[0].cfg).suffix).toBe('9876');
  });
  it('旧掩码或空值保留已有Key，新值更新且去首尾空白，网关占位符不能落盘',()=>{
    for(const key of ['', '••••9876'])expect(mergeConfig(cfg,{keys:{openrouter:key}}).keys.openrouter).toBe(NEW);
    expect(mergeConfig(cfg,{keys:{openrouter:' '+OLD+' '}}).keys.openrouter).toBe(OLD);
    expect(()=>mergeConfig(cfg,{keys:{openrouter:'use-gateway-key'}})).toThrow('占位符');
  });
  it('云服务器面板写入后读回核对；伪成功不通知保存，失败后可重试',async()=>{
    let remote=structuredClone(cfg),drop=true;const saved=vi.fn();
    const scopes=createModelScopes({getLocal:()=>({}),saveLocal:vi.fn(),onServerSaved:saved,getClient:()=>({getConfig:async()=>maskConfig(remote),putConfig:async delta=>{if(!drop)remote=mergeConfig(remote,delta);}})});
    await expect(scopes.patch('server',x=>({...x,keys:{...x.keys,openrouter:OLD}}))).rejects.toMatchObject({code:'MODEL_KEY_SAVE'});
    expect(saved).not.toHaveBeenCalled();drop=false;
    await scopes.patch('server',x=>({...x,keys:{...x.keys,openrouter:OLD}}));
    expect(saved).toHaveBeenCalledTimes(1);expect(remote.keys.openrouter).toBe(OLD);
  });
});

it('本机网关环境Key不被错误标成云端或没有Key',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:401})));
  const {adapter}=createAdapter({...cfg,keys:{}},{gateway:{origin:'http://127.0.0.1:8787',keys:['openrouter']}});
  const error=await adapter.stream(req).catch(e=>e);
  expect(error.status).toBe(401);
  expect(error.message).not.toContain('Key 来源');
});
