import {it,expect} from 'vitest';
import {generate} from '../src/agent/docs.js';
import {planTablePages,tidyPresentationPunctuation} from '../src/agent/presentationLayoutPlan.js';
import {parseSlides} from '../src/agent/pptxWriter.js';
import {openOfficePackage} from '../src/agent/officePackage.js';
import {inspectPresentation} from '../src/agent/presentationReceipt.js';
const rows=Array.from({length:20},(_,i)=>`|18:${String(i).padStart(2,'0')}|甲${i}—乙${i}|`).join('\n');
it('20行表格真实两页，行完整且字号不降到12以下',async()=>{
 const out=await generate('pptx',{title:'赛程',forbidCover:true,content:'## 赛程\n版式：表格\n\n| 时间 | 对阵 |\n|--|--|\n'+rows});
 const zip=await openOfficePackage(out.blob), report=await inspectPresentation(zip);
 expect(report.pages).toHaveLength(2); expect(report.pages.every(p=>p.tables===1)).toBe(true);
 const xml=await zip.file('ppt/slides/slide1.xml').async('string');
 expect(xml).toContain('第1/2页'); expect(xml).toContain('sz="1200"');
 for(const i of [0,19]) expect((await zip.file(`ppt/slides/slide${i?2:1}.xml`).async('string'))).toContain(`甲${i}`);
});
it('明确续表可合并，不合并不同内容标题或指定页数',()=>{
 const md=[0,1,2,3].map(i=>`## 赛程（${i+1}）\n| 时间 | 对阵 |\n|--|--|\n`+Array.from({length:5},(_,j)=>`|18:00|甲${i*5+j}—乙|`).join('\n')).join('\n');
 expect(planTablePages(parseSlides('赛程',md))).toHaveLength(2);
 expect(planTablePages(parseSlides('赛程',md),{strict:true})).toHaveLength(4);
 expect(tidyPresentationPunctuation('18 ： 54，进行中 ： 7 场')).toBe('18:54，进行中：7 场');
});
it('封面图片实际嵌入且不多一页扉页',async()=>{
 const bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'));
 const out=await generate('pptx',{title:'赛程',content:'# 赛程\n\n![球场](cover.png)\n\n## 内容\n明天对阵。',loadImage:async()=>bytes});
 const report=await inspectPresentation(await openOfficePackage(out.blob));
 expect(report.pages).toHaveLength(2); expect(report.pages[0].contentImages).toBe(1);
 expect(out.info.layouts).toEqual(['cover','statement']);
});

it('说明短页合并且全部正文保留；明确页数不合并',async()=>{
 const {combineExplanationPages}=await import('../src/agent/presentationLayoutPlan.js');
 const slides=['来源','口径','限制'].map(title=>({title,blocks:[{type:'paragraph',inlines:[{text:title+'必须保留'}]}],notes:[]}));
 const merged=combineExplanationPages(slides);expect(merged).toHaveLength(1);expect(merged[0].blocks).toHaveLength(3);expect(combineExplanationPages(slides,{strict:true})).toHaveLength(3);
});
