import { describe, it, expect, vi } from 'vitest';
import { boundedIds, catalogKey, favoriteLines, chooseLine, toggleFavorite, toggleBackup, saveCatalog, copyModelSettings, providerLabel } from '../src/llm/modelLibrary.js';
import { createModelScopes, configDelta } from '../src/llm/modelScopes.js';
import { fetchModelCatalog } from '../src/llm/modelCatalog.js';
import { fallbackRoutes } from '../src/llm/router.js';
import { mergeConfig } from '../server/serverMode.mjs';

const base = { provider: 'custom', models: { custom: 'same-model', 'relay-2': 'same-model' }, keys: { custom: 'local-key', 'relay-2': 'other-key' }, baseURLs: { custom: 'https://one.invalid/v1', 'relay-2': 'https://two.invalid/v1' } };

describe('模型库：线路身份和有界配置', () => {
  it('两家同名模型保持独立，选中后只变更对应默认与路由', () => {
    const next = chooseLine(base, { provider: 'relay-2', model: 'same-model' });
    expect(next.provider).toBe('relay-2');
    expect(next.keys).toEqual(base.keys);
    expect(next.baseURLs).toEqual(base.baseURLs);
    expect(favoriteLines(next)).toEqual([{ provider: 'relay-2', model: 'same-model' }, { provider: 'custom', model: 'same-model' }]);
    expect(next.routing.enabled).toBe(false);
    expect(providerLabel({ providerNames: { custom: '我的供应商' } }, 'custom')).toBe('我的供应商');
  });
  it('拉取目录不改默认和分工，只保留有界短型号且换地址淘汰旧缓存', () => {
    const cfg = { ...base, modelLists: { 'custom|https://old.invalid': { ids: ['old'] } } };
    const updated = saveCatalog(cfg, 'custom', ['new', 'new', null, 'x'.repeat(201), ...Array.from({length:1100}, (_,i)=>`m-${i}`)]);
    expect(updated.provider).toBe(base.provider);
    expect(updated.models).toEqual(base.models);
    expect(updated.modelLists[catalogKey(base)].ids).toHaveLength(1000);
    expect(updated.modelLists['custom|https://old.invalid']).toBeUndefined();
    expect(boundedIds(['a','a',3,''])).toEqual(['a']);
  });
  it('常用最多24条，不自动收藏几百个型号', () => {
    let cfg = base;
    for (let i=0;i<30;i++) cfg = toggleFavorite(cfg, {provider:'custom',model:`m-${i}`});
    expect(favoriteLines(cfg)).toHaveLength(24);
    expect(favoriteLines(saveCatalog(base, 'custom', ['a','b']))).toHaveLength(1);
  });
  it('服务器合并也淘汰旧地址缓存并限制每家目录，保留另一家当前目录', () => {
    const old={...base,modelLists:{[catalogKey(base)]:{ids:['old']},[catalogKey(base,'relay-2')]:{ids:['other']}}};
    const next={baseURLs:{custom:'https://new.invalid/v1'},modelLists:{'custom|https://new.invalid/v1':{ids:Array.from({length:1200},(_,i)=>`model-${i}`)}}};
    const merged=mergeConfig(old,next);
    expect(merged.modelLists[catalogKey(base)]).toBeUndefined();
    expect(merged.modelLists['custom|https://new.invalid/v1'].ids).toHaveLength(1000);
    expect(merged.modelLists[catalogKey(base,'relay-2')].ids).toEqual(['other']);
  });
  it('明确备用只用指定顺序，不混进分工或其他服务商，空列表关闭自动切换', () => {
    let cfg=toggleBackup(base,{provider:'relay-2',model:'same-model'});
    cfg=toggleBackup(cfg,{provider:'custom',model:'backup'});
    expect(fallbackRoutes(cfg,current(base)).map(line=>`${line.provider}/${line.model}`)).toEqual(['relay-2/same-model','custom/backup']);
    expect(()=>toggleBackup(cfg,{provider:'deepseek',model:'deepseek-chat'})).toThrow('最多两条');
    expect(fallbackRoutes({...cfg,fallbackModels:[]},current(base))).toEqual([]);
    expect(chooseLine(cfg,{provider:'relay-2',model:'same-model'}).fallbackModels).toEqual([{provider:'custom',model:'backup'}]);
  });
  it('复制不带声音、搜索凭据或服务端密钥掩码', () => {
    const copy=copyModelSettings({...base,keys:{custom:'••••1234','relay-2':'real-key'},voice:{engine:'edge'},tavilyKey:'search-key'});
    expect(copy.keys).toEqual({'relay-2':'real-key'});
    expect(copy.voice).toBeUndefined();
    expect(copy.tavilyKey).toBeUndefined();
    expect(copy.routing.enabled).toBe(false);
    expect(copy.fallbackPolicy).toBe('legacy');
  });
});
function current(cfg){return {provider:cfg.provider,model:cfg.models[cfg.provider]};}

describe('配置位置：不自动交叉覆盖', () => {
  it('服务器修改不写本机，局部写入不携带未变密钥', async () => {
    let local=structuredClone(base);
    let remote={...structuredClone(base),keys:{custom:'••••7890'}};
    const puts=[];
    const scopes=createModelScopes({getLocal:()=>local,saveLocal:cfg=>(local=cfg),getClient:()=>({getConfig:async()=>structuredClone(remote),putConfig:async patch=>{puts.push(patch);remote=mergeConfig(remote,patch);}})});
    await scopes.patch('server',cfg=>chooseLine(cfg,{provider:'custom',model:'remote-model'}));
    expect(local).toEqual(base);
    expect(puts[0].keys).toBeUndefined();
    expect(remote.models['relay-2']).toBe('same-model');
    await scopes.patch('local',cfg=>chooseLine(cfg,{provider:'custom',model:'local-model'}));
    expect(remote.models.custom).toBe('remote-model');
    expect(local.models.custom).toBe('local-model');
  });
  it('连续修改串行执行，第一次保存失败后仍可重试，不提前显示成功', async () => {
    let remote=structuredClone(base);
    let count=0;
    const saved=vi.fn();
    const scopes=createModelScopes({getLocal:()=>base,saveLocal:vi.fn(),onServerSaved:saved,getClient:()=>({getConfig:async()=>structuredClone(remote),putConfig:async delta=>{if(++count===1)throw Object.assign(new Error('离线'),{kind:'network'});remote=mergeConfig(remote,delta);}})});
    await expect(scopes.patch('server',cfg=>({...cfg,fallbackPolicy:'explicit'}))).rejects.toThrow('离线');
    expect(saved).not.toHaveBeenCalled();
    await Promise.all([scopes.patch('server',cfg=>({...cfg,fallbackPolicy:'explicit'})),scopes.patch('server',cfg=>toggleBackup(cfg,{provider:'relay-2',model:'same-model'}))]);
    expect(remote.fallbackPolicy).toBe('explicit');
    expect(remote.fallbackModels).toHaveLength(1);
    expect(saved).toHaveBeenCalledTimes(2);
  });
  it('服务器未连接明确报错，更新一个服务商保留另一家的配置', async () => {
    const scopes=createModelScopes({getLocal:()=>base,saveLocal:vi.fn(),getClient:()=>null});
    await expect(scopes.refresh('server')).rejects.toMatchObject({code:'SERVER_NOT_CONNECTED'});
    expect(configDelta(base,{...base,models:{...base.models,custom:'new'}})).toEqual({models:{custom:'new'}});
    expect(mergeConfig(base,{models:{custom:'new'},keys:{custom:'••••1234'},baseURLs:{custom:'https://new.invalid/v1'}})).toMatchObject({models:{custom:'new','relay-2':'same-model'},keys:base.keys,baseURLs:{'relay-2':'https://two.invalid/v1'}});
  });
  it('迟到的旧读取不能覆盖已经保存的新服务器快照', async () => {
    let remote=structuredClone(base);
    let reads=0;
    let resolveOld;
    const scopes=createModelScopes({getLocal:()=>base,saveLocal:vi.fn(),getClient:()=>({getConfig:async()=>{reads++;if(reads===2)return new Promise(resolve=>{resolveOld=resolve;});return structuredClone(remote);},putConfig:async delta=>{remote=mergeConfig(remote,delta);}})});
    await scopes.refresh('server');
    const oldRead=scopes.refresh('server');
    await Promise.resolve();
    await Promise.resolve();
    await scopes.patch('server',cfg=>chooseLine(cfg,{provider:'custom',model:'new-model'}));
    resolveOld(structuredClone(base));
    await oldRead;
    expect(scopes.get('server').models.custom).toBe('new-model');
  });
});

describe('拉取模型：真实结果、类型和取消', () => {
  it('使用所选服务商地址和密钥，兼容多协议与原生Claude', async () => {
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({data:[{id:'m1'},{id:'m1'},{id:'m2'}]})));
    expect((await fetchModelCatalog({...base,provider:'relay-2'},{fetchImpl})).ids).toEqual(['m1','m2']);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://two.invalid/v1/models');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer other-key');
    await fetchModelCatalog({...base,provider:'anthropic',keys:{anthropic:'claude-key'}},{fetchImpl});
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/models');
    expect(fetchImpl.mock.calls[1][1].headers['x-api-key']).toBe('claude-key');
  });
  it('鉴权、断网、格式错误不伪装成成功或额度不足', async () => {
    await expect(fetchModelCatalog(base,{fetchImpl:async()=>new Response('secret response',{status:401})})).rejects.toMatchObject({status:401,code:'CATALOG_API'});
    await expect(fetchModelCatalog(base,{fetchImpl:async()=>{throw new TypeError('fetch failed');}})).rejects.toMatchObject({kind:'network',code:'CATALOG_NETWORK'});
    await expect(fetchModelCatalog(base,{fetchImpl:async()=>new Response('<html>login</html>')})).rejects.toMatchObject({code:'CATALOG_FORMAT'});
    await expect(fetchModelCatalog(base,{fetchImpl:async()=>new Response('{}')})).rejects.toMatchObject({code:'CATALOG_UNSUPPORTED'});
  });
  it('预停止不发请求，拉取期间停止保留AbortError', async () => {
    const controller=new AbortController();
    controller.abort();
    const fetchImpl=vi.fn();
    await expect(fetchModelCatalog(base,{signal:controller.signal,fetchImpl})).rejects.toMatchObject({name:'AbortError'});
    expect(fetchImpl).not.toHaveBeenCalled();
    const live=new AbortController();
    const pending=fetchModelCatalog(base,{signal:live.signal,fetchImpl:async(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('abort'),{name:'AbortError'})),{once:true}))});
    live.abort();
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
  });
  it('列表正文上限2MB并取消流，不能持续吞入大响应', async () => {
    const cancel=vi.fn();
    const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1));},cancel});
    await expect(fetchModelCatalog(base,{fetchImpl:async()=>new Response(stream)})).rejects.toMatchObject({code:'CATALOG_SIZE'});
    expect(cancel).toHaveBeenCalled();
  });
  it('10秒拉取超时有明确类型，预算控制信号不被改写', async () => {
    const budget=Object.assign(new Error('budget'),{code:'RETRIEVAL_BUDGET'});
    await expect(fetchModelCatalog(base,{fetchImpl:async()=>{throw budget;}})).rejects.toBe(budget);
    vi.useFakeTimers();
    try {
      const pending=fetchModelCatalog(base,{fetchImpl:async(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('abort'),{name:'AbortError'})),{once:true}))});
      const checked=expect(pending).rejects.toMatchObject({name:'TimeoutError',kind:'timeout',code:'CATALOG_TIMEOUT'});
      await vi.advanceTimersByTimeAsync(10000);
      await checked;
    } finally {vi.useRealTimers();}
  });
});
