import {it,expect,vi} from 'vitest';
import {createStockImages} from '../server/stockImages.mjs';
import {stockCandidates,stockMediaUrl,genericStockQuery} from '../src/agent/stockImageSources.js';
import {maskConfig,mergeConfig} from '../server/serverMode.mjs';
const photo={id:1,src:{large:'https://images.pexels.com/photos/1/test.jpg'},url:'https://www.pexels.com/photo/1',photographer:'Author',photographer_url:'https://www.pexels.com/@author'};
const health={get:async()=>({}),record:async()=>{}};
it('图库密钥掩码、保留、更新后失效；客户端不能伪造通过',()=>{
 const cfg={pexelsKey:'private-secret',stockVerified:{pexels:{ok:true}}};
 expect(maskConfig(cfg).pexelsKey).toBe('••••cret');
 expect(mergeConfig(cfg,{pexelsKey:'••••cret',stockVerified:{pixabay:{ok:true}}}).stockVerified).toEqual(cfg.stockVerified);
 expect(mergeConfig(cfg,{pexelsKey:'new-secret'}).stockVerified.pexels).toBeUndefined();
});
it('只接受固定CDN与逐张许可；任意英文人名不变成图库查询',()=>{
 expect(stockMediaUrl('https://images.pexels.com.evil.test/a')).toBeNull();
 expect(stockMediaUrl('https://key@images.pexels.com/a')).toBeNull();
 expect(stockCandidates('openverse',{results:[{license:'by-nc',url:photo.src.large}]})).toEqual([]);
 expect(stockCandidates('pexels',{photos:[photo]})).toHaveLength(1);
 expect(genericStockQuery('Lionel Messi portrait')).toBe('');
});
it('没有国内实测不请求图库；探测不使用缓存',async()=>{
 let cfg={pexelsKey:'secret'};const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({photos:[photo]})));
 const api=createStockImages({getConfig:()=>cfg,fetchImpl,health});
 expect((await api.search({query:'football',provider:'pexels'})).items).toEqual([]);expect(fetchImpl).not.toHaveBeenCalled();
 await api.search({query:'football',provider:'pexels',probe:true});
 await api.search({query:'football',provider:'pexels',probe:true});expect(fetchImpl).toHaveBeenCalledTimes(2);
 cfg={...cfg,stockVerified:{pexels:{ok:true}}};
 await api.search({query:'football',provider:'pexels'});expect(fetchImpl).toHaveBeenCalledTimes(2);
 expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('secret');
});
it('无识图能力不盲用第一张；取消不吞',async()=>{
 const fetchImpl=vi.fn();const api=createStockImages({getConfig:()=>({}),fetchImpl,health});
 expect(await api.forSlide({query:'football'})).toBeNull();expect(fetchImpl).not.toHaveBeenCalled();
 const controller=new AbortController();controller.abort();
 await expect(api.download({url:photo.src.large},{signal:controller.signal})).rejects.toBeDefined();
});
