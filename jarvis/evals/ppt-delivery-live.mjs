/** 隔离真实模型三轮；只读生产配置。机械通过仍需人工查看总览与回答。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {format} from 'node:util';
import {randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import {DEFAULT_CONFIG,createAdapter} from '../src/llm/config.js';
import {validateLiveConfig} from './baseline.mjs';
import {architectureServerReadiness} from './architecture-server-readiness.mjs';
import {createFileStore} from '../server/fileStore.mjs';
import {useBackend} from '../src/agent/store.js';
import {createTaskRunner} from '../server/taskRunner.mjs';
import * as ws from '../src/agent/workspace.js';
import * as sessions from '../src/agent/sessions.js';
import {seedBuiltins} from '../src/agent/skillPacks.js';
import {inspectDocument} from '../src/agent/documentQuality.js';
import {renderOffice} from '../server/officeRender.mjs';
import {presentationOverview} from '../server/presentationOverview.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const terminal=task=>['done','error','stopped'].includes(task?.status);
export function assessDelivery({step,status,elapsedMs,quality,rules,missing=[],rendered=false,renderedPages}) {
 const failures=[];
 if(status!=='done')failures.push('任务未正常完成');
 if(!quality||quality.errors)failures.push('真实文件未通过结构检查');
 if(!rendered)failures.push('未取得真实Office PDF');
 if(missing.length)failures.push('缺少原始赛程条目：'+missing.join('、'));
 if(step===1&&rules!==0)failures.push('Word仍有段落横线或尚未核对');
 if(step===1&&elapsedMs>=60000)failures.push('Word任务未达到60秒目标');
 if(step>1&&renderedPages!==quality?.slides)failures.push('真实PDF与PPT页数不一致或未核对');
 if(step>1&&!(quality?.slides>0&&quality.slides<=6))failures.push('PPT页数不在1至6页');
 if(step===3&&quality?.presentation?.imagePages!==quality?.slides)failures.push('并非每页都有内容图');
 if(step===3&&elapsedMs>=180000)failures.push('逐页补图未达到180秒目标');
 return {state:failures.length?'failed':'mechanical_pass',failures,visual:'not_reviewed',answer:'not_reviewed'};
}
export function privateValues(value, inherited=false) {
 return Object.entries(value||{}).flatMap(([key,item])=>{const secret=inherited||/key|token|secret|password/i.test(key);return item&&typeof item==='object'?privateValues(item,secret):secret&&typeof item==='string'&&item.length>=8?[item]:[];});
}
export async function main(args=process.argv.slice(2)) {
 if(!args.includes('--live')){console.log('加--live才读取服务器配置并请求当前模型；隔离执行Word→PPT→逐页补图，不更新正式服务。');return;}
 const option=(key,fallback)=>args.find(x=>x.startsWith(key+'='))?.slice(key.length+1)||fallback;
 const production=await fs.realpath(option('--data-dir','/opt/jarvis/data'));
 const requested=path.resolve(option('--out-dir','/tmp/weiyang-ppt-live-'+Date.now()));
 const parent=await fs.realpath(path.dirname(requested));
 if(parent!==path.dirname(requested)||!requested.startsWith('/tmp/')||requested===production||requested.startsWith(production+'/'))throw new Error('结果必须写到/tmp下独立新目录');
 await fs.mkdir(requested,{mode:0o700});
 const report={version:1,codeRevision:process.env.JARVIS_TEST_REVISION||null,state:'starting',startedAt:new Date().toISOString(),productionChanged:false,cases:[],visual:'not_reviewed',limitations:['只核对虚构赛程编号完整性，字段事实与回答仍需人工复核','普通PPT沿用原Word，同一隔离会话连续三步；不读取正式历史或长期记忆','图库国内可用性需另做探测，逐页配图允许按用户请求降级AI']};
 const target=path.join(requested,'report.json');let secrets=[];
 const redact=text=>secrets.reduce((s,key)=>s.split(key).join('[REDACTED]'),text);
 const save=()=>fs.writeFile(target,redact(JSON.stringify(report,null,2)),{mode:0o600});
 const display=console.log.bind(console),previous={log:console.log,warn:console.warn,error:console.error};
 let runner,active,stopped=false;const logs=[];let logSize=0;
 const stop=()=>{stopped=true;if(active)runner.stop(active.id);};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  const cfgPath=path.join(production,'config.json');if((await fs.stat(cfgPath)).size>2e6)throw new Error('配置大小不符合限制');
  const saved=JSON.parse(await fs.readFile(cfgPath,'utf8'));
  secrets=privateValues(saved);
  const cfg={...DEFAULT_CONFIG,...saved,autoMemory:false};report.selected=validateLiveConfig(cfg);
  if(createAdapter(cfg).problem)throw new Error('当前模型配置不完整');
  report.readiness=await architectureServerReadiness();
  if(report.readiness.state==='blocked'||!report.readiness.pdfRasterEngines.pdftoppm){report.state='blocked_readiness';report.reason='缺少LibreOffice或pdftoppm，尚未请求模型';return report;}
  useBackend(createFileStore(path.join(requested,'state')));await seedBuiltins();
  for(const key of Object.keys(previous))console[key]=(...args)=>{const line=redact(format(...args)).slice(0,4000);if(logs.length<1500&&logSize+line.length<2e6){logs.push(line);logSize+=line.length;}};
  const ids=Array.from({length:20},(_,i)=>'赛事'+String(i+1).padStart(2,'0'));
  const material='全部为虚构数据，不查询真实比赛。\n|编号|开赛时间|对阵|状态|\n|---|---|---|---|\n'+ids.map((id,i)=>`|${id}|${18+Math.floor(i/8)}:${i%2?'30':'00'}|队伍${i+1}—队伍${i+21}|未开赛|`).join('\n');
  await ws.write('uploads/虚构赛程.md',material);
  const prompts=[
   '请读取 uploads/虚构赛程.md，做一份清爽Word，保留完整20条编号、时间、对阵与状态，不要段落横线。交付 outputs/赛程.docx 及预览PDF，核对真实文件后回答。',
   '沿用刚才的Word outputs/赛程.docx，制作清爽PPT，保留完整20条赛程，最多6页，封面有设计，使用数字卡、体育图标和基于真实表格的时段统计。交付 outputs/赛程.pptx 及真实预览。',
   '沿用 outputs/赛程.pptx，给每页补一张与球场或体育概念相关的内容配图（图标不算），不删20条赛程，不超过6页。不要真实球员和赛事照片。可用已验证图库或图片生成工具；没有可用能力要明确报告，不假称配齐。另存 outputs/赛程配图.pptx，保留之前Word和PPT，输出真实总览并核对页数与配图数。'
  ];
  runner=createTaskRunner({getConfig:async()=>cfg,maxRunning:1});let sessionId=null;
  for(let i=0;i<3&&!stopped;i++){
   const step=i+1,file=['outputs/赛程.docx','outputs/赛程.pptx','outputs/赛程配图.pptx'][i],started=Date.now();
   active=await runner.start({text:prompts[i],sessionId,evaluationId:randomUUID(),requestId:'ppt_'+randomUUID()});sessionId=active.sessionId;
   const item={step,file,status:'running'};report.cases.push(item);report.state='running';let lastSave=0;
   while(!terminal(runner.get(active.id))){
    if(Date.now()-started>600000||stopped){runner.stop(active.id);stopped=true;break;}
    if(Date.now()-lastSave>15000){item.elapsedMs=Date.now()-started;await save();display(`第${step}/3步：running；${Math.round(item.elapsedMs/1000)}秒`);lastSave=Date.now();}
    await pause(1000);
   }
   if(stopped)await Promise.race([runner.settled(),pause(30000)]);
   const task=runner.get(active.id);Object.assign(item,{status:task?.status||'missing',elapsedMs:Date.now()-started,timing:task?.timing,events:runner.events(active.id)||[]});
   const session=await sessions.get(sessionId);item.answer=[...(session?.messages||[])].reverse().find(x=>x.role==='assistant')?.content||'';
   if(stopped){item.assessment={state:'failed',failures:['任务停止或超过10分钟上限']};break;}
   try{
    const blob=await ws.readBlob(file);if(!blob||blob.size>20e6)throw new Error('未取得有效交付文件');
    const ext=step===1?'docx':'pptx',zip=await JSZip.loadAsync(await blob.arrayBuffer());
    const names=Object.keys(zip.files).filter(p=>step===1?p==='word/document.xml':/^ppt\/slides\/slide\d+\.xml$/.test(p));
    const xml=(await Promise.all(names.map(p=>zip.file(p).async('string')))).join('\n');
    const text=xml.replace(/<[^>]+>/g,'');item.missing=ids.filter(id=>!text.includes(id));
    if(step===1){const parts=await Promise.all(Object.keys(zip.files).filter(p=>/^word\/(?:document|styles|header\d+|footer\d+)\.xml$/.test(p)).map(p=>zip.file(p).async('string')));item.rules=parts.flatMap(s=>[...s.matchAll(/<w:pBdr\b[^>]*>[\s\S]*?<\/w:pBdr>/g)]).filter(m=>/<w:(?:top|bottom)\b/.test(m[0])).length;}
    item.quality=await inspectDocument(blob,file,{requirements:step===3?'每页都有图':''});
    const dir=path.join(requested,'artifacts','step-'+step);await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.writeFile(path.join(dir,path.basename(file)),new Uint8Array(await blob.arrayBuffer()),{mode:0o600});
    const render=await renderOffice(blob,ext,{signal:AbortSignal.timeout(60000)});item.rendered=Boolean(render.available);
    if(render.available){await fs.writeFile(path.join(dir,'预览.pdf'),new Uint8Array(await render.blob.arrayBuffer()),{mode:0o600});if(step>1){const overview=await presentationOverview(render.blob,{signal:AbortSignal.timeout(60000)});for(const [n,sheet]of overview.sheets.entries())await fs.writeFile(path.join(dir,`总览-${n+1}.png`),new Uint8Array(await sheet.blob.arrayBuffer()),{mode:0o600});item.renderedPages=overview.pages;}}
    item.assessment=assessDelivery(item);
   }catch(error){item.assessment={state:'failed',failures:['文件读取/检查/真实渲染失败'],code:/^[A-Z_]{1,60}$/.test(error.code||'')?error.code:null};}
   await save();display(`第${step}/3步：${item.status}；${Math.round(item.elapsedMs/1000)}秒；${item.assessment.state}`);
   if(item.status!=='done'||!item.quality)break;
  }
  report.state=report.cases.length===3&&report.cases.every(x=>x.assessment?.state==='mechanical_pass')?'awaiting_visual_review':'failed';
 }catch(error){report.state='blocked_or_error';report.failure={code:/^[A-Z_]{1,60}$/.test(error.code||'')?error.code:'PPT_LIVE_ERROR'};}
 finally{
  if(active&&!terminal(runner?.get(active.id)))runner.stop(active.id);
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);Object.assign(console,previous);
  report.finishedAt=new Date().toISOString();await save();await fs.writeFile(path.join(requested,'runtime-private.log'),logs.join('\n'),{mode:0o600});
  display('状态：'+report.state+'；真实回答/视觉尚需复核；报告：'+target);display('正式服务与配置未修改；报告含模型回答，勿直接公开。');
 }
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().then(report=>{process.exitCode=!report||report.state==='awaiting_visual_review'?0:2;process.stdout.write('',()=>process.exit(process.exitCode));}).catch(()=>{console.error('测试未启动，请核对配置目录与独立输出目录；未回显凭据。');process.exitCode=1;});
