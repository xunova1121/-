import { throwControl } from '../core/networkRequest.js';
import * as workspace from './workspace.js';
import {readCurrentDocument} from './documentNavigation.js';
import {indexDocumentSections,resolveDocumentSection} from './documentSections.js';

export async function checkSources(sources, signal, readDocument = readCurrentDocument) {
  if (!Array.isArray(sources) || sources.length > 4) throw Object.assign(new Error('材料最多4个'), { code: 'DIAGRAM_SOURCE_SIZE', kind: 'input' });
  const checks = [];
  const materials = [];
  for (const source of sources) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let blob;
    try { blob = await workspace.readBlob(source.path); } catch (error) {
      throwControl(error, signal);
      if (error.kind === 'network' || error.kind === 'timeout') throw error;
      throw Object.assign(new Error('图形来源读取失败：' + String(source.path).slice(0,400)), {code:'DIAGRAM_SOURCE_READ',kind:'input',cause:error,diagnostics:[{stage:'material',field:'sources.path',action:'定位并读取明确来源文件；若为旧格式，使用用户指定的可读版本，不借旧稿代替'}]});
    }
    if (blob.size > 10e6) throw Object.assign(new Error('来源文件超过10MB，请先分段提取相关材料'), { code: 'DIAGRAM_SOURCE_SIZE', kind: 'input' });
    const doc=await readDocument(source.path,{signal});
    const sections=await indexDocumentSections(doc);
    const needle=String(source.sectionStart||'').replace(/^(?:第[一二三四五六七八九十\d]+章|[一二三四五六七八九十]+[、．.]|\d+[.、．])\s*/,'').slice(0,80);
    const ranked=needle?sections.filter(item=>item.title.includes(needle)):[];
    const scopeOptions=(ranked.length?ranked:sections).slice(0,4).map(item=>({title:item.title,part:item.part,parts:item.parts,chars:item.chars,source:{path:source.path,sectionId:item.sectionId}}));
    const invalid=message=>Object.assign(new Error(message),{code:'ARCHITECTURE_SOURCE_SCOPE',kind:'input',diagnostics:[{stage:'source',field:'sources.sectionId',action:'使用scopeOptions里的真实编号，或prepare_architecture_evidence(catalog:true)按标题查询目录；不要手抄/猜章节起止。目录不是已读正文。',scopeOptions}]});
    if(source.sectionId!==undefined&&(source.sectionStart!==undefined||source.sectionEnd!==undefined))throw invalid('sectionId不能与手填章节边界混用');
    if(source.sectionEnd!==undefined&&source.sectionStart===undefined)throw invalid('章节终点必须同时给出唯一起点');
    const scoped=source.sectionStart!==undefined||source.sectionId!==undefined;
    let text=doc.text;
    if(source.sectionId!==undefined){
      let range;
      try{range=await resolveDocumentSection(doc,source.sectionId);}catch(error){throwControl(error,signal);if(error.code!=='DOCUMENT_SECTION')throw error;throw invalid('章节编号无效或原文已变化，请重取目录');}
      text=text.slice(range.start,range.end);
    }else if(source.sectionStart!==undefined){
      const start=source.sectionStart,end=source.sectionEnd;
      if(typeof start!=='string'||!start.trim()||start.length>300||(end!==undefined&&(typeof end!=='string'||!end.trim()||end.length>300)))throw invalid('章节边界需为1～300字的原文锚点');
      const first=text.indexOf(start);
      if(first<0||text.indexOf(start,first+start.length)>=0)throw invalid('章节起点不存在或重复，请用正文标题和首句唯一定位，不能把目录当正文');
      let last=text.length;
      if(end!==undefined){last=text.indexOf(end,first+start.length);if(last<0||text.indexOf(end,last+end.length)>=0)throw invalid('章节终点不存在或重复，请使用唯一正文边界');}
      text=text.slice(first,last);
    }
    if(scoped&&text.length>120000)throw invalid('选定章节超过12万字，请明确拆为有原文边界的章节范围');
    if(!scoped)text=text.slice(0,120000);
    const excerpt = String(source.excerpt || '').trim();
    const matched = Boolean(excerpt && text.replace(/\s+/g, '').includes(excerpt.replace(/\s+/g, '')));
    materials.push({ path: source.path, text });
    checks.push({
      path: source.path,
      matched,
      truncated: !scoped && doc.text.length > 120000,
      ...(!scoped&&doc.text.length>120000&&{scopeOptions}),
      ...(scoped && { scope: 'section', ...(source.sectionId?{sectionId:source.sectionId}:{sectionStart:source.sectionStart,sectionEnd:source.sectionEnd}) })
    });
  }
  return { checks, materials };
}
