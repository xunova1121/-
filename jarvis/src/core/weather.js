/** 天气数据与缓存。只在选城市/主动定位后联网，不把示意温度当真实天气。填了和风天气 Key 时用和风（维度多、国内快，见 qweather.js），否则 Open-Meteo。 */
import {fetchQWeather,parseQWeather,lookupQWeatherCity} from './qweather.js';
import {resolveWeatherLocation} from './weatherLocation.js';
export const WEATHER_TTL=15*60*1000;
export const WEATHER_MAX_AGE=48*60*60*1000;
const CITY_KEY='jarvis.weather.city.v1',CACHE_KEY='jarvis.weather.cache.v1';
export const POPULAR_CITIES=[['上海',31.23,121.47],['北京',39.90,116.40],['广州',23.13,113.26],['深圳',22.54,114.06],['杭州',30.27,120.15],['成都',30.57,104.07],['重庆',29.56,106.55],['武汉',30.59,114.31],['南京',32.06,118.80],['西安',34.34,108.94],['苏州',31.30,120.58],['郑州',34.75,113.63]].map(([name,latitude,longitude])=>({name,latitude,longitude}));
export function validCity(city){return !!city&&typeof city.name==='string'&&city.name.trim().length>0&&city.name.length<=80&&typeof city.latitude==='number'&&Number.isFinite(city.latitude)&&Math.abs(city.latitude)<=90&&typeof city.longitude==='number'&&Number.isFinite(city.longitude)&&Math.abs(city.longitude)<=180;}
export const cityKey=city=>`${city.latitude.toFixed(2)},${city.longitude.toFixed(2)}`;
const number=n=>typeof n==='number'&&Number.isFinite(n)?n:null;
export function weatherKind(code){if(code===0||code===1)return{label:code===0?'晴':'晴间多云',icon:'sun'};if(code===2||code===3)return{label:code===2?'多云':'阴',icon:'cloud'};if(code===45||code===48)return{label:'有雾',icon:'fog'};if([51,53,55,56,57].includes(code))return{label:'毛毛雨',icon:'rain'};if([61,63,65,66,67,80,81,82].includes(code))return{label:[65,82].includes(code)?'大雨':'有雨',icon:'rain'};if([71,73,75,77,85,86].includes(code))return{label:'有雪',icon:'snow'};if([95,96,99].includes(code))return{label:'雷雨',icon:'storm'};return{label:'天气概况待更新',icon:'cloud'};}
export function parseWeather(raw,now=Date.now()){
  const current=raw?.current,temp=number(current?.temperature_2m);if(temp===null||temp< -120||temp>80)throw new Error('天气数据不完整，请稍后刷新');
  const daily=raw.daily||{},days=(Array.isArray(daily.time)?daily.time:[]).slice(0,3).map((date,i)=>({date:String(date).slice(0,10),low:number(daily.temperature_2m_min?.[i]),high:number(daily.temperature_2m_max?.[i]),code:number(daily.weather_code?.[i]),rain:number(daily.precipitation_probability_max?.[i])})).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d.date));
  return{source:'open-meteo',...(raw.providerNote && {providerNote:String(raw.providerNote).slice(0,160)}),temp,code:number(current.weather_code),isDay:current.is_day!==0,at:typeof current.time==='string'?current.time.slice(0,19):'',offset:Math.max(-50400,Math.min(50400,number(raw.utc_offset_seconds)??28800)),days,fetchedAt:now};
}
export function weatherAdvice(data,{stale=false,hour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'}).format(new Date()))}={}){
  if(!data)return'把想法交给我，我们一起完成。';if(stale)return'天气暂未更新，出门前再看一眼吧。';const today=data.days?.[0],kind=weatherKind(data.code).icon;
  if(kind==='storm')return'可能有雷雨，出门前留意最新天气提醒。';if(['rain','snow'].includes(kind)||(today?.rain??0)>=50)return kind==='snow'?'路面可能湿滑，出门记得保暖呀。':'可能会下雨，出门记得带把伞呀。';if(kind==='fog')return'能见度可能偏低，出门慢一点呀。';if(data.temp>=30)return'天气有点热，记得喝水、注意防晒呀。';if(data.temp<=10)return'外面有点冷，穿暖和些再出门呀。';if((hour>=17||hour<6)&&today?.low!==null&&today?.low<=18)return'晚上有点凉，出门记得带件外套呀。';return'天气还不错，忙完也记得放松一下呀。';
}
export function forecastURL(city){if(!validCity(city))throw new Error('城市位置无效');const q=new URLSearchParams({latitude:String(city.latitude),longitude:String(city.longitude),current:'temperature_2m,weather_code,is_day',daily:'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max',timezone:'auto',forecast_days:'3'});return`https://api.open-meteo.com/v1/forecast?${q}`;}
export function geocodingURL(query){return`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({name:String(query).trim().slice(0,80),count:'8',language:'zh',format:'json'})}`;}
export function normalizeCities(raw){return(Array.isArray(raw?.results)?raw.results:[]).map(c=>({name:String(c.name||'').slice(0,80),latitude:c.latitude,longitude:c.longitude,...(c.city&&c.district?{city:String(c.city).slice(0,60),district:String(c.district).slice(0,60)}:{}),region:[c.admin1,c.country].filter(Boolean).join(' · ').slice(0,120)})).filter(validCity).slice(0,8);}
export function createWeatherClient({fetchImpl=(...a)=>fetch(...a),storage,direct=true,now=()=>Date.now(),qweather=()=>null,transport=()=>null}={}){
  if(storage===undefined)try{storage=globalThis.localStorage;}catch{storage=null;}
  const read=key=>{try{return JSON.parse(storage?.getItem(key)||'null');}catch{return null;}},write=(key,value)=>{try{storage?.setItem(key,JSON.stringify(value));}catch{}};
  const saved=read(CITY_KEY);let state={city:validCity(saved)?{...saved,...(saved.name==='附近'&&{name:'当前位置'})}:null,data:null,status:'empty',stale:false,error:''},generation=0,selectionRevision=0,request=null,requestKey='';const listeners=new Set();
  const emit=()=>{for(const fn of listeners)fn({...state});};
  // 经网关 / 服务器取天气时带上本机填的和风 Key（服务器模式下服务器有自己的 Key，这里没有就不带）
  const qwHeaders=()=>{const qw=qweather();return qw?{'x-qweather-key':qw.key,'x-qweather-host':qw.host}:{};};
  async function json(url,signal){const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),12000),cancel=()=>ctrl.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)ctrl.abort();try{const response=await fetchImpl(url,{signal:ctrl.signal,...(direct?{}:{headers:qwHeaders()})});if(!response.ok)throw new Error(`天气服务暂不可用（${response.status}）`);return await response.json();}finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}}
  function cache(scope='',any=false){const saved=read(CACHE_KEY),age=now()-(saved?.data?.fetchedAt??0);if((!any&&((saved?.scope||'')!==scope||(scope===''&&qweather()&&saved?.data?.source!=='qweather')))||saved?.key!==cityKey(state.city)||age<0||age>WEATHER_MAX_AGE)return null;try{const d=saved.data;if(typeof d.at!=='string'||typeof d.isDay!=='boolean'||typeof d.temp!=='number'||!Number.isFinite(d.temp)||!Array.isArray(d.days)||!Number.isFinite(d.offset)||!Number.isFinite(d.fetchedAt)||d.temp< -120||d.temp>80||d.days.length>7||d.days.some(day=>!day||!/^\d{4}-\d{2}-\d{2}$/.test(day.date)||['low','high','code','rain'].some(k=>day[k]!==null&&!Number.isFinite(day[k]))))return null;const date=new Date(now()+d.offset*1000).toISOString().slice(0,10);return{data:d,stale:age>WEATHER_TTL||d.days[0]?.date!==date};}catch{return null;}}
  // 当前地点/候选新地点共用原来源链路，换位成功前不把旧温度贴到新地点上。
  async function fetchForCity(city, route, signal) {
    const qw=!route&&direct?qweather():null;
    const raw=route?await route.weather(city,signal):qw?await fetchQWeather({...qw,latitude:city.latitude,longitude:city.longitude,fetchImpl,signal}):await json(direct?forecastURL(city):`/api/weather?${new URLSearchParams({latitude:String(city.latitude),longitude:String(city.longitude)})}`,signal);
    const data=raw?.source==='qweather'?parseQWeather(raw,now()):parseWeather(raw,now());
    if(data.source==='open-meteo'&&!data.providerNote)data.providerNote='和风天气尚未配置完整，当前显示基础天气';
    return data;
  }
  // 无感刷新（用户 2026-11-01）：刷新期间照常显示旧数据；同一城市在另一运行位置的缓存只作刷新期间的占位，失败即丢弃，不当结果
  async function refresh({force=false,keep=false}={}){if(!state.city)return false;const gen=++generation;request?.abort();request=new AbortController();requestKey=cityKey(state.city);const route=transport(),scope=route?.id||'',city={...state.city},cached=cache(scope),placeholder=cached?null:cache(scope,true)?.data||(keep?state.data:null);state={...state,data:cached?.data||placeholder||null,stale:cached?.stale||false,error:'',status:cached||placeholder?'ready':'loading',refreshing:true};emit();if(cached&&!cached.stale&&!force){state={...state,refreshing:false};await resolveLocation(gen,route,request.signal);return true;}
    try{const data=await fetchForCity(city,route,request.signal);if(gen!==generation)return;write(CACHE_KEY,{key:cityKey(city),scope,data});state={city:{...state.city},data,stale:false,error:'',status:'ready',refreshing:false};emit();await resolveLocation(gen,route,request.signal);return true;}
    catch(error){if(gen!==generation)return false;if(keep){state={...state,refreshing:false};return false;}const message=error.status===401?'服务器登录已失效，请重新登录后刷新天气':error.status===502&&route?'服务器天气查询失败，请检查云端和风 Key 与 API Host':'天气暂时连不上，稍后可以重试';state={...state,status:cached?'ready':'error',data:cached?.data||null,stale:!!cached,error:message,refreshing:false};emit();return false;}
  }
  async function resolveLocation(gen, route, signal) {
    const city=state.city;
    if(gen!==generation||signal.aborted)return;
    if(!city||city.source!=='location'||city.district||city.locationResolved||state.data?.source!=='qweather'||(!route&&!qweather()))return;
    try {
      const query=`${city.longitude.toFixed(2)},${city.latitude.toFixed(2)}`;
      const rows=await resolveWeatherLocation(async lookupSignal=>route?normalizeCities(await route.cities(query,lookupSignal)):await lookupQWeatherCity({...qweather(),query,fetchImpl,signal:lookupSignal}),signal);
      if(gen!==generation||signal.aborted||!rows.length)return;
      const found=rows[0], name=found.district?`${found.city} · ${found.district}`:found.name;
      state={...state,city:{...city,name,...(found.city&&{city:found.city}),...(found.district&&{district:found.district}),region:found.region,locationResolved:true}};
      write(CITY_KEY,state.city);emit();
    } catch {
      if(gen===generation&&!signal.aborted){state={...state,locationError:'区县名称暂未解析，已按当前坐标查询天气'};emit();}
    }
  }
  return{get state(){return{...state};},get selectionRevision(){return selectionRevision;},subscribe(fn){listeners.add(fn);fn({...state});return()=>listeners.delete(fn);},refresh,clear(){selectionRevision++;generation++;request?.abort();try{storage?.removeItem(CITY_KEY);storage?.removeItem(CACHE_KEY);}catch{}state={city:null,data:null,status:'empty',stale:false,error:''};emit();},async relocate(city,{signal}={}){
    if(signal?.aborted||!validCity(city))return false;
    const previous={...state},prev=state.city;
    if(prev&&cityKey(prev)===cityKey(city)){
      const name=['当前位置','附近'].includes(city.name)?prev.name:city.name.trim();
      const next={...prev,...city,name,...(!city.district&&prev.district?{district:prev.district}:{}),...(!city.city&&prev.city?{city:prev.city}:{})};
      if(next.name===prev.name&&next.district===prev.district&&next.city===prev.city&&next.source===prev.source)return false;
      // 只补区县不能打断同一坐标正在取的首轮天气；另一个地点的候选仍须取消。
      const keepRequest=state.refreshing&&requestKey===cityKey(prev)&&request&&!request.signal.aborted;
      selectionRevision++;if(!keepRequest){generation++;request?.abort();}
      state={...state,city:next,...(!keepRequest?{refreshing:false}:{}),...(next.district?{locationError:''}:{})};write(CITY_KEY,next);emit();return true;
    }
    const gen=++generation;request?.abort();request=new AbortController();
    const control=request,route=transport(),scope=route?.id||'',next={...city,name:city.name.trim()};
    requestKey=cityKey(next);
    const cancel=()=>control.abort(signal?.reason);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    state={...state,refreshing:true};emit();
    try{
      const data=await fetchForCity(next,route,control.signal);
      control.signal.throwIfAborted();
      if(gen!==generation)return false;
      write(CACHE_KEY,{key:cityKey(next),scope,data});
      selectionRevision++;state={city:next,data,stale:false,error:'',status:'ready',refreshing:false};write(CITY_KEY,next);emit();
      await resolveLocation(gen,route,control.signal);return gen===generation;
    }catch{
      if(gen===generation){state={...previous,refreshing:false};emit();}
      return false;
    }finally{signal?.removeEventListener('abort',cancel);}
  },async select(city){if(!validCity(city))throw new Error('城市位置无效');selectionRevision++;state={city:{...city,name:city.name.trim()},data:null,stale:false,status:'loading',error:''};write(CITY_KEY,state.city);emit();await refresh();},async search(query,signal){const q=String(query).trim();if(q.length<2)return[];const local=POPULAR_CITIES.filter(c=>c.name.includes(q));if(local.length)return local;const route=transport();if(route)return normalizeCities(await route.cities(q,signal));const qw=direct?qweather():null;if(qw)return lookupQWeatherCity({...qw,query:q,fetchImpl,signal});const raw=await json(direct?geocodingURL(q):`/api/weather/cities?${new URLSearchParams({q})}`,signal);return normalizeCities(raw);}};
}
