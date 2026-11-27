import { describe,it,expect,beforeEach,vi } from 'vitest';
import ExcelJS from 'exceljs';
import { IDBFactory } from 'fake-indexeddb';
import { attendanceReplica,FRAME_REQUEST } from './fixtures/table-replica.js';
import { normalizeTableReplica,makeReplicaWorkbook,inspectReplicaWorkbook,tableReplicaRequest,restoreSpreadsheet } from '../src/agent/spreadsheetReplica.js';
import { imagePlane,tableGridEvidence } from '../src/agent/imageRegion.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import { documentRouteNote } from '../src/agent/documentToolProfile.js';
import * as ws from '../src/agent/workspace.js';
import { collection } from '../src/agent/store.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { reviewOutcome } from '../src/agent/reviewOutcome.js';
const bookOf=async blob=>{const b=new ExcelJS.Workbook(); await b.xlsx.load(await blob.arrayBuffer()); return b;};
const specimen=()=>normalizeTableReplica(attendanceReplica(),FRAME_REQUEST);
beforeEach(async()=>{globalThis.indexedDB ||=new IDBFactory();await collection('files').clear();});

describe('图片表格保真协议',()=>{
 it('照图任务进入专用分流，普通新建或明确不要还原不抢占',()=>{
  expect(tableReplicaRequest(FRAME_REQUEST)).toBe(true);
  expect(tableReplicaRequest('照图还原Excel')).toBe(true);
  expect(tableReplicaRequest('生成销售统计Excel')).toBe(false);
  expect(tableReplicaRequest('不用原图，生成新Excel')).toBe(false);
  expect(documentRouteNote(FRAME_REQUEST)).toContain('source_path');
 });
 it('37列、29行、合并表头和11个人员框，只有填写内容清空，图例保留',()=>{
  const d=specimen();expect(d.columns).toHaveLength(37);expect(d.rows).toHaveLength(29);
  expect(d.cells.filter(c=>c.c===2&&c.rs===2&&c.r>=6)).toHaveLength(11);
  expect(d.cells.find(c=>c.r===4&&c.c===36)).toMatchObject({cs:2,text:'合计'});
  expect(d.cells.filter(c=>['name','mark'].includes(c.role)).every(c=>c.text==='')).toBe(true);
  expect(d.cells.find(c=>c.r===29).text).toContain('√');
  expect(d.cells.find(c=>c.r===2&&c.c===26).text).toContain('2025年12月');
 });
 it('没有清空要求时保留填写值；只清姓名不误清对勾',()=>{
  const raw=attendanceReplica();
  expect(normalizeTableReplica(raw,'按照片还原Excel').cells.find(c=>c.role==='name').text).toContain('测试人员');
  const d=normalizeTableReplica(raw,'按照片还原Excel，只把姓名留空');
  expect(d.cells.find(c=>c.role==='name').text).toBe('');expect(d.cells.find(c=>c.role==='mark').text).toBe('√');
 });
 it.each(['overlap','bounds','dense','bad-corners','unsafe-value'])('拒绝非法结构 %s',kind=>{
  const d=attendanceReplica();
  if(kind==='overlap')d.cells.push({...d.cells[0]});
  if(kind==='bounds')d.cells[0].cs=48;
  if(kind==='dense')d.columns.push(...Array(81).fill(1));
  if(kind==='bad-corners')d.corners=[[0,0],[1,1],[1,0],[0,1]];
  if(kind==='unsafe-value')d.cells[0].text={formula:'WEBSERVICE("x")'};
  expect(()=>normalizeTableReplica(d,FRAME_REQUEST)).toThrow();
 });
 it('生成真实可编辑Excel，单元格不变成图片或普通台账，读回几何原文与合并一致',async()=>{
  const d=specimen(),{blob}=await makeReplicaWorkbook(d), s=(await bookOf(blob)).worksheets[0];
  expect(await inspectReplicaWorkbook(blob,d)).toMatchObject({state:'passed',columns:37,rows:29});
  expect(s.getColumn(2).width).toBeGreaterThan(s.getColumn(5).width*3);
  expect(s.getCell('B6').isMerged).toBe(true);expect(s.getCell('B7').master.address).toBe('B6');
  expect(s.getCell('AJ4').value).toBe('合计');expect(s.getCell('AK5').value).toBe('请假');
  expect(s.getCell('A1').fill.fgColor.argb).toBe('FFFFFFFF');expect(s.getCell('A1').alignment.horizontal).toBe('center');
  expect(s.getCell('E6').value).toBeNull();expect(s.getCell('Z2').value).toContain('2025年12月');
  expect(s.getCell('O28').value).toBe('监理单位确认：');expect(s.getImages()).toHaveLength(0);
  expect(s.pageSetup).toMatchObject({fitToWidth:1,fitToHeight:1,orientation:'landscape'});
 });
 it.each(['extra-columns','lost-merge','wrong-date','unexpected-entry','wrong-width'])('实际文件篡改能被回读拦截 %s',async kind=>{
  const d=specimen(), {blob}=await makeReplicaWorkbook(d), b=await bookOf(blob),s=b.worksheets[0];
  if(kind==='extra-columns')s.getCell('AV6').value='';
  if(kind==='lost-merge')s.unMergeCells('B6:B7');
  if(kind==='wrong-date')s.getCell('Z2').value='考勤月份：2026年1月';
  if(kind==='unexpected-entry')s.getCell('F7').value='√';
  if(kind==='wrong-width')s.getColumn(5).width=10;
  await expect(inspectReplicaWorkbook(new Blob([await b.xlsx.writeBuffer()]),d)).rejects.toMatchObject({code:'TABLE_REPLICA_READBACK'});
 });
 it('等号开头原文仍是文字，无公式或网络访问',async()=>{
  const raw=attendanceReplica();raw.cells[0].text='=WEBSERVICE("https://example.test")';
  const d=normalizeTableReplica(raw), {blob}=await makeReplicaWorkbook(d),s=(await bookOf(blob)).worksheets[0];
  expect(s.getCell('A1').value).toBe(raw.cells[0].text);expect(s.getCell('A1').formula).toBeUndefined();
 });
 it('图片平面摆正90度与透视四角，不把照片旋转误作列行交换',()=>{
  const p=imagePlane([[0,1],[0,0],[1,0],[1,1]]);expect(p(0,0)).toEqual([0,1]);expect(p(1,0)).toEqual([0,0]);
  const q=imagePlane([[0.1,0.1],[0.9,0.05],[0.95,0.9],[0.02,0.8]]);
  expect(q(1,1)[0]).toBeCloseTo(0.95);expect(q(1,1)[1]).toBeCloseTo(0.9);
  expect(tableGridEvidence(null,specimen()).state).toBe('not_checked');
 });
 it('原图缺失不能退回通用台账，看图能力缺失不假造成功',async()=>{
  const tool=createDocumentGenerateTool({});
  await expect(tool.run({format:'xlsx',content:'|姓名|日期|',requirements:FRAME_REQUEST},{rawRequestText:FRAME_REQUEST})).rejects.toMatchObject({code:'TABLE_REPLICA_SOURCE'});
  await expect(restoreSpreadsheet({}, {sourcePath:'table.png',path:'result.xlsx'})).rejects.toMatchObject({code:'TABLE_REPLICA_VISION'});
 });
 it('不覆盖旧Excel，取消优先于调用，均不消耗视觉请求',async()=>{
  await ws.write('result.xlsx',new Blob(['keep'])); const visionLlm=vi.fn();
  await expect(restoreSpreadsheet({visionLlm},{sourcePath:'table.png',path:'result.xlsx'})).rejects.toMatchObject({code:'TABLE_REPLICA_EXISTS'});
  const c=new AbortController();c.abort();
  await expect(restoreSpreadsheet({visionLlm},{sourcePath:'table.png',path:'cancel.xlsx'},{signal:c.signal})).rejects.toMatchObject({name:'AbortError'});
  expect(visionLlm).not.toHaveBeenCalled();expect(await(await ws.readBlob('result.xlsx')).text()).toBe('keep');
 });
});

describe('还原回执不能被普通Excel零错误覆盖',()=>{
 it('未对照、普通台账和视觉失败都不准宣称原样还原',()=>{
  for(const validation of [{format:'xlsx',readback:'passed',errors:0},{format:'xlsx',readback:'passed',replica:'partial',visual:'failed',sourceGrid:'matched'}]) {
   const r=createExecutionReview(FRAME_REQUEST);r.artifact({path:'a.xlsx',validation});
   expect(r.guardsAnswer()).toBe(true);expect(r.checkAnswer('已经完整还原，与原图完全一致。').length).toBeGreaterThan(0);
   expect(r.guidance()).toContain('待核对稿');expect(r.checkAnswer('已保存待核对稿，尚未完整还原。')).toEqual([]);
  }
 });
 it('完整证据通过，修改文件后旧证据不能继续说已还原',()=>{
  const r=createExecutionReview(FRAME_REQUEST);
  r.artifact({path:'a.xlsx',validation:{format:'xlsx',readback:'passed',replica:'complete',sourceGrid:'matched',visual:'passed'}});
  r.record({name:'create_document',args:{path:'a.xlsx'},ok:true});
  expect(r.checkAnswer('已经完整还原。')).toEqual([]);
  r.record({name:'edit_spreadsheet',args:{path:'a.xlsx'},ok:true});
  expect(r.checkAnswer('已经完整还原。').length).toBeGreaterThan(0);
 });
 it('缺少Office对照在最终结果仍是部分完成',()=>{
  const r=createExecutionReview(FRAME_REQUEST);r.artifact({path:'a.xlsx',validation:{format:'xlsx',readback:'passed',replica:'partial',visual:'not_checked',sourceGrid:'matched'}});
  expect(r.report().artifacts[0].replica).toBe('partial');expect(reviewOutcome(r.report()).outcome).toBe('partial');
 });
});

describe('还原流程真实失败与预算边界',()=>{
 const png=()=>new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0))],{type:'application/octet-stream'});
 const context=()=>({canvasRenderer:{inspect:vi.fn(async()=>({frame:{width:10,height:10,data:new Uint8ClampedArray(400).fill(255)}}))},visionLlm:vi.fn(async()=>JSON.stringify(attendanceReplica()))});
 it('没有Office时保存可编辑稿但明确partial，不能因为0公式错误说完整还原',async()=>{
  await ws.write('input.png',png());const ctx=context(),consume=vi.fn(),checkpoint=vi.fn(),onFileChanged=vi.fn();ctx.onFileChanged=onFileChanged;
  const receipt=await restoreSpreadsheet(ctx,{sourcePath:'input.png',path:'partial.xlsx',requirements:FRAME_REQUEST},{retrieval:{consume},checkpoint});
  expect(receipt).toContain('还原核验未完整通过');expect(ctx.visionLlm).toHaveBeenCalledTimes(1);expect(consume).toHaveBeenCalledWith('model');
  expect(ctx.visionLlm.mock.calls[0][0].images[0].mime).toBe('image/png');
  expect(onFileChanged).toHaveBeenCalledTimes(1);expect(onFileChanged).toHaveBeenCalledWith('partial.xlsx');
  expect(checkpoint.mock.calls.at(-1)[0].validation).toMatchObject({replica:'partial',visual:'not_checked',sourceGrid:'not_checked'});
 });
 it('预算在模型请求前消费，耗尽后不调用模型或写猜测文件',async()=>{
  await ws.write('input.png',png());const ctx=context();const consume=vi.fn(()=>{throw Object.assign(new Error('budget'),{code:'RETRIEVAL_BUDGET'});});
  await expect(restoreSpreadsheet(ctx,{sourcePath:'input.png',path:'budget.xlsx'},{retrieval:{consume}})).rejects.toMatchObject({code:'RETRIEVAL_BUDGET'});
  expect(ctx.visionLlm).not.toHaveBeenCalled();expect(await ws.exists('budget.xlsx')).toBe(false);
 });
 it('提取JSON损坏不会改走Markdown或反复调用付费视觉',async()=>{
  await ws.write('input.png',png());const ctx=context();ctx.visionLlm.mockResolvedValue('```json\n{"columns":');
  await expect(restoreSpreadsheet(ctx,{sourcePath:'input.png',path:'bad.xlsx'})).rejects.toMatchObject({code:'TABLE_REPLICA_RESPONSE'});
  expect(ctx.visionLlm).toHaveBeenCalledTimes(1);expect(await ws.exists('bad.xlsx')).toBe(false);
 });
 it('核对失败保存partial且不付费重生成，保留用户原件',async()=>{
  const source=png();await ws.write('input.png',source);const ctx=context(),d=specimen();
  ctx.officeRender=vi.fn(async()=>({available:true,blob:new Blob(['%PDF-1.7'])}));ctx.presentationOverview=vi.fn(async()=>({pages:1,sheets:[{blob:png()}]}));
  ctx.visionLlm.mockResolvedValueOnce(JSON.stringify(attendanceReplica())).mockResolvedValueOnce(JSON.stringify({columns:37,rows:29,merges:d.cells.filter(c=>c.rs>1||c.cs>1).length,printedTextExact:false,clearedOnlyRequested:true,layoutMatches:false,issues:['日期与原图不符']}));
  const receipt=await restoreSpreadsheet(ctx,{sourcePath:'input.png',path:'review.xlsx',requirements:FRAME_REQUEST});
  expect(receipt).toContain('日期与原图不符');expect(receipt).toContain('待核对稿');expect(ctx.visionLlm).toHaveBeenCalledTimes(2);
  expect(ctx.presentationOverview).toHaveBeenCalledWith(expect.any(Blob),expect.objectContaining({singlePage:true}));
  expect(await(await ws.readBlob('input.png')).arrayBuffer()).toEqual(await source.arrayBuffer());
 });
 it('核对阶段预算/取消不被吞成普通成功，已经写出的文件保留',async()=>{
  await ws.write('input.png',png());const ctx=context();ctx.officeRender=async()=>{throw Object.assign(new Error('stopped'),{name:'AbortError'});};ctx.presentationOverview=vi.fn();
  await expect(restoreSpreadsheet(ctx,{sourcePath:'input.png',path:'stop.xlsx',requirements:FRAME_REQUEST})).rejects.toMatchObject({name:'AbortError'});
  expect(await ws.exists('stop.xlsx')).toBe(true);expect(ctx.visionLlm).toHaveBeenCalledTimes(1);
 });
 it('过小实际字号拒绝交付，不能把原图看不清变成不可读Excel',async()=>{
  const d=specimen();d.cells[0].font=4;
  await expect(makeReplicaWorkbook(d)).rejects.toMatchObject({code:'TABLE_REPLICA_SCALE'});
 });
});
