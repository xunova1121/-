/** 只用官方API。许可/条款截至2026-10-31；不是“搜索到图片即可随便商用”。
 * Pexels: https://www.pexels.com/api/documentation/ 和 /license/，API默认200/h、20000/月，署名与链接保留。
 * Pixabay: https://pixabay.com/api/docs/ 和 /service/license-summary/，默认100/60s，API结果缓存24h，不热链。
 * Unsplash: https://unsplash.com/documentation 和 /api-terms，开发50/h，署名、作者链接、触发download_location。
 * Openverse: https://api.openverse.org/v1/，逐张CC0/CC BY/CC BY-SA，保留许可证/来源；不接NC/ND或维基图片。
 */
export const STOCK_PROVIDERS = ['pexels','pixabay','unsplash','openverse'];
export const STOCK_KEY_FIELDS = ['pexelsKey','pixabayKey','unsplashKey'];
const mediaHosts = new Set(['images.pexels.com','cdn.pixabay.com','pixabay.com','images.unsplash.com','live.staticflickr.com']);
export function stockMediaUrl(value) {
  try { const url=new URL(value); return url.protocol==='https:' && !url.username && !url.password && !url.port && mediaHosts.has(url.hostname) ? url.href : null; } catch { return null; }
}
const safeLink = value => {try {const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password ? url.href : '';}catch{return '';}};
export const genericStockQuery = request => {
  const scenes = [[/足球|球场|赛程|football|stadium/i,'empty football stadium'],[/农业|农田|agriculture|field/i,'agriculture field'],[/医疗|医院|hospital/i,'hospital building'],[/城市|city|skyline/i,'city skyline'],[/办公|商务|会议|office|workspace/i,'office workspace'],[/教育|学校|classroom/i,'classroom']];
  return scenes.find(([pattern]) => pattern.test(request))?.[1] || '';
};
export const sensitiveStockRequest = request => /真实人物|具体人物|新闻现场|赛事现场|球员照片|明星照片|肖像|梅西|C罗|习近平|特朗普|(?:real|specific)\s+(?:person|player)|news\s+photo/i.test(request);
export function stockRequest(provider, query, cfg) {
  const term=encodeURIComponent(query);
  if(provider==='pexels') return {url:`https://api.pexels.com/v1/search?query=${term}&per_page=4`,headers:{Authorization:cfg.pexelsKey}};
  if(provider==='pixabay') return {url:`https://pixabay.com/api/?key=${encodeURIComponent(cfg.pixabayKey)}&q=${term}&image_type=photo&safesearch=true&per_page=3`,headers:{}};
  if(provider==='unsplash') return {url:`https://api.unsplash.com/search/photos?query=${term}&per_page=3&content_filter=high`,headers:{Authorization:`Client-ID ${cfg.unsplashKey}`}};
  return {url:`https://api.openverse.org/v1/images/?q=${term}&license=cc0,by,by-sa&page_size=5`,headers:{}};
}
export function stockCandidates(provider, data) {
  const candidates=provider==='pexels' ? (data.photos || []).map(item=>({id:item.id,url:item.src?.large,imagePage:item.url,author:item.photographer,authorUrl:item.photographer_url,license:'Pexels License',licenseUrl:'https://www.pexels.com/license/'}))
    : provider==='pixabay' ? (data.hits || []).map(item=>({id:item.id,url:item.webformatURL,imagePage:item.pageURL,author:item.user,authorUrl:`https://pixabay.com/users/${item.user_id}/`,license:'Pixabay Content License',licenseUrl:'https://pixabay.com/service/license-summary/'}))
    : provider==='unsplash' ? (data.results || []).map(item=>({id:item.id,url:item.urls?.regular,imagePage:item.links?.html,author:item.user?.name,authorUrl:item.user?.links?.html,download:item.links?.download_location,license:'Unsplash License',licenseUrl:'https://unsplash.com/license'}))
    : (data.results || []).filter(item=>['cc0','by','by-sa'].includes(item.license)).map(item=>({id:item.id,url:item.url,imagePage:item.foreign_landing_url,author:item.creator,authorUrl:item.creator_url,license:`CC ${item.license.toUpperCase()} ${item.license_version || ''}`,licenseUrl:item.license_url}));
  return candidates.filter(item=>stockMediaUrl(item.url) && safeLink(item.imagePage) && safeLink(item.licenseUrl) && typeof item.author==='string' && item.author.trim()).slice(0,3).map(item=>({...item,provider,id:String(item.id).slice(0,100),url:stockMediaUrl(item.url),imagePage:safeLink(item.imagePage),author:item.author.slice(0,100),authorUrl:safeLink(item.authorUrl),licenseUrl:safeLink(item.licenseUrl)}));
}
export const stockCredit = item => `${item.author} / ${item.provider}；${item.license} ${item.licenseUrl}；原图 ${item.imagePage}；作者 ${item.authorUrl || item.imagePage}`;
