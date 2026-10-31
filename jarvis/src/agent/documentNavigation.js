import * as ws from './workspace.js';
import {parseFile} from './docs.js';
import {diagramDigest} from './diagramExport.js';
import {throwControl} from '../core/networkRequest.js';
import {documentSectionCatalog,indexDocumentSections,resolveDocumentSection} from './documentSections.js';
const invalid=message=>Object.assign(new Error(message),{code:'DOCUMENT_NAVIGATION',kind:'input'});
export async function readCurrentDocument(file,{signal}={}){
 throwControl(null,signal);
 const path=ws.normalize(file),blob=await ws.readBlob(path);
 if(blob.size>10e6)throw invalid('文件超过10MB，请先拆分原件');
 const parsed=await parseFile(blob,path,{limit:Infinity,signal});throwControl(null,signal);
 if(parsed.chars>1e6)throw invalid('正文超过100万字符，请先拆分原件');
 return {path,text:parsed.text,hash:await diagramDigest(blob),ranges:[]};
}
function overlapOf(ranges,start,end){return (ranges||[]).reduce((sum,r)=>sum+Math.max(0,Math.min(end,r.end)-Math.max(start,r.start)),0);}
function markRange(doc,key,start,end){
 const merged=[];
 for(const range of [...(doc[key]||[]),{start,end}].sort((a,b)=>a.start-b.start)){
  if(merged.length&&range.start<=merged.at(-1).end)merged.at(-1).end=Math.max(merged.at(-1).end,range.end);else merged.push({...range});
 }
 doc[key]=merged.slice(-64);
}
/** 每次工具实例最多3文档、每份100万字符、3分钟LRU；缓存仅在内存，文件字节摘要变化即失效。 */
export function createDocumentNavigation({readBlob=ws.readBlob,parse=parseFile,now=Date.now}={}){
 const cache=new Map();
 async function read(file,{signal}={}){
  throwControl(null,signal);const path=ws.normalize(file),blob=await readBlob(path);
  if(blob.size>10e6)throw invalid('文件超过10MB，请先拆分原件');
  const hash=await diagramDigest(blob);throwControl(null,signal);
  for(const [key,item] of cache)if(now()-item.at>180000)cache.delete(key);
  const old=cache.get(path);let entry;
  if(old?.hash===hash)entry=old;
  else{
   entry={hash,at:now(),pending:Promise.resolve().then(async()=>{
    const parsed=await parse(blob,path,{limit:Infinity,signal});throwControl(null,signal);
    if(parsed.chars>1e6)throw invalid('正文超过100万字符，请先拆分原件');
    return {path,text:parsed.text,hash,ranges:[]};
   })};
   cache.set(path,entry);
  }
  cache.delete(path);cache.set(path,entry);entry.at=now();
  while(cache.size>3)cache.delete(cache.keys().next().value);
  try{const doc=await entry.pending;throwControl(null,signal);return doc;}catch(error){if(cache.get(path)===entry)cache.delete(path);throw error;}
 }
 async function search(doc,query,{offset=0,limit=8,signal}={}){
  if(typeof query!=='string'||!query||query.length>120||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20)throw invalid('关键词需1～120字符，offset非负整数，limit 1～20');
  const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(escaped,'gi');pattern.lastIndex=offset;
  const sections=await indexDocumentSections(doc),matches=[];let total=0,hit,nextOffset=null;
  while((hit=pattern.exec(doc.text))){
   throwControl(null,signal);total++;
   if(matches.length<limit){
    const start=Math.max(0,hit.index-80),end=Math.min(doc.text.length,hit.index+query.length+160);
    const section=sections.filter(item=>item.start<=hit.index&&item.end>=hit.index+hit[0].length).sort((a,b)=>a.chars-b.chars)[0];
    matches.push({offset:hit.index,line:doc.text.slice(0,hit.index).split('\n').length,text:doc.text.slice(start,end),...(section&&{sectionId:section.sectionId})});nextOffset=pattern.lastIndex;
   }
   if(total>=500)break;
  }
  return {path:doc.path,chars:doc.text.length,matches,totalMatches:total,countLimited:total>=500,nextOffset:total>limit?nextOffset:null,note:'命中为实际原文位置；片段不代表全文已读。可用sectionId读取连续章节或准备架构证据。'};
 }
 async function page(doc,{offset=0,sectionId,recover=false}={},segment){
  if(!Number.isInteger(offset)||offset<0)throw invalid('offset需非负整数');
  const section=sectionId?await resolveDocumentSection(doc,sectionId):{start:0,end:doc.text.length};
  const start=Math.min(section.end,section.start+offset),end=Math.min(section.end,start+20000),length=end-start;
  const overlap=overlapOf(doc.ranges,start,end);
  const repeated=doc.text.length>20000&&length&&overlap/length>=0.95;
  const canRecover=repeated&&recover&&overlapOf(doc.recoveries,start,end)/length<0.95;
  if(repeated&&!canRecover){
   let unread=start;for(const range of doc.ranges){if(range.start>unread)break;if(range.end>unread)unread=range.end;}
   return JSON.stringify({path:doc.path,state:'already_read',requested:{start,end},overlapChars:overlap,nextOffset:Math.min(unread,end)-section.start,note:'本范围至少95%已返回过，本次不重复灌入正文，也不把剩余边界标为已读。用query定位所需文字，或view=sections选择章节；不要把offset加1重扫。原工具编号已过期且确需整页时可recover=true，每范围最多恢复一次；不要猜旧编号。'});
  }
  if(length){markRange(doc,'ranges',start,end);if(canRecover)markRange(doc,'recoveries',start,end);}
  return segment(doc.text.slice(section.start,section.end),offset);
 }
 return {read,search,page,catalog:documentSectionCatalog};
}
