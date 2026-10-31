#!/usr/bin/env node
// Generated adapter snapshot. Regenerate with scripts/build-stock-probe.mjs after source changes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
/** 只用官方API。许可/条款截至2026-10-31；不是“搜索到图片即可随便商用”。
 * Pexels: https://www.pexels.com/api/documentation/ 和 /license/，API默认200/h、20000/月，署名与链接保留。
 * Pixabay: https://pixabay.com/api/docs/ 和 /service/license-summary/，默认100/60s，API结果缓存24h，不热链。
 * Unsplash: https://unsplash.com/documentation 和 /api-terms，开发50/h，署名、作者链接、触发download_location。
 * Openverse: https://api.openverse.org/v1/，逐张CC0/CC BY/CC BY-SA，保留许可证/来源；不接NC/ND或维基图片。
 */
const STOCK_PROVIDERS = ['pexels','pixabay','unsplash','openverse'];
const STOCK_KEY_FIELDS = ['pexelsKey','pixabayKey','unsplashKey'];
const mediaHosts = new Set(['images.pexels.com','cdn.pixabay.com','pixabay.com','images.unsplash.com','live.staticflickr.com']);
function stockMediaUrl(value) {
  try { const url=new URL(value); return url.protocol==='https:' && !url.username && !url.password && !url.port && mediaHosts.has(url.hostname) ? url.href : null; } catch { return null; }
}
const safeLink = value => {try {const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password ? url.href : '';}catch{return '';}};
const genericStockQuery = request => {
  const scenes = [[/足球|球场|赛程|football|stadium/i,'empty football stadium'],[/农业|农田|agriculture|field/i,'agriculture field'],[/医疗|医院|hospital/i,'hospital building'],[/城市|city|skyline/i,'city skyline'],[/办公|商务|会议|office|workspace/i,'office workspace'],[/教育|学校|classroom/i,'classroom']];
  return scenes.find(([pattern]) => pattern.test(request))?.[1] || '';
};
const sensitiveStockRequest = request => /真实人物|具体人物|新闻现场|赛事现场|球员照片|明星照片|肖像|梅西|C罗|习近平|特朗普|(?:real|specific)\s+(?:person|player)|news\s+photo/i.test(request);
function stockRequest(provider, query, cfg) {
  const term=encodeURIComponent(query);
  if(provider==='pexels') return {url:`https://api.pexels.com/v1/search?query=${term}&per_page=4`,headers:{Authorization:cfg.pexelsKey}};
  if(provider==='pixabay') return {url:`https://pixabay.com/api/?key=${encodeURIComponent(cfg.pixabayKey)}&q=${term}&image_type=photo&safesearch=true&per_page=3`,headers:{}};
  if(provider==='unsplash') return {url:`https://api.unsplash.com/search/photos?query=${term}&per_page=3&content_filter=high`,headers:{Authorization:`Client-ID ${cfg.unsplashKey}`}};
  return {url:`https://api.openverse.org/v1/images/?q=${term}&license=cc0,by,by-sa&page_size=5`,headers:{}};
}
function stockCandidates(provider, data) {
  const candidates=provider==='pexels' ? (data.photos || []).map(item=>({id:item.id,url:item.src?.large,imagePage:item.url,author:item.photographer,authorUrl:item.photographer_url,license:'Pexels License',licenseUrl:'https://www.pexels.com/license/'}))
    : provider==='pixabay' ? (data.hits || []).map(item=>({id:item.id,url:item.webformatURL,imagePage:item.pageURL,author:item.user,authorUrl:`https://pixabay.com/users/${item.user_id}/`,license:'Pixabay Content License',licenseUrl:'https://pixabay.com/service/license-summary/'}))
    : provider==='unsplash' ? (data.results || []).map(item=>({id:item.id,url:item.urls?.regular,imagePage:item.links?.html,author:item.user?.name,authorUrl:item.user?.links?.html,download:item.links?.download_location,license:'Unsplash License',licenseUrl:'https://unsplash.com/license'}))
    : (data.results || []).filter(item=>['cc0','by','by-sa'].includes(item.license)).map(item=>({id:item.id,url:item.url,imagePage:item.foreign_landing_url,author:item.creator,authorUrl:item.creator_url,license:`CC ${item.license.toUpperCase()} ${item.license_version || ''}`,licenseUrl:item.license_url}));
  return candidates.filter(item=>stockMediaUrl(item.url) && safeLink(item.imagePage) && safeLink(item.licenseUrl) && typeof item.author==='string' && item.author.trim()).slice(0,3).map(item=>({...item,provider,id:String(item.id).slice(0,100),url:stockMediaUrl(item.url),imagePage:safeLink(item.imagePage),author:item.author.slice(0,100),authorUrl:safeLink(item.authorUrl),licenseUrl:safeLink(item.licenseUrl)}));
}
const stockCredit = item => `${item.author} / ${item.provider}；${item.license} ${item.licenseUrl}；原图 ${item.imagePage}；作者 ${item.authorUrl || item.imagePage}`;

const args=process.argv.slice(2),provider=args.find(a=>a.startsWith('--provider='))?.slice(11)||'openverse';
if(!STOCK_PROVIDERS.includes(provider)||!args.includes('--network=cn'))throw new Error('指定 --network=cn，provider仅限官方图库；网络地区为执行者声明');
const cfgPath=args.find(a=>a.startsWith('--config='))?.slice(9)||'/opt/jarvis/data/config.json';
let cfg={};try{cfg=JSON.parse(await fs.readFile(cfgPath,'utf8'));}catch{}
const started=Date.now(),report={provider,network:'cn_declared',modelRequested:false,productionChanged:false};
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'weiyang-stock-probe-'));
async function limited(url,options,limit){
 const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('HTTP '+response.status);
 if(Number(response.headers.get('content-length'))>limit)throw new Error('内容超过上限');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new Error('内容超过上限');chunks.push(chunk);}return Buffer.concat(chunks);
}
try{
 if(provider!=='openverse'&&!cfg[provider+'Key'])throw new Error('服务器未配置所选图库Key；不要把Key发到对话');
 const request=stockRequest(provider,'empty football stadium',cfg),response=await limited(request.url,{headers:request.headers},1000000);
 report.apiMs=Date.now()-started;
 const candidate=stockCandidates(provider,JSON.parse(response.toString()))[0];
 if(!candidate)throw new Error('没有许可完整、域名受信的候选');
 const bytes=await limited(candidate.url,{},8000000);
 const png=bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a',jpg=bytes[0]===255&&bytes[1]===216;
 if(!png&&!jpg)throw new Error('下载不是PNG/JPEG');
 if(provider==='unsplash'){
  const tracking=new URL(candidate.download);if(tracking.origin!=='https://api.unsplash.com'||!/^\/photos\/[^/]+\/download$/.test(tracking.pathname))throw new Error('下载回报地址不合法');
  await limited(tracking.href,{headers:{Authorization:'Client-ID '+cfg.unsplashKey}},100000);
 }
 const file='sample.'+(png?'png':'jpg');await fs.writeFile(path.join(dir,file),bytes,{mode:0o600});
 Object.assign(report,{state:'passed_connectivity',bytes:bytes.length,sample:file,credit:stockCredit(candidate),note:'仅接口、下载和许可字段连通；PPT配图与视觉仍需验收'});
}catch(error){report.state='failed';report.reason=/HTTP \d+|上限|Key|候选|PNG|回报/.test(error.message)?error.message:'请求失败或超时';process.exitCode=1;}
report.elapsedMs=Date.now()-started;
await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report,null,2));console.log('报告目录：'+dir);
