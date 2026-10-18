import { parseFile } from './docs.js';
/** 对真实产物读回验收；不把 ZIP/文本通过冒充排版渲染通过。 */
export async function checkArtifact(blob, name) {
 const ext=String(name).split('.').pop().toLowerCase();
 if(!blob?.size)throw new Error('生成文件为空');
 const report={format:ext,bytes:blob.size,structure:'not_applicable',readback:'not_applicable',render:'not_checked'};
 if(['docx','pptx','xlsx'].includes(ext)){
  const JSZip=(await import('jszip')).default,zip=await JSZip.loadAsync(await blob.arrayBuffer());
  const required={'docx':'word/document.xml','pptx':'ppt/presentation.xml','xlsx':'xl/workbook.xml'}[ext];
  if(!zip.file('[Content_Types].xml')||!zip.file(required))throw new Error('Office文件结构不完整：'+required);
  const xml=await zip.file(required).async('string');if(!xml.trim())throw new Error('Office主文档为空');
  report.structure='passed';
  const parsed=await parseFile(blob,name);if(!parsed.text?.trim())throw new Error('生成文件无法读回有效内容');
  report.readback='passed';report.extractedCharacters=parsed.text.length;
  if(ext==='pptx')report.slides=Object.keys(zip.files).filter(p=>/^ppt\/slides\/slide\d+\.xml$/.test(p)).length;
 }else if(ext==='pdf'){
  if(new TextDecoder().decode(await blob.slice(0,5).arrayBuffer())!=='%PDF-')throw new Error('PDF文件头无效');
  report.structure='passed';
 }else if(['html','md','txt','csv'].includes(ext)){
  const text=await blob.text();if(!text.trim())throw new Error('生成文件无有效内容');report.readback='passed';report.extractedCharacters=text.length;
 }
 return report;
}
