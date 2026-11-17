/** 真实PNG→专用入口→真实XLSX/Office PDF。视觉响应是有界夹具，不冒称真实模型识别验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import ExcelJS from 'exceljs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import { normalizeTableReplica,makeReplicaWorkbook,inspectReplicaWorkbook } from '../src/agent/spreadsheetReplica.js';
import { tableGridEvidence } from '../src/agent/imageRegion.js';
import { serverCanvasRenderer } from '../server/canvasImageText.mjs';
import { renderOffice,officeRenderAvailable } from '../server/officeRender.mjs';
import { presentationOverview } from '../server/presentationOverview.mjs';
import { parseFile,loadPdfjs } from '../src/agent/docs.js';
import { attendanceReplica,FRAME_REQUEST } from '../tests/fixtures/table-replica.js';
const output=path.resolve(process.argv[2]||'/tmp/weiyang-spreadsheet-replica');
await fs.mkdir(output,{recursive:true});
const storage=await fs.mkdtemp('/tmp/weiyang-replica-store-');useBackend(createFileStore(storage));
const checks=[];
const check=(label,value)=>{assert.ok(value,label);checks.push(label);console.log('✓ '+label);};
const positions=list=>{let n=0;return [0,...list.map(x=>n+=x)];};
function photograph(d,turn=false) {
 const x=positions(d.columns),y=positions(d.rows), w=Math.round(x.at(-1)/0.96),h=Math.round(y.at(-1)/0.96);
 const canvas=createCanvas(w,h),c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,w,h);c.translate(w*0.02,h*0.02);
 c.lineWidth=1.8;c.strokeStyle='#111';const g=d.grid;
 for(let r=g.r-1;r<g.r-1+g.rs;r++)for(let col=g.c-1;col<g.c-1+g.cs;col++)c.strokeRect(x[col],y[r],d.columns[col],d.rows[r]);
 for(const cell of d.cells){
  const l=x[cell.c-1],t=y[cell.r-1],cw=x[cell.c-1+cell.cs]-l,ch=y[cell.r-1+cell.rs]-t;
  c.fillStyle='white';c.fillRect(l+1,t+1,cw-2,ch-2);
  if(cell.border!=='none')c.strokeRect(l,t,cw,ch);
  c.font=`${cell.bold?'bold ':''}${cell.font}px "Noto Serif CJK SC"`;c.fillStyle='black';c.textBaseline='middle';c.textAlign=cell.align||'center';
  c.fillText(cell.text,cell.align==='left'?l+4:cell.align==='right'?l+cw-4:l+cw/2,t+ch/2,cw-8);
 }
 if(!turn)return new Blob([canvas.toBuffer('image/png')],{type:'image/png'});
 const rotated=createCanvas(h,w),r=rotated.getContext('2d');r.translate(h,0);r.rotate(Math.PI/2);r.drawImage(canvas,0,0);
 return new Blob([rotated.toBuffer('image/png')],{type:'image/png'});
}
try {
 check('Office实际可用，不跳过真实打印验收',await officeRenderAvailable());
 for(const turn of [false,true]) {
  const original=attendanceReplica(),raw=structuredClone(original),source=photograph(original,turn);
  if(turn)raw.corners=raw.corners.map(([x,y])=>[1-y,x]);
  const sourcePath=turn?'table-rotated.png':'table.png',target=turn?'还原-旋转原图.xlsx':'还原-正向原图.xlsx';
  await ws.write(sourcePath,source);await fs.writeFile(path.join(output,sourcePath),new Uint8Array(await source.arrayBuffer()));
  const d=normalizeTableReplica(raw,FRAME_REQUEST),frame=(await serverCanvasRenderer.inspect(source)).frame;
  const evidence=tableGridEvidence(frame,d);
  check(`${turn?'旋转':'正向'}：真实照片像素与37列网格匹配`,evidence.state==='matched');
  const wrong={...d,columns:[...d.columns,...Array(11).fill(30)]};
  check('多出11列的结构不能通过原图像素匹配',tableGridEvidence(frame,wrong).state!=='matched');
  let calls=0,budget=0;const events=[],receipts=[];
  const tool=createDocumentGenerateTool({canvasRenderer:serverCanvasRenderer,officeRender:renderOffice,presentationOverview,
   onFileChanged:p=>events.push(p),visionLlm:async args=>{
    calls++;assert.equal(args.maxTransientRetries,0);assert.equal(args.maxWebSearches,0);assert.equal(args.allowWebSearch,false);
    if(calls===1){assert.equal(args.images.length,1);return JSON.stringify(raw);}
    assert.equal(args.images.length,2);assert.notEqual(args.images[0].data,args.images[1].data);
    return JSON.stringify({columns:37,rows:29,merges:d.cells.filter(c=>c.rs>1||c.cs>1).length,printedTextExact:true,clearedOnlyRequested:true,layoutMatches:true,issues:[]});
   }});
  const receipt=await tool.run({format:'xlsx',source_path:sourcePath,path:target,content:'',requirements:FRAME_REQUEST},{rawRequestText:FRAME_REQUEST,retrieval:{consume:kind=>{assert.equal(kind,'model');budget++;}},checkpoint:r=>receipts.push(r)});
  const latest=receipts.at(-1);
  if(latest.validation.replica!=='complete') console.error(receipt);
  check('专用入口真实完成且只交付一个Excel',latest.validation.replica==='complete'&&events.length===1&&events[0]===target);
  check('两次视觉调用均先扣预算，不隐藏重试或联网',calls===2&&budget===2);
  const blob=await ws.readBlob(target);await fs.writeFile(path.join(output,target),new Uint8Array(await blob.arrayBuffer()));
  await inspectReplicaWorkbook(blob,d);
  const b=new ExcelJS.Workbook();await b.xlsx.load(await blob.arrayBuffer());const s=b.worksheets[0];
  check('37列，无48列空白扩展，姓名宽于日期格',s.columnCount===37&&s.getColumn(2).width>s.getColumn(5).width*3);
  check('上午下午的姓名框合并，合计复合表头保留',s.getCell('B7').master.address==='B6'&&s.getCell('AK4').master.address==='AJ4'&&s.getCell('AK5').value==='请假');
  check('实际姓名和勾叉空白，印刷年月及图例保留',s.getCell('B6').value===null&&s.getCell('E6').value===null&&s.getCell('Z2').value.includes('2025年12月')&&s.getCell('A29').value.includes('√'));
  const match=receipt.match(/检查记录：([^。]+)\.json/),report=JSON.parse(await ws.readText(match[1]+'.json'));
  assert.equal(report.visual.pages,1);const pdf=await ws.readBlob(match[1].replace(/report$/,'preview')+'.pdf');
  const text=(await parseFile(pdf,'preview.pdf',{limit:Infinity})).text.replace(/\s/g,'');
  check('真实PDF单页，项目名称/原年月/监理确认均可读',report.visual.pages===1&&['项目组人员考勤表','2025年12月','监理单位确认','上午','下午','请假'].every(t=>text.includes(t)));
  check('PDF不带被清空的合成姓名',!text.includes('测试人员'));
  // 不能只去掉空白后找“10”：那会让被挤成上下两行的1/0也通过。
  const pdfjs=await loadPdfjs(),task=pdfjs.getDocument({data:new Uint8Array(await pdf.arrayBuffer()),isEvalSupported:false});
  try {
   const doc=await task.promise,page=await doc.getPage(1),items=(await page.getTextContent()).items;
   const time=items.find(item=>item.str==='时间');assert.ok(time);
   const days=items.filter(item=>item.transform&&item.transform[4]>time.transform[4]+time.width&&Math.abs(item.transform[5]-time.transform[5])<3&&/^\d+(?:\s+\d+)*$/.test(item.str.trim()))
    .sort((a,b)=>a.transform[4]-b.transform[4]).flatMap(item=>item.str.trim().split(/\s+/).map(Number));
   check('真实打印的1至31日同一行且双位数不折行',JSON.stringify(days)===JSON.stringify(Array.from({length:31},(_,i)=>i+1)));
   page.cleanup();
  } finally {await task.destroy();}
  await fs.writeFile(path.join(output,turn?'rotated.pdf':'upright.pdf'),new Uint8Array(await pdf.arrayBuffer()));
  const overview=await presentationOverview(pdf);await fs.writeFile(path.join(output,turn?'rotated-preview.png':'upright-preview.png'),new Uint8Array(await overview.sheets[0].blob.arrayBuffer()));
  await fs.writeFile(path.join(output,turn?'rotated-report.json':'upright-report.json'),JSON.stringify({receipt,report},null,2));
 }
 // 非考勤的多级检验单也沿用同协议，防止把37列硬编码进生产工具。
 const other={title:'材料检验记录',columns:[80,180,80,80,80,80],rows:[45,25,25,35,35,35],grid:{r:2,c:1,rs:5,cs:6},corners:[[0,0],[1,0],[1,1],[0,1]],uncertain:[],cells:[{r:1,c:1,rs:1,cs:6,text:'材料检验记录',font:26,border:'none'},{r:2,c:1,rs:2,cs:2,text:'检验项目',font:18},{r:2,c:3,rs:1,cs:4,text:'检查结果',font:18},...[3,4,5,6].map((c,i)=>({r:3,c,text:['合格','不合格','待定','备注'][i],font:18})),{r:4,c:1,rs:2,cs:1,text:'1',font:18},{r:4,c:2,text:'尺寸',font:18},{r:5,c:2,text:'外观',font:18}]};
 const design=normalizeTableReplica(other),{blob}=await makeReplicaWorkbook(design);await inspectReplicaWorkbook(blob,design);
 check('另一种6列复合表头可编辑重建，非考勤硬编码',design.columns.length===6);
 const real=await renderOffice(blob,'xlsx');check('另一种表格也实际转PDF',real.available);await fs.writeFile(path.join(output,'检验记录.xlsx'),new Uint8Array(await blob.arrayBuffer()));
 await fs.writeFile(path.join(output,'result.json'),JSON.stringify({checks,providerTested:false,deviceTested:false,source:'根据用户可见照片结构人工标注的合成表，不是用户原照片的模型识别'},null,2));
 console.log(`完成${checks.length}项图片表格还原检查`);
}finally{useBackend(null);await fs.rm(storage,{recursive:true,force:true});}
