import {it,expect} from 'vitest';
import {PPT_ICON_CATALOG} from '../src/agent/pptIconCatalog.js';
import {ICON_PNG,ICON_DARK_PNG} from '../src/agent/pptIcons.js';
import {iconPicker,parseSlides,makePptx} from '../src/agent/pptxWriter.js';
import {imageInfo} from '../src/agent/imageInfo.js';
import {THEMES} from '../src/agent/themes.js';
import {pptIconCatalogTool} from '../src/agent/pptIconCatalogTool.js';
it('238图标两种颜色全为可解码PNG，总量有上限',()=>{
 expect(Object.keys(PPT_ICON_CATALOG).length).toBeGreaterThanOrEqual(200);
 expect(Object.keys(PPT_ICON_CATALOG).length).toBeLessThanOrEqual(300);
 let bytes=0;
 for(const name of Object.keys(PPT_ICON_CATALOG)) for(const bank of [ICON_PNG,ICON_DARK_PNG]) {const raw=Uint8Array.from(Buffer.from(bank[name],'base64'));expect(imageInfo(raw)).toMatchObject({type:'png',width:96,height:96});bytes+=raw.length;}
 expect(bytes).toBeLessThan(1600000);
});
it('体育兜底与模型指定图标，同页选择不重复',async()=>{
 expect(iconPicker()('足球赛程')).toBe('volleyball');
 const picker=iconPicker(['dna','brain']); expect(picker('词表外概念')).toBe('dna');expect(picker('词表外概念')).toBe('brain');
 const pages=parseSlides('概念','## 概念\n\n图标：dna, brain\n\n- 20 个：试验\n- 7 个：项目');expect(pages[0].iconNames).toEqual(['dna','brain']);
 expect((await pptIconCatalogTool.run({topic:'体育'}))).toContain('volleyball');
 for(const style of ['business','minimal','data']) {
  const out=await makePptx({title:'概念',content:'## 概念\n\n图标：dna, brain\n\n- 20 个：试验\n- 7 个：项目',theme:THEMES.business,style,forbidCover:true});
  expect(out.info.preview[0].items.filter(item=>item.kind==='image')).toHaveLength(2);
 }
});
