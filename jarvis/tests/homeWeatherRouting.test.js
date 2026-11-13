import { describe, it, expect, vi } from 'vitest';
import { createHomepageWeather } from '../src/app/homeWeather.js';
import { createServerClient } from '../src/core/serverClient.js';
import { createWeatherProxy } from '../server/weather.mjs';

const store=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
const now=Date.parse('2026-10-30T04:00:00Z');
const city={name:'附近',latitude:32.06,longitude:118.80,source:'location'};
const fallback={current:{temperature_2m:10,weather_code:0,is_day:1,time:'2026-10-30T12:00'},daily:{time:['2026-10-30'],temperature_2m_min:[10],temperature_2m_max:[20],weather_code:[0],precipitation_probability_max:[0]}};
const raw={source:'qweather',now:{now:{temp:'21',icon:'101',text:'多云',obsTime:'2026-10-30T12:00+08:00'}},daily:{daily:[{fxDate:'2026-10-30',tempMin:'14',tempMax:'22',iconDay:'101',textDay:'多云'}]}};

describe('首页天气跟随实际运行位置',()=>{
 it('云Key只在服务器：忽略旧本机基础天气缓存，不把本机Key发给云端，坐标解析到区',async()=>{
  const storage=store();storage.setItem('jarvis.weather.city.v1',JSON.stringify(city));
  storage.setItem('jarvis.weather.cache.v1',JSON.stringify({key:'32.06,118.80',data:{temp:10,code:0,isDay:true,at:'2026-10-30T12:00',offset:28800,days:[{date:'2026-10-30',low:10,high:20,code:0,rain:0}],fetchedAt:now}}));
  const requests=[];
  const server=createServerClient({base:'https://weather.example',token:'auth-fixture',fetchImpl:async(url,init)=>{
   requests.push({url,headers:init.headers});
   return new Response(JSON.stringify(url.includes('/cities?')?{results:[{name:'鼓楼区',city:'南京市',district:'鼓楼区',latitude:32.06,longitude:118.80,admin1:'南京市 · 江苏省'}]}:raw));
  }});
  const direct=vi.fn(()=>{throw Error('不应请求本机或Open-Meteo');});
  const client=createHomepageWeather({getServer:()=>server,getConfig:()=>({qweatherKey:'local-only-key',qweatherHost:'local.re.qweatherapi.com'}),direct:true,fetchImpl:direct,storage,now:()=>now});
  await client.refresh();
  expect(client.state.data).toMatchObject({source:'qweather',temp:21});
  expect(client.state.city).toMatchObject({name:'南京市 · 鼓楼区',district:'鼓楼区',latitude:32.06});
  expect(requests).toHaveLength(2);expect(requests.every(x=>x.headers.Authorization==='Bearer auth-fixture')).toBe(true);
  expect(JSON.stringify(requests)).not.toContain('local-only-key');expect(direct).not.toHaveBeenCalled();
  await client.refresh();expect(requests).toHaveLength(2);
 });
 it('云端未配和风时明确标注原因，不能用本机Key替云端选源',async()=>{
  const server={base:'https://cloud.example',weather:vi.fn(async()=>({...fallback,providerNote:'云服务器未配置完整的和风天气 Key 与 API Host，当前为基础天气'}))};
  const direct=vi.fn();const client=createHomepageWeather({getServer:()=>server,getConfig:()=>({qweatherKey:'local-key',qweatherHost:'a.re.qweatherapi.com'}),direct:true,fetchImpl:direct,storage:store(),now:()=>now});
  await client.select(city);expect(client.state.data.source).toBe('open-meteo');expect(client.state.data.providerNote).toContain('云服务器未配置');expect(direct).not.toHaveBeenCalled();
 });
 it('切换云服务器不能复用另一台的天气缓存；失效登录不能偷偷改直连',async()=>{
  let server={base:'https://first.example',weather:async()=>raw};
  const client=createHomepageWeather({getServer:()=>server,getConfig:()=>({}),direct:true,fetchImpl:()=>{throw Error('禁止直连');},storage:store(),now:()=>now});
  await client.select({...city,source:'manual'});
  server={base:'https://second.example',weather:async()=>{throw Object.assign(Error('登录失效'),{status:401});}};
  await client.refresh();expect(client.state.data).toBeNull();expect(client.state.status).toBe('error');
 });
 it('旧本机模式仍可使用已配置的和风；已知城市不瞎补区名',async()=>{
  const fetchImpl=async(url)=>new Response(JSON.stringify(url.includes('/now?')?raw.now:url.includes('/geo/')?{code:'200',location:[{name:'南京',adm2:'南京',adm1:'江苏',lat:'32.06',lon:'118.80'}]}:{code:'200'}));
  const client=createHomepageWeather({getServer:()=>null,getConfig:()=>({qweatherKey:'k',qweatherHost:'q.re.qweatherapi.com'}),direct:true,storage:store(),fetchImpl,now:()=>now});
  await client.select(city);expect(client.state.data.source).toBe('qweather');expect(client.state.city.name).toBe('南京');expect(client.state.city.district).toBeUndefined();
 });
 it('服务器Geo响应保留真实区县和父城市，不返回天气Key',async()=>{
  const proxy=createWeatherProxy({qweather:()=>({key:'server-only-key',host:'q.re.qweatherapi.com'}),fetchImpl:async()=>new Response(JSON.stringify({code:'200',location:[{name:'鼓楼区',adm2:'南京市',adm1:'江苏省',lat:'32.06',lon:'118.80'}]}))});
  const result=await proxy('/api/weather/cities',new URLSearchParams({q:'118.80,32.06'}));
  expect(result.results[0]).toMatchObject({city:'南京市',district:'鼓楼区'});expect(JSON.stringify(result)).not.toContain('server-only-key');
 });
 it('区县上游不响应时四秒结束，天气仍可看；迟到区名不能覆盖手选位置',async()=>{
  vi.useFakeTimers();
  try {
   let finish;
   const server={base:'https://cloud.example',weather:async()=>raw,weatherCities:()=>new Promise(r=>{finish=r;})};
   const client=createHomepageWeather({getServer:()=>server,getConfig:()=>({}),direct:true,storage:store(),now:()=>now});
   const selecting=client.select(city);
   await vi.advanceTimersByTimeAsync(0);
   expect(client.state.data.temp).toBe(21);
   await vi.advanceTimersByTimeAsync(4000);await selecting;
   expect(client.state.locationError).toContain('区县名称暂未解析');
   await client.select({name:'杭州',latitude:30.27,longitude:120.15});
   finish({results:[{name:'鼓楼区',city:'南京市',district:'鼓楼区',latitude:32.06,longitude:118.80}]});
   await vi.advanceTimersByTimeAsync(0);
   expect(client.state.city.name).toBe('杭州');
  } finally {vi.useRealTimers();}
 });
 it('同一服务器更换和风Key时不复用旧Key的代理缓存',async()=>{
  let key='first-key';const upstream=vi.fn(async()=>new Response(JSON.stringify({code:'200',location:[{name:'南京',adm2:'南京',lat:'32.06',lon:'118.80'}]})));
  const proxy=createWeatherProxy({qweather:()=>({key,host:'q.re.qweatherapi.com'}),fetchImpl:upstream});
  const query=new URLSearchParams({q:'南京'});
  await proxy('/api/weather/cities',query);await proxy('/api/weather/cities',query);
  expect(upstream).toHaveBeenCalledTimes(1);
  key='second-key';await proxy('/api/weather/cities',query);expect(upstream).toHaveBeenCalledTimes(2);
 });
});
