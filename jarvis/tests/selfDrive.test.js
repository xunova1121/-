import {describe,it,expect} from 'vitest';
import * as agent from '../src/agent/agent.js';
import {createRetrievalBudget} from '../src/agent/lookup/clock.js';
import {selfDriveNote,triedSummary,SELF_DRIVE_MS} from '../src/agent/lookup/selfDrive.js';
import {recentWorkLog} from '../src/agent/failedSteps.js';
import {provinceCapital} from '../src/agent/weather.js';
// 用户 2026-11-01：“未央连自己编排的能力都没有吗”——快查失败不能到点收工，要交给模型自己换办法
const ctx={memory:'',lessons:[],skills:[],summary:null,dynamic:''};
const call=(id,name,args={})=>({id,name,args});
describe('自主编排',()=>{
  it('预算放宽：去掉连续失败与次数门槛，从现在起再给两分钟',()=>{
    let t=0;const b=createRetrievalBudget('菏泽天气',{now:()=>t});
    for(let i=0;i<3;i++){b.begin();b.end(false);}
    expect(b.reason).toContain('连续 3 次');
    b.extend(SELF_DRIVE_MS);
    expect(b.reason).toBe('');expect(b.extensive).toBe(true);
    t+=SELF_DRIVE_MS-1000;expect(b.reason).toBe('');
    t+=2000;expect(b.reason).toContain('时间预算');
  });
  it('交给模型的话写清真实失败经过、给可试的网页，并禁止编造原因',()=>{
    const tried=triedSummary({recovery:{attempts:[{label:'天气查询',failure:'transient'},{label:'公开搜索',failure:'cooling'}]},calls:[{name:'web_search',args:{query:'菏泽天气'},ok:false,output:'错误：请求超时'}]});
    expect(tried).toContain('天气查询：连接超时或不稳定');expect(tried).toContain('搜索“菏泽天气”：超时');
    const note=selfDriveNote({kind:'weather',place:'菏泽',tried});
    expect(note).toContain('已经试过');expect(note).toContain('baidu.com/s?wd=');expect(note).toContain('至少换两种');expect(note).toContain('不要编造原因');
  });
  it('普通查询一条结果都没拿到就到点：不收工，交回模型接着查，换办法后查到',async()=>{
    let t=0,n=0;const events=[],seen=[];
    const tools=[
      {name:'web_search',description:'x',input_schema:{type:'object',properties:{query:{type:'string'}}},run:async()=>{t+=50_000;throw new Error('请求超时');}},
      {name:'fetch_url',description:'x',input_schema:{type:'object',properties:{url:{type:'string'}}},run:async()=>'菏泽 今天 阴 5～18℃ 来源：中央气象台'}
    ];
    const adapter={async stream({messages,onText,allowWebSearch}){
      n++;seen.push({allowWebSearch,last:String(messages.at(-1).content)});
      if(n===1)return {text:'',toolCalls:[call('a','web_search',{query:'菏泽天气'})],stop:'tool_use'};
      if(n===2){expect(allowWebSearch).toBe(true);return {text:'',toolCalls:[call('b','fetch_url',{url:'https://www.nmc.cn/publish/forecast/ASD/heze.html'})],stop:'tool_use'};}
      onText('菏泽今天阴，5～18℃（中央气象台）。');return {text:'菏泽今天阴，5～18℃（中央气象台）。',toolCalls:[],stop:'end_turn'};
    }};
    const r=await agent.runAgent({adapter,model:'m',history:[],userText:'菏泽天气怎么样',tools,context:ctx,emit:e=>events.push(e),now:()=>t});
    expect(r.text).toContain('5～18℃');
    expect(events.some(e=>e.type==='tool_progress'&&/换办法接着查/.test(e.text))).toBe(true);
    expect(seen[1].last).toContain('已经试过');expect(seen[1].last).toContain('菏泽天气');
  });
  it('执行记录带耗时和失败原话，并规定问原因只按记录答',()=>{
    const log=recentWorkLog([{role:'user',content:'菏泽天气'},{role:'assistant',content:'没查到',ts:Date.parse('2026-11-01T04:55:31Z'),timing:{totalMs:34000,firstTextMs:33000,toolCalls:3,failedTools:3},failures:[{tool:'get_weather',error:'天气接口、公开搜索都没取得可用结果（连接超时）'}]}]);
    expect(log).toContain('12:55:31');expect(log).toContain('总耗时34.0秒');expect(log).toContain('get_weather：天气接口');expect(log).toContain('不许猜测');
    expect(recentWorkLog([{role:'assistant',content:'好'}])).toBe('');
  });
  it('问省份天气按省会查，吉林等同名城市不改',()=>{
    expect(provinceCapital('河南')).toBe('郑州');expect(provinceCapital('广西壮族自治区')).toBe('南宁');expect(provinceCapital('江苏省')).toBe('南京');
    expect(provinceCapital('吉林')).toBe('');expect(provinceCapital('菏泽')).toBe('');expect(provinceCapital('北京')).toBe('');
  });
});
import {getWeather} from '../src/agent/weather.js';
describe('天气源冷却',()=>{
  const health=(cool)=>({get:async id=>({cooling:cool.includes(id)}),record:async()=>{}});
  const openMeteo=async url=>({ok:true,json:async()=>url.includes('geocoding')?{results:[{name:'郑州',latitude:34.7,longitude:113.6,country:'中国'}]}:{current:{temperature_2m:15,apparent_temperature:13,relative_humidity_2m:60,weather_code:3,wind_speed_10m:10,precipitation:0},daily:{time:['2026-11-01'],weather_code:[3],temperature_2m_max:[18],temperature_2m_min:[6],precipitation_probability_max:[10]}}});
  it('全部冷却时照样真试，不再“装死”30分钟；问省份写明按省会查',async()=>{
    const text=await getWeather('河南',{get:openMeteo,health:health(['weather_openmeteo','weather_wttr'])});
    expect(text).toContain('省会郑州');expect(text).toContain('6～18');expect(text).toContain('Open-Meteo');
  });
  it('还有没冷却的来源时，冷却的照旧跳过',async()=>{
    const urls=[];const get=async url=>{urls.push(url);return openMeteo(url);};
    const text=await getWeather('郑州',{get,health:health(['weather_openmeteo'])});
    expect(urls.some(u=>u.includes('open-meteo'))).toBe(false);expect(text).toContain('wttr');
  });
});
