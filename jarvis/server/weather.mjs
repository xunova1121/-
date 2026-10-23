/** 固定天气上游，不接受任意 URL；天气只做短时缓存，不记录精确定位。 */
import {forecastURL,geocodingURL,validCity} from '../src/core/weather.js';
import {qweatherConfig,fetchQWeather,lookupQWeatherCity} from '../src/core/qweather.js';
/**
 * 和风天气：服务器模式用服务器上存的 Key（qweather()），本机网关用浏览器带来的 Key（请求头 x-qweather-key / x-qweather-host）；
 * 都没有就照旧转发 Open-Meteo。和风的结果原样打包（{source:'qweather',...}），由网页端 parseQWeather 解析
 */
export function createWeatherProxy({fetchImpl=(...a)=>fetch(...a),now=()=>Date.now(),qweather=()=>null}={}){
  const cache=new Map();
  return async(pathname,params,headers={})=>{
    const qw=qweather()||qweatherConfig({qweatherKey:headers['x-qweather-key'],qweatherHost:headers['x-qweather-host']});
    if(qw){
      const key=`qw:${pathname}:${params.toString()}`;const hit=cache.get(key);if(hit&&now()-hit.at<5*60*1000)return hit.data;
      let data;
      if(pathname==='/api/weather/cities'){const q=(params.get('q')||'').trim();if(q.length<2||q.length>80)throw Object.assign(new Error('请输入 2–80 字城市名'),{status:400});data={results:(await lookupQWeatherCity({...qw,query:q,fetchImpl,signal:AbortSignal.timeout(8000)})).map(c=>({name:c.name,latitude:c.latitude,longitude:c.longitude,admin1:c.region}))};}
      else{const lat=Number(params.get('latitude')),lon=Number(params.get('longitude'));if(!validCity({name:'天气',latitude:lat,longitude:lon}))throw Object.assign(new Error('城市坐标无效'),{status:400});try{data=await fetchQWeather({...qw,latitude:lat,longitude:lon,fetchImpl});}catch{throw Object.assign(new Error('和风天气暂不可用，请检查 Key 和 API Host'),{status:502});}}
      if(cache.size>=100)cache.delete(cache.keys().next().value);cache.set(key,{data,at:now()});return data;
    }
    let url;
    if(pathname==='/api/weather/cities'){const q=(params.get('q')||'').trim();if(q.length<2||q.length>80)throw Object.assign(new Error('请输入 2–80 字城市名'),{status:400});url=geocodingURL(q);}
    else{const lat=params.get('latitude'),lon=params.get('longitude');const city={name:'天气',latitude:lat?.trim()?Number(lat):NaN,longitude:lon?.trim()?Number(lon):NaN};if(!validCity(city))throw Object.assign(new Error('城市坐标无效'),{status:400});city.latitude=Math.round(city.latitude*100)/100;city.longitude=Math.round(city.longitude*100)/100;url=forecastURL(city);}
    const cached=cache.get(url);if(cached&&now()-cached.at<5*60*1000)return cached.data;
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});if(!response.ok)throw Object.assign(new Error('天气服务暂不可用'),{status:502});const text=await response.text();if(text.length>100000)throw Object.assign(new Error('天气响应过大'),{status:502});let data;try{data=JSON.parse(text);}catch{throw Object.assign(new Error('天气响应格式不对'),{status:502});}if(data.error)throw Object.assign(new Error('天气查询失败'),{status:502});if(cache.size>=100)cache.delete(cache.keys().next().value);cache.set(url,{data,at:now()});return data;
  };
}
