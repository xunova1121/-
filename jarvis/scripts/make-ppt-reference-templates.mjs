/** 按用户提供的版式结构重新绘制：全部原生可编辑文字/形状；不复制原文件、品牌、截图或项目数据。 */
import pptxgen from 'pptxgenjs';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'src/assets/ppt-sources');
const render=process.argv[2]||'/tmp/weiyang-ppt-reference-render';await fs.mkdir(render,{recursive:true});
const records=[];
const memo='未央根据用户提供材料的通用版式结构重新绘制。所有文字框、图形、流程连接均可编辑；原公司标识、项目文字、真实数据、地图、截图、视频及其链接均未复制。图片区域为可替换占位，请插入本人有权使用的图片。点击【】文字填写；复制适合的页面后删除不用的页面。';
function make(kind){
 const tech=kind==='technical';const id=tech?'reference-technical':'reference-roadshow';
 const ppt=new pptxgen();ppt.layout='LAYOUT_WIDE';ppt.author='未央 WEIYANG AI';ppt.title=tech?'清蓝红 · 技术建设方案':'蓝绿 · 行业路演';ppt.subject='可直接填写的原生模板';ppt.lang='zh-CN';
 ppt.theme={headFontFace:'Noto Sans CJK SC',bodyFontFace:'Noto Sans CJK SC',lang:'zh-CN'};
 const C={blue:tech?'173750':'0576CB',accent:tech?'F04F53':'87B954',muted:'71899A',soft:'F4F7F9',line:'D9E3EA'};
 const text=(s,t,x,y,w,h,size=16,color=C.blue,opts={})=>s.addText(t,{x,y,w,h,fontSize:size,color,fontFace:'Noto Sans CJK SC',margin:0,breakLine:false,valign:'mid',...opts});
 const box=(s,x,y,w,h,color=C.soft,stroke)=>s.addShape(ppt.ShapeType.rect,{x,y,w,h,line:{color:stroke||color,transparency:stroke?0:100,width:.8},fill:{color}});
 const line=(s,x,y,w,color=C.line,h=0)=>s.addShape(ppt.ShapeType.line,{x,y,w,h,line:{color,width:1.2}});
 const circle=(s,x,y,r,fill)=>s.addShape(ppt.ShapeType.ellipse,{x,y,w:r,h:r,fill:{color:fill},line:{transparency:100}});
 const number=(s,n,x,y)=>{circle(s,x,y,.38,C.blue);text(s,String(n),x,y,.38,.38,13,'FFFFFF',{align:'center',bold:true});};
 const foot=s=>{text(s,'【单位 / 项目名称】',.55,7.04,10,.23,8,C.muted);text(s,String(ppt._slides.length),12.16,7.04,.6,.23,9,C.muted,{align:'right'});s.addNotes(memo);};
 const page=(title='',sub='')=>{const s=ppt.addSlide();s.background={color:'FFFFFF'};if(title){if(tech){text(s,String(ppt._slides.length-1).padStart(2,'0'),.55,.45,1.55,.72,42,'E6EAED',{bold:true});line(s,2.12,.56,.65,C.accent);text(s,title,2.12,.82,10.55,.6,25,C.blue,{bold:true});}else{text(s,title,.5,.36,11.4,.5,23,C.blue,{bold:true});line(s,.5,1.02,12.3,'E5EDF2');}if(sub)text(s,sub,.65,tech?1.69:1.23,12,.55,15,C.muted,{align:tech?'left':'center'});}foot(s);return s;};
 const para=(s,x,y,w,rows=3)=>{for(let i=0;i<rows;i++){circle(s,x,y+i*.46+.14,.055,C.accent);text(s,`【填写要点 ${i+1}：事实、依据或说明】`,x+.18,y+i*.46,w-.18,.4,13,C.muted);}};
 const image=(s,x,y,w,h,label='【插入图片 / 截图】')=>{box(s,x,y,w,h,'F0F5F8','C7D8E4');s.addShape(ppt.ShapeType.line,{x:x+.15,y:y+.15,w:w-.3,h:h-.3,line:{color:'D6E2E9',width:.7}});s.addShape(ppt.ShapeType.line,{x:x+.15,y:y+h-.15,w:w-.3,h:-(h-.3),line:{color:'D6E2E9',width:.7}});box(s,x+w*.08,y+h*.42,w*.84,.53,'F0F5F8');text(s,label,x+.1,y+h*.42,w-.2,.53,Math.min(16,w*4),C.muted,{align:'center'});};
 const band=(s,t,y=6.4)=>{box(s,.55,y,12.2,.45,C.blue);box(s,.55,y,.055,.45,C.accent);text(s,t,.75,y,11.8,.45,13,'FFFFFF');};
 const cols=(s,titles,y=2.45,h=3.65)=>titles.forEach((t,i)=>{const x=.65+i*4.2;box(s,x,y,3.85,h);line(s,x,y,3.85,i===1?C.accent:C.blue);text(s,t,x+.2,y+.23,3.45,.55,20,C.blue,{bold:true});para(s,x+.23,y+1.1,3.35,4);});
 if(tech){
  let s=page();text(s,'【项目 / 平台名称】\n建设与设计方案',.7,1.65,5.75,1.65,32,C.blue,{bold:true});line(s,.72,3.65,0,C.muted,1.04);text(s,'【填写一句话建设愿景】\n【补充目标与价值】',.95,3.65,5.2,1.05,17,C.muted);text(s,'汇报人：【姓名 / 团队】\n日期：【年 月 日】',.72,5.86,5.6,.7,13,C.muted);box(s,7.05,.35,5.9,6.55,C.blue);for(let i=0;i<5;i++){circle(s,7.75+i*.4,1.3+i*.4,3.7-i*.5,['244C69','2D5E7E','3D7695','5495AE','7AB9C9'][i]);}text(s,'【替换主视觉】',7.4,5.8,5.1,.5,18,'FFFFFF',{align:'center'});
  s=page('【总体建设目标】','【用一至两句话概括建设范围、核心目标与预期价值】');
  ['【目标一】','【目标二】','【目标三】'].forEach((t,i)=>{const x=.7+i*4.2;box(s,x,3.05,.6,.6,C.blue);text(s,String(i+1),x,3.05,.6,.6,21,'FFFFFF',{align:'center'});text(s,t,x,3.95,3.6,.5,22,C.blue,{bold:true});text(s,'【填写目标说明、衡量口径与验收指标】',x,4.7,3.5,1.15,16,C.muted);if(i<2)line(s,x+3.8,3.05,0,C.line,2.8);});
  s=page('【技术实现路径】','【描述数据、能力和业务如何形成闭环】');cols(s,['【接入 / 感知层】','【平台 / 能力层】','【业务 / 应用层】']);text(s,'→',4.5,3.1,.5,.5,24,C.accent,{align:'center'});text(s,'→',8.7,3.1,.5,.5,24,C.accent,{align:'center'});band(s,'【填写本页最重要的技术原则或设计结论】');
  s=page('【平台全景架构】','【填写总体架构说明，各模块之间的职责与接口】');
  [[.65,2.45,5.95,2.55,'【业务与场景层】'],[6.75,2.45,5.95,2.55,'【算法与能力层】'],[.65,5.17,12.05,1.35,'【资源与调度层】']].forEach(([x,y,w,h,t])=>{box(s,x,y,w,h,'FFFFFF',C.muted);box(s,x+.18,y+.22,w>8?3:2.55,h-.44,C.blue);text(s,t,x+.25,y+.28,w>8?2.85:2.4,h-.56,18,'FFFFFF',{align:'center',bold:true});text(s,'【填写模块职责】\n【填写接口与协作方式】',x+(w>8?3.5:2.95),y+.35,w-(w>8?3.75:3.2),h-.7,15,C.muted);});
  s=page('【核心能力清单与场景矩阵】','【按对象、业务领域或建设阶段整理核心能力】');['【类别 A】','【类别 B】','【类别 C】'].forEach((t,i)=>{const x=.65+i*4.2;box(s,x,2.45,3.85,.53,C.blue);text(s,t,x+.15,2.45,3.55,.53,18,'FFFFFF',{bold:true});for(let j=0;j<5;j++){box(s,x,3.1+j*.52,3.85,.43);text(s,`□  【能力 / 场景 ${j+1}】`,x+.14,3.1+j*.52,3.55,.43,14);}});band(s,'【填写能力覆盖范围及重点说明】');
  s=page('【关键技术与融合方案】','【按三个关键技术点，解释方案如何解决实际问题】');text(s,'【核心价值】',.7,3.1,3.5,.7,27,C.blue,{bold:true});text(s,'【填写一段概述】\n【说明与现有方式的不同】',.7,4.05,3.5,1.2,16,C.muted);line(s,4.48,2.75,0,C.line,3.5);for(let i=0;i<3;i++){text(s,`0${i+1}`,4.95,2.68+i*1.2,.7,.5,24,'CBD4DC',{bold:true});text(s,`【技术点 ${i+1}】`,5.9,2.68+i*1.2,6.4,.5,20,C.blue,{bold:true});text(s,'【填写实现方式、输入输出与优势】',5.9,3.27+i*1.2,6.3,.4,14,C.muted);}
  s=page('【两类重点场景对比】');['【场景 / 算法 A】','【场景 / 算法 B】'].forEach((t,i)=>{const x=.7+i*6.3;text(s,t,x,2,5.7,.6,22,C.blue,{bold:true});for(let j=0;j<3;j++){text(s,`▪  【分析维度 ${j+1}】`,x,2.95+j*.83,5.6,.4,16,C.blue,{bold:true});text(s,'【填写本维度的实现方法与判断依据】',x+.2,3.38+j*.83,5.35,.35,13,C.muted);}box(s,x,5.7,5.7,.7);box(s,x,5.7,.045,.7,C.accent);text(s,'【关键触发条件 / 验收标准】',x+.18,5.82,5.3,.4,13);});
  s=page('【多级流程与闭环机制】');['【发现 / 触发】','【分级 / 调度】','【处置 / 归档】'].forEach((t,i)=>{const x=.7+i*4.2;text(s,`PHASE 0${i+1}`,x,2.05,3.65,.35,10,C.accent,{bold:true});text(s,t,x,2.57,3.65,.55,21,C.blue,{bold:true});para(s,x,3.43,3.65,4);});box(s,.65,5.85,12.05,.91,C.blue);['【指标一】','【指标二】','【指标三】'].forEach((t,i)=>{text(s,'【数值】',.8+i*4.1,5.9,3.8,.42,23,C.accent,{align:'center',bold:true});text(s,t,.8+i*4.1,6.38,3.8,.25,11,'FFFFFF',{align:'center'});});
  s=page('【保障体系与合规要求】');for(let i=0;i<3;i++){const y=2.05+i*1.35;box(s,.65,y,12,.98);box(s,.65,y,.045,.98,i===1?C.accent:C.blue);text(s,['【基础适配】','【安全保障】','【运行保障】'][i],.85,y+.13,2.65,.7,19,C.blue,{bold:true});text(s,'【填写保障措施、适用规范与具体要求】',3.65,y+.13,5.75,.7,14,C.muted);for(let j=0;j<3;j++){box(s,9.72,y+j*.32,2.75,.29,i===1?C.accent:C.blue);text(s,`【要点 ${j+1}】`,9.8,y+j*.32,2.59,.29,10,'FFFFFF',{align:'center'});}}band(s,'【填写合规边界、责任主体与持续保障机制】');
  s=page('【建设计划与交付路线图】');line(s,.8,2.5,5.4,C.blue);for(let i=0;i<4;i++){const x=.8+i*1.8;circle(s,x-.075,2.425,.15,C.accent);text(s,`【阶段 ${i+1}】`,x-.1,2.9,1.6,.45,14,C.blue,{bold:true});text(s,'【起止时间】',x-.1,3.5,1.6,.32,11,C.accent);text(s,'【核心任务】\n【阶段成果】\n【责任人】',x-.1,4.1,1.6,1.6,12,C.muted);}box(s,7.5,2.27,5.15,.55,C.blue);text(s,'交付项        时间          验收要求',7.7,2.27,4.8,.55,13,'FFFFFF');for(let i=0;i<4;i++){box(s,7.5,2.9+i*.78,5.15,.68);text(s,'【名称】    【日期】    【填写要求】',7.68,3.02+i*.78,4.8,.42,12,C.muted);}
 }else{
  let s=page();text(s,'【行业 / 主题】路演汇报',.6,.43,10,.4,15,C.blue);text(s,'【填写项目主标题】\n【填写一句话核心价值】',1.1,2.15,11.1,1.65,34,C.blue,{align:'center',bold:true});text(s,'【汇报单位】\n【年 月】',2.8,4.6,7.7,.75,16,C.blue,{align:'center'});for(let i=0;i<4;i++)s.addShape(ppt.ShapeType.wave,{x:-.2,y:6.05+i*.21,w:13.75,h:1.1,rotate:0,line:{transparency:100},fill:{color:['D3F5EC','A8E8E3','83D3E4','56B9DE'][i],transparency:12}});
  s=page('【单位 / 团队介绍】','【用一句话概括团队优势与服务能力】');['【资源与连接】','【技术与平台】','【服务与经验】'].forEach((t,i)=>{const x=.65+i*4.2;box(s,x,2.15,3.85,3.76,'FFFFFF','D6E1E8');box(s,x,2.15,3.85,.58,[C.blue,C.accent,'E59652'][i]);text(s,t,x+.2,2.15,3.45,.58,20,'FFFFFF',{bold:true,align:'center'});para(s,x+.25,3.02,3.35,5);});box(s,.65,6.14,12.05,.53,'F1F5F8');text(s,'【填写代表性成果、核心资质或服务承诺】',.9,6.14,11.5,.53,16,C.blue,{align:'center'});
  s=page('【路演汇报概要】');['项目背景与痛点','解决方案与实施','项目成效与展望'].forEach((t,i)=>{const y=1.8+i*1.48;box(s,1.35,y,10.65,1.08,'F5F9FC');text(s,`0${i+1}`,1.85,y+.19,1.3,.65,30,C.blue,{bold:true});text(s,'【'+t+'】',3.5,y+.13,7.6,.47,23,C.blue,{bold:true});text(s,'【填写本章节的一句话概述】',3.5,y+.65,7.6,.3,14,C.muted);});
  s=page('一、【项目背景与核心痛点】','【简要说明行业环境、服务对象与目前存在的问题】');[['【指标 1】',.65],['【指标 2】',4.85],['【指标 3】',9.05]].forEach(([t,x])=>{box(s,x,1.95,3.85,.6,'ECF5FB');text(s,t+'  【填写数值与单位】',x+.15,1.95,3.55,.6,15);});for(let i=0;i<4;i++){const x=.65+i%2*3.6,y=2.85+Math.floor(i/2)*1.7;box(s,x,y,3.35,1.45,'F5F9FC','E1EBF2');number(s,i+1,x+.16,y+.18);text(s,'【痛点标题】',x+.72,y+.15,2.4,.45,18,C.blue,{bold:true});text(s,'【填写具体问题】\n【说明业务影响】',x+.2,y+.78,2.95,.56,13,C.muted);}image(s,8.05,2.85,4.65,3.15,'【插入区域图 / 现状图片】');
  s=page('二、【解决方案：总体思路】','【从底座、能力到业务应用，说明整体解决路径】');for(let i=0;i<2;i++){const x=.65+i*6.3;text(s,['【基础设施 / 连接底座】','【数据与计算 / 能力平台】'][i],x,1.95,5.95,.5,20,C.blue,{bold:true});text(s,'【填写本层设计原则与核心建设内容】',x,2.58,5.95,.5,14,C.muted);}box(s,.65,3.4,12.05,.63,C.blue);text(s,'【统一业务平台 / 行业应用中枢】',.95,3.4,11.45,.63,22,'FFFFFF',{align:'center',bold:true});['【感知接入】','【智能分析】','【业务调度】','【闭环服务】'].forEach((t,i)=>{const x=.8+i*3.15;box(s,x,4.52,2.75,1.07,'F0F6FB','C7DBEA');text(s,t,x+.15,4.75,2.45,.5,20,C.blue,{align:'center',bold:true});if(i<3)text(s,'→',x+2.8,4.74,.3,.5,20,C.accent,{align:'center'});});text(s,'【填写数据与服务流转说明，以及方案的总体价值】',.8,6.1,11.9,.5,15,C.blue,{align:'center'});
  s=page('二、【解决方案：场景演示】','【填写演示场景、主要过程及观看重点】');image(s,1.25,2,10.8,4.2,'【插入现场图片 / 视频封面】');text(s,'【填写演示内容与关键观察点】',1.3,6.25,10.7,.3,14,C.blue,{align:'center'});text(s,'【说明：视频请自行插入，模板不携带原视频及外部链接】',1.3,6.65,10.7,.24,10,C.muted,{align:'center'});
  s=page('二、【解决方案：能力详解】','【围绕四个关键环节展开说明】');image(s,.65,2.05,3.5,1.92,'【截图一】');image(s,.65,4.25,3.5,1.92,'【截图二】');for(let i=0;i<4;i++){const x=4.5+i%2*4.2,y=2.05+Math.floor(i/2)*2.2;box(s,x,y,3.85,1.92,'F6F9FB');number(s,i+1,x+.12,y+.12);text(s,`【能力 ${i+1}】`,x+.65,y+.12,2.9,.4,18,C.blue,{bold:true});text(s,'【填写实现方式】\n【填写输入与输出】\n【填写带来的价值】',x+.2,y+.75,3.4,.92,14,C.muted);}
  s=page('二、【解决方案：双端协同】','【说明不同角色 / 终端如何协同工作】');for(let i=0;i<2;i++){const y=2.02+i*2.25;image(s,.65,y,3.6,1.95,'【终端界面 '+(i+1)+'】');box(s,4.55,y,.73,1.95,i?C.accent:C.blue);text(s,i?'端\n二':'端\n一',4.55,y+.3,.73,1.3,20,'FFFFFF',{align:'center'});for(let j=0;j<3;j++){text(s,`【功能 ${j+1}】`,5.48+j*2.43,y+.2,2.22,.45,17,C.blue,{bold:true});text(s,'【填写功能说明】\n【填写协作结果】',5.48+j*2.43,y+.87,2.22,.8,13,C.muted);}}
  s=page('二、【解决方案：服务闭环】','【用三个环节说明业务处理与知识沉淀过程】');image(s,.65,2.05,3.5,1.92,'【业务截图】');image(s,.65,4.25,3.5,1.92,'【现场图片】');for(let i=0;i<3;i++){const y=2.05+i*1.44;box(s,4.55,y,2.2,1.05,i===1?C.accent:C.blue);text(s,`【环节 ${i+1}】`,4.7,y+.15,1.9,.75,19,'FFFFFF',{align:'center',bold:true});text(s,'【填写业务步骤、输入材料与输出成果】',7.05,y+.12,5.4,.38,15,C.blue,{bold:true});text(s,'【补充责任主体、关键要求和质量标准】',7.05,y+.65,5.4,.35,13,C.muted);}
  s=page('三、【项目成效与亮点】','【用可核对的数据和案例说明变化，不填未经核实的成果】');for(let i=0;i<3;i++){image(s,.65,2.03+i*1.46,3.2,1.27,`【案例图片 ${i+1}】`);text(s,`【成效维度 ${i+1}】`,4.3,2.05+i*1.46,8.2,.44,21,C.blue,{bold:true});text(s,'【填写前后对比的数据、口径和时间】\n【填写案例事实及其来源】',4.3,2.62+i*1.46,8.1,.65,14,C.muted);}
  s=page();s.background={color:'075DAA'};circle(s,.45,.6,2.5,'0868B5');circle(s,11.1,5.2,1.75,'106EBA');text(s,'【填写项目愿景 / 结束语】',.8,2.6,11.7,.95,33,'FFFFFF',{align:'center',bold:true});text(s,'【填写简短的补充说明】',1.2,3.85,10.9,.5,16,'D2E7F7',{align:'center'});line(s,6.15,4.75,1,'9BCDED');text(s,'感  谢  聆  听',2.8,5.12,7.7,.65,23,'FFFFFF',{align:'center'});text(s,'【单位名称】',2.8,6.05,7.7,.32,12,'CBE3F4',{align:'center'});text(s,'【联系方式】',2.8,6.49,7.7,.28,10,'CBE3F4',{align:'center'});
 }
 return {ppt,id,name:ppt.title,pages:ppt._slides.length,scene:tech?'技术建设方案':'行业路演',source:'用户提供版式参考；未央原生重建（不含原文件内容）',license:'未央重建样板',editable:true};
}
for(const kind of ['technical','roadshow']){
 const {ppt,...t}=make(kind);const filename=t.id+'.pptx';await ppt.writeFile({fileName:path.join(out,filename)});
 const zip=await JSZip.loadAsync(await fs.readFile(path.join(out,filename)));zip.remove('ppt/embeddings');await fs.writeFile(path.join(out,filename),await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
 const bytes=await fs.readFile(path.join(out,filename));records.push({...t,filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 execFileSync('soffice',['-env:UserInstallation=file:///tmp/weiyang-ppt-reference-lo','--headless','--convert-to','pdf','--outdir',render,path.join(out,filename)],{timeout:90000});
 execFileSync('pdftoppm',['-jpeg','-scale-to','1440',path.join(render,t.id+'.pdf'),path.join(render,t.id)],{timeout:90000});
 for(let n=1;n<=t.pages;n++)await fs.copyFile(path.join(render,`${t.id}-${String(n).padStart(t.pages>=10?2:1,'0')}.jpg`),path.join(out,`${t.id}-${n}.jpg`));
 // POTX 双击可新建演示文稿；作为用户下载附件提供，不额外增加运行时代码。
 let types=await zip.file('[Content_Types].xml').async('string');types=types.replace('presentationml.presentation.main+xml','presentationml.template.main+xml');zip.file('[Content_Types].xml',types);await fs.writeFile(path.join(render,t.id+'.potx'),await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
 console.log(`${t.name}：${t.pages}页 PPTX / POTX / PDF / 逐页JPG`);
}
const catalog=JSON.parse(await fs.readFile(path.join(out,'catalog.json'),'utf8')).filter(x=>!x.id.startsWith('reference-'));
await fs.writeFile(path.join(out,'catalog.json'),JSON.stringify([...records,...catalog],null,2)+'\n');
