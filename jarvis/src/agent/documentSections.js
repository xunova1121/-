import {diagramDigest} from './diagramExport.js';
const invalid=message=>Object.assign(new Error(message),{code:'DOCUMENT_SECTION',kind:'input'});
const heading=/^(?:第[一二三四五六七八九十百零〇\d]+[章节篇部分]|[一二三四五六七八九十百]+[、．.]|[（(][一二三四五六七八九十\d]+[）)]|\d{1,3}[.、．](?!\d))\s*\S/;
/** 标题只是定位候选，不代替业务层级判断；最多1000项，单片最多6万字符，不拼接原文。 */
export async function indexDocumentSections(doc){
 if(typeof doc.text!=='string'||doc.text.length>1e6)throw invalid('正文超过100万字符或无效，请先拆分原件');
 if(doc.sections)return doc.sections;
 const headings=[];let offset=0;
 for(const line of doc.text.split('\n')){
  const title=line.trim();
  if(title.length<=100&&heading.test(title)&&!/[.…。·]{3}/.test(title)){
   headings.push({start:offset+line.indexOf(title),title,level:/^第/.test(title)?1:/^[（(]/.test(title)?3:/^\d/.test(title)?4:2});
   if(headings.length>1000)throw invalid('候选标题超过1000项，请先拆分源文件');
  }
  offset+=line.length+1;
 }
 if(!headings.length||headings[0].start>0)headings.unshift({start:0,title:'正文起始',level:0});
 const hash=await diagramDigest(JSON.stringify([doc.path,doc.text]));
 const items=[];
 for(let i=0;i<headings.length;i++){
  const h=headings[i];let end=doc.text.length;
  if(h.level===0)end=headings[i+1]?.start??end;
  else for(let j=i+1;j<headings.length;j++)if(headings[j].level<=h.level){end=headings[j].start;break;}
  const cuts=[h.start];
  while(end-cuts.at(-1)>60000){
   const limit=cuts.at(-1)+60000;
   const boundary=doc.text.lastIndexOf('\n',limit);
   let cut=boundary>limit-10000?boundary+1:limit;
   if(/[\uDC00-\uDFFF]/.test(doc.text[cut]))cut--;
   cuts.push(cut);
  }
  cuts.push(end);
  for(let part=0;part<cuts.length-1;part++){
   if(cuts[part]===cuts[part+1])continue;
   if(items.length>=1000)throw invalid('目录范围超过1000项，请拆分源文件');
   const start=cuts[part],stop=cuts[part+1];
   items.push({sectionId:`sec:${hash}:${start}:${stop-start}`,title:h.title,part:part+1,parts:cuts.length-1,start,end:stop,chars:stop-start});
  }
 }
 doc.sections=items;return items;
}
export async function documentSectionCatalog(doc,{query='',offset=0,limit=8}={}){
 if(typeof query!=='string'||query.length>120||!Number.isInteger(offset)||offset<0||offset>1000||!Number.isInteger(limit)||limit<1||limit>20)throw invalid('目录参数超限：query最多120字，offset 0～1000，limit 1～20');
 const all=await indexDocumentSections(doc),matched=query?all.filter(item=>item.title.toLowerCase().includes(query.toLowerCase())):all;
 return {path:doc.path,chars:doc.text.length,total:all.length,matched:matched.length,offset,nextOffset:offset+limit<matched.length?offset+limit:null,sections:matched.slice(offset,offset+limit),note:'这是原文候选标题及连续范围，不代表业务分层或已读正文。直接用path和sectionId读取/取证，不手抄章节；大章节的所有parts合计才是完整范围。'};
}
export async function resolveDocumentSection(doc,id){
 if(typeof id!=='string'||id.length>120)throw invalid('章节编号无效');
 const found=(await indexDocumentSections(doc)).find(item=>item.sectionId===id);
 if(!found)throw invalid('章节编号不存在或原文已变化，请重新读取目录，不手写编号');
 return found;
}
export function architectureScope(source){return source.sectionId?{sectionId:source.sectionId}:source.scope==='section'||source.sectionStart!==undefined?{sectionStart:source.sectionStart,sectionEnd:source.sectionEnd}:{};}
