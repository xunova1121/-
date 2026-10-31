import * as ws from './workspace.js';
import {searchLines} from './fileSearch.js';
import {throwControl} from '../core/networkRequest.js';
export const navigableOffice=path=>/\.(?:docx|pdf|pptx|xlsx|xls|ods)$/i.test(path);
const invalid=message=>Object.assign(new Error(message),{code:'DOCUMENT_NAVIGATION',kind:'input'});
export function createDocumentFileAccess(navigation,segment,{legacyDoc=false}={}){
 return {
  async read({path,offset=0,query,view='text',sectionId,catalogOffset=0,limit=8,recover=false},{signal}={}){
   // 工具严格Schema常把未使用的可选关键词补成空字符串；这表示读正文，不是执行空关键词搜索。
   if(typeof query==='string'&&!query.trim())query=undefined;
   if(sectionId&&(query||view==='sections'))throw invalid('章节正文、关键词和目录模式请分别读取');
   const doc=await navigation.read(path,{signal});
   if(view==='sections')return JSON.stringify(await navigation.catalog(doc,{query:query||'',offset:catalogOffset,limit}));
   if(view!=='text')throw invalid('view仅支持text或sections');
   if(query!==undefined)return JSON.stringify(await navigation.search(doc,query,{offset,limit,signal}));
   return navigation.page(doc,{offset,sectionId,recover},segment);
  },
  async search({query,path='',regex=false},{signal}={}){
   throwControl(null,signal);
   // 后缀是 .doc、内容其实是新版 Word（PK 开头）的照 docx 搜；真老 .doc 或不存在的照旧报错，不当零命中
   const zippedDoc=path&&/\.doc$/i.test(path)&&await ws.readBlob(ws.normalize(path)).then(async b=>{const h=new Uint8Array(await b.slice(0,2).arrayBuffer());return h[0]===0x50&&h[1]===0x4b;}).catch(()=>false);
   if(path&&(navigableOffice(path)||zippedDoc||(legacyDoc&&/\.doc$/i.test(path)))){
    if(regex)throw invalid('Office/PDF定位暂只支持普通关键词，请关闭regex后检索确切原文');
    const doc=await navigation.read(path,{signal});
    return JSON.stringify({...(await navigation.search(doc,query,{signal})),scannedDocuments:1});
   }
   if(path&&/\.doc$/i.test(path))throw invalid('旧DOC格式尚不支持解析搜索，请指定可读DOCX原件，不能当作零命中');
   const out=[];let scanned=0;
   for(const f of (await ws.list('')).filter(f=>ws.isText(f.path)&&(!path||f.path.startsWith(ws.normalize(path)))&&(f.size??0)<=2e6)){
    throwControl(null,signal);if(out.length>=60||scanned>=100)break;scanned++;
    const text=await ws.readText(f.path);
    out.push(...searchLines(text,query,{regex}).slice(0,8).map(h=>`${f.path}:${h.line}: ${h.text}`));
   }
   const note='\n（目录扫描只搜文本文件；查Word/PDF/PPT/Excel请在path指定确切文件。每次最多扫描100个文本文件。）';
   return (out.length?out.slice(0,60).join('\n')+(out.length>=60?'\n（只列前60条，请缩小范围）':''):`在 ${scanned} 个文本文件里没有找到“${query}”`)+note;
  }
 };
}
