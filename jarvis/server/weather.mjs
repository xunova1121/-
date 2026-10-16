/** 固定天气上游，不接受任意 URL；天气只做短时缓存，不记录精确定位。 */
import {forecastURL,geocodingURL,validCity} from '../src/core/weather.js';
export function createWeatherProxy({fetchImpl=(...a)=>fetch(...a),now=()=>Date.now()}={}){
  const cache=new Map();
  return async(pathname,params)=>{
    let url;
    if(pathname==='/api/weather/cities'){const q=(params.get('q')||'').trim();if(q.length<2||q.length>80)throw Object.assign(new Error('请输入 2–80 字城市名'),{status:400});url=geocodingURL(q);}
    else{const lat=params.get('latitude'),lon=params.get('longitude');const city={name:'天气',latitude:lat?.trim()?Number(lat):NaN,longitude:lon?.trim()?Number(lon):NaN};if(!validCity(city))throw Object.assign(new Error('城市坐标无效'),{status:400});city.latitude=Math.round(city.latitude*100)/100;city.longitude=Math.round(city.longitude*100)/100;url=forecastURL(city);}
    const cached=cache.get(url);if(cached&&now()-cached.at<5*60*1000)return cached.data;
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});if(!response.ok)throw Object.assign(new Error('天气服务暂不可用'),{status:502});const text=await response.text();if(text.length>100000)throw Object.assign(new Error('天气响应过大'),{status:502});let data;try{data=JSON.parse(text);}catch{throw Object.assign(new Error('天气响应格式不对'),{status:502});}if(data.error)throw Object.assign(new Error('天气查询失败'),{status:502});if(cache.size>=100)cache.delete(cache.keys().next().value);cache.set(url,{data,at:now()});return data;
  };
}
