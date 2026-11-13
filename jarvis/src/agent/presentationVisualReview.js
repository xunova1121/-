import {reviewSlidesByImage} from './selfCheck.js';
import {throwControl} from '../core/networkRequest.js';
/** 视觉修复不得删改正文事实、表格和图片引用；只允许换行/列表/版式元数据调整。 */
export const presentationContentKey = content => String(content).split('\n').filter(line=>!/^\s*(?:版式|图标)：/.test(line)).join('\n').replace(/[\s#*_>`|~-]/g,'');
const base64 = async blob => {
 const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let start=0;start<bytes.length;start+=8192)binary+=String.fromCharCode(...bytes.subarray(start,start+8192));return btoa(binary);
};
export async function reviewRealPresentation(ctx,out,content,{requirements='',signal,progress,retrieval,build}={}) {
 const result={out,content,review:{state:'not_checked',pages:0,repairs:0,problems:[]}};
 if(!ctx.officeRender||!ctx.presentationOverview)return result;
 try{
  for(let round=0;round<=2;round++) {
   signal?.throwIfAborted();progress?.('核对真实Office页面与总览…');
   const rendered=await ctx.officeRender(result.out.blob,'pptx',{signal});
   result.out.officePreview=rendered;
   if(!rendered.available){result.review={...result.review,state:'not_available',note:rendered.reason};break;}
   const overview=await ctx.presentationOverview(rendered.blob,{signal});
   result.out.officeOverview=overview;
   result.review.pages=overview.pages;
   if(overview.pages!==result.out.info?.slides){
    // 某些生成器用slideCount，最终交付仍会用真实XML再次核对。
    const expected=result.out.info?.slides??result.out.info?.slideCount;
    if(expected!=null&&expected!==overview.pages){result.review.state='failed';result.review.problems=['真实PDF页数与PPT不一致'];break;}
   }
   if(!ctx.visionLlm){result.review.state='rendered_not_visual_reviewed';break;}
   const problems=[];let proposed=result.content,changed=0;
   for(const sheet of overview.sheets){
    retrieval?.consume('model');
    const review=await reviewSlidesByImage({images:[{mime:'image/png',data:await base64(sheet.blob)}],pages:sheet.pages,content:proposed,requirements:requirements+'\n这是LibreOffice真实页面。只调整换行/版式，不得删除数字、表格、正文和图片；不得突破用户页数。',llm:ctx.visionLlm,signal});
    problems.push(...review.problems);proposed=review.content;changed+=review.changed;
   }
   result.review.problems=problems.slice(0,40);
   if(!problems.length&&!changed){result.review.state='reviewed';break;}
   result.review.state='needs_revision';
   if(round===2||!changed)break;
   if(presentationContentKey(proposed)!==presentationContentKey(result.content)){result.review.problems.push('视觉修复建议会改变正文或表格，已拒绝，保留内容');break;}
   const candidate=await build(proposed);
   const errors=o=>(o.info?.layoutIssues||[]).filter(item=>item.level==='error').length;
   if(errors(candidate)>errors(result.out)){result.review.problems.push('候选排版新增硬错误，未替换');break;}
   result.out=candidate;result.content=proposed;result.review.repairs++;
  }
 }catch(error){throwControl(error,signal);result.review.state='failed';result.review.note=String(error.message).slice(0,180);}
 result.out.officeVisual=result.review;
 return result;
}
