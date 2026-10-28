/** 在用户服务器上运行未发布源码的真实任务。生产配置只读，独立store，报告不写模型凭据。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {format} from 'node:util';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {architectureServerInput} from './architecture-server-input.mjs';
import {architectureServerAcceptance} from './architecture-server-acceptance.mjs';
import {architectureServerReadiness,assertArchitectureRevision} from './architecture-server-readiness.mjs';
import {createFileStore} from '../server/fileStore.mjs';
import {createTaskRunner} from '../server/taskRunner.mjs';
import {useBackend} from '../src/agent/store.js';
import * as workspace from '../src/agent/workspace.js';
import * as sessions from '../src/agent/sessions.js';
import {seedBuiltins} from '../src/agent/skillPacks.js';
const terminal=state=>['done','error','stopped'].includes(state);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function main(args=process.argv.slice(2)){
 if(!args.includes('--live')){console.log('仅说明：显式--live后读取服务器现有配置，只复制指定DOCX到隔离store，发起一次真实模型任务。不会更新正式服务。');return;}
 assertArchitectureRevision(process.env.JARVIS_TEST_REVISION,process.env.JARVIS_ARCHITECTURE_EXPECTED_REVISION);
 const value=(key,fallback)=>args.find(item=>item.startsWith(key+'='))?.slice(key.length+1)||fallback;
 const dataDir=path.resolve(value('--data-dir','/opt/jarvis/data'));
 const source=value('--source','上传/重点水域禁捕项目正式招标文件.docx');
 const input=await architectureServerInput(dataDir,source);
 let folder;
 const requested=value('--out-dir','');
 if(requested){
  const parent=await fs.realpath(path.dirname(path.resolve(requested)));
  folder=path.join(parent,path.basename(requested));
  const production=await fs.realpath(dataDir);
  if(!folder.startsWith('/tmp/')||folder===production||folder.startsWith(production+path.sep))throw Object.assign(new Error('输出必须是/tmp下独立新目录'),{code:'ARCHITECTURE_TEST_INPUT'});
  await fs.mkdir(folder,{mode:0o700});
 }else folder=await fs.mkdtemp('/tmp/weiyang-architecture-live-');
 await fs.chmod(folder,0o700);await fs.mkdir(path.join(folder,'artifacts'),{mode:0o700});
 const report={schemaVersion:2,runId:randomUUID(),startedAt:new Date().toISOString(),source:input.source,selected:input.selected,codeRevision:/^[a-f0-9]{40}$/.test(process.env.JARVIS_TEST_REVISION||'')?process.env.JARVIS_TEST_REVISION:null,expectedRevision:process.env.JARVIS_ARCHITECTURE_EXPECTED_REVISION||null,mode:'isolated_server_task_runner',semantic:'not_reviewed',status:'starting',delivery:{state:'not_checked'},files:[],limitations:['真实模型与服务器任务引擎；未接入正式HTTP会话，不改生产store。','只复制选定原件并初始化内置技能，不复制生产历史、长期记忆或自定义技能。','任务结束、文件/模型审查验收、客户业务/视觉验收分别记录；完成状态不等于业务正确。']};
 const target=path.join(folder,'report.json');
 const save=()=>fs.writeFile(target,JSON.stringify(report,null,2),{mode:0o600});
 await save();
 const display=console.log.bind(console),previous={log:console.log,warn:console.warn,error:console.error};
 const logs=[];let logChars=0;
 for(const key of Object.keys(previous))console[key]=(...values)=>{const text=format(...values).slice(0,8000);if(logs.length<2000&&logChars+text.length<4e6){logs.push(text);logChars+=text.length;}};
 let runner,accepted,stopping=false,stopAt=0;
 const stop=()=>{if(!stopping)stopAt=Date.now();stopping=true;if(accepted)runner.stop(accepted.id);};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  report.readiness=await architectureServerReadiness();
  if(report.readiness.state==='blocked'){
   report.status='blocked_readiness';report.delivery={state:'failed',failure:{code:'ARCHITECTURE_TEST_RENDER_UNAVAILABLE'}};
   display('未发起模型请求：本次四格式/原生PPT实测缺少必需的Office或PDF栅格化依赖。');
   return {folder,report};
  }
  useBackend(createFileStore(path.join(folder,'state')));
  await workspace.write(input.source,new Blob([input.bytes],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));
  await seedBuiltins();
  runner=createTaskRunner({getConfig:async()=>input.cfg,maxRunning:1});
  const text=`请完整读取工作区原始招标文件${JSON.stringify(input.source)}中与总体架构有关的采购需求，制作项目总体架构图，并给出业务闭环和数据流专题。按实际职责区分系统边界、业务应用、共用能力、数据资源、感知接入、基础设施及贯穿保障；不把所有软件都归到业务层，不强迫补造材料没有的层。使用原文系统名和数量，设计推导与采购事实分开。请自主选择并执行现有架构工具，完成来源核对、业务规划、出图和预览检查。各视图SVG、PNG、PDF、原生可编辑PPT从同一设计稿导出，PPT与预览要一致。产物存到evals/${report.runId}/。遇到失败保留真实错误阶段和已有文件，不把草稿、旧图或纯图片PPT当完成。`;
  accepted=await runner.start({text,requestId:'architecture_'+randomUUID(),evaluationId:report.runId});
  report.taskId=accepted.id;report.sessionId=accepted.sessionId;
  display('已开始隔离架构实测，结果目录：'+folder);
  let lastSaved=0,lastSeq=-1,lastDisplay=0;
  const start=Date.now();
  for(;;){
   const task=runner.get(accepted.id);if(!task)throw Object.assign(new Error('测试任务状态缺失'),{code:'ARCHITECTURE_TEST_PROTOCOL'});
   report.status=task.status;report.task=task;
   if(task.seq!==lastSeq&&Date.now()-lastSaved>5000){report.events=runner.events(accepted.id)||[];await save();lastSeq=task.seq;lastSaved=Date.now();}
   if(Date.now()-lastDisplay>30000){display(`状态：${task.status}；已用${Math.round((Date.now()-start)/1000)}秒；事件${task.seq}`);lastDisplay=Date.now();}
   if(terminal(task.status))break;
   if(!stopping&&Date.now()-start>20*60*1000){report.clientTimeout=true;stop();}
   if(stopping&&Date.now()-stopAt>30000){report.status='stop_unconfirmed';break;}
   await pause(1000);
  }
  await Promise.race([runner.settled(),pause(20000)]);
  const session=await sessions.get(accepted.sessionId);
  report.answer=[...(session?.messages||[])].reverse().find(item=>item.role==='assistant')?.content||'';
  report.events=runner.events(accepted.id)||[];
  report.director={
   started:report.events.some(event=>event.type==='diagnostic'&&event.phase==='architecture_director_start'),
   ended:report.events.some(event=>event.type==='diagnostic'&&event.phase==='architecture_director_end'),
   mainModelCalls:report.task?.timing?.modelCalls??null
  };
  report.delivery=await architectureServerAcceptance('evals/'+report.runId);
  if(!report.director.started||!report.director.ended||report.director.mainModelCalls!==0){
   report.delivery.artifactsState=report.delivery.state;report.delivery.state='failed';
   report.delivery.failure={code:report.director.mainModelCalls>0?'ARCHITECTURE_TEST_MAIN_MODEL_REENTRY':'ARCHITECTURE_TEST_DIRECTOR_NOT_USED',field:'events'};
  }
  const files=(await workspace.list()).filter(item=>item.path!==input.source);
  if(files.length>200)throw Object.assign(new Error('输出文件超过200份，保留隔离store待核对'),{code:'ARCHITECTURE_TEST_SIZE'});
  let total=0;
  for(const item of files){
   const relative=workspace.normalize(item.path);if(relative.length>600)continue;
   const blob=await workspace.readBlob(relative);total+=blob.size;
   if(blob.size>20e6||total>100e6){report.files.push({path:relative,exported:false,reason:'超过私有导出容量'});continue;}
   const output=path.join(folder,'artifacts',relative);await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
   await fs.writeFile(output,new Uint8Array(await blob.arrayBuffer()),{mode:0o600});report.files.push({path:relative,size:blob.size,exported:true});
  }
  const deliveryFiles=report.delivery.views?.flatMap(view=>view.files.map(file=>file.path))||[];
  report.deliveryExported=deliveryFiles.length>0&&deliveryFiles.every(file=>report.files.some(item=>item.path===file&&item.exported));
  if(report.delivery.state==='complete'&&!report.deliveryExported){report.delivery.state='partial';report.delivery.failure={code:'ARCHITECTURE_TEST_ARCHIVE_PARTIAL'};}
 }catch(error){report.failure={code:String(error.code||error.name||'ERROR').slice(0,80)};report.status='runner_error';if(accepted&&!terminal(runner.get(accepted.id)?.status))runner.stop(accepted.id);}
 finally{
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  Object.assign(console,previous);
  report.finishedAt=new Date().toISOString();await save();await fs.writeFile(path.join(folder,'runtime-private.log'),logs.join('\n'),{mode:0o600});
  display('实测状态：'+report.status+'；文件交付：'+report.delivery.state+'；客户业务/视觉：尚待复核');display('私有报告：'+target);display('文件目录：'+path.join(folder,'artifacts'));display('报告包含原文/回答，勿直接公开；不含配置文件。');
 }
 return {folder,report};
}
export function architectureServerExitCode(result){return !result||(result.report.status==='done'&&result.report.delivery?.state==='complete'&&result.report.deliveryExported===true)?0:2;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().then(result=>{process.exitCode=architectureServerExitCode(result);if(result)process.stdout.write('',()=>process.exit(process.exitCode));}).catch(error=>{console.error('架构实测未启动：'+String(error.code||error.name||'ERROR')+'；请检查指定版本、服务器配置、原件路径和依赖，未输出凭据。');process.exitCode=1;});
