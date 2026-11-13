/** 可选的本机LibreOffice真实渲染；不上传文档，不接收任意命令。 */
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateSvg} from '../src/agent/svgPreview.js';
let capability=null,tail=Promise.resolve(),pending=0;
const binary=()=>process.env.JARVIS_SOFFICE||'soffice';
function command(args,{cwd,timeout=45000,signal}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new DOMException('Aborted','AbortError'));return;}
  const child=spawn(binary(),args,{cwd,env:{PATH:process.env.PATH,HOME:cwd||os.tmpdir(),LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  let output='',settled=false;
  const done=(error,code)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve({code,output});};
  const kill=()=>{try{process.platform!=='win32'?process.kill(-child.pid,'SIGKILL'):child.kill('SIGKILL');}catch{}};
  const abort=()=>{kill();done(new DOMException('Aborted','AbortError'));};
  const timer=setTimeout(()=>{kill();done(new Error('Office渲染超时，已停止'));},timeout);
  signal?.addEventListener('abort',abort,{once:true});
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{if(output.length<64000)output+=String(b).slice(0,64000-output.length);});
  child.once('error',e=>done(e));child.once('close',code=>done(null,code));
 });
}
export async function officeRenderAvailable(){
 capability??=command(['--version'],{timeout:5000}).then(x=>x.code===0).catch(()=>false);return capability;
}
export async function renderOffice(blob,ext,{signal}={}){
 if(signal?.aborted)throw new DOMException('Aborted','AbortError');
 if(!['docx','pptx','xlsx','svg'].includes(ext))throw new Error('不支持此格式的Office渲染');
 if(ext==='svg')validateSvg(await blob.text());
 if(!await officeRenderAvailable())return {available:false,reason:'服务器未安装LibreOffice，尚未进行Office真实渲染'};
 if(blob.size>20e6)throw new Error('Office预览超过20MB限制');
 if(pending>=4)throw new Error('Office预览繁忙，请稍后重试');pending++;
 const work=tail.catch(()=>{}).then(async()=>{
  if(signal?.aborted)throw new DOMException('Aborted','AbortError');
  const dir=await mkdtemp(path.join(os.tmpdir(),'jarvis-office-'));
  try{
   const profile=path.join(dir,'profile');await mkdir(path.join(profile,'user'),{recursive:true});
   await writeFile(path.join(profile,'user','registrymodifications.xcu'),'<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
   const input=path.join(dir,'document.'+ext);await writeFile(input,new Uint8Array(await blob.arrayBuffer()));
   const format=ext==='svg'?'png':'pdf';
   const result=await command(['-env:UserInstallation='+pathToFileURL(profile).href,'--headless','--nologo','--nodefault','--nolockcheck','--norestore','--convert-to',ext==='svg'?'png:draw_png_Export':'pdf','--outdir',dir,input],{cwd:dir,signal});
   const output=path.join(dir,'document.'+format);if(result.code!==0)throw new Error('Office渲染进程失败');
   if((await stat(output)).size>30e6)throw new Error('Office预览PDF过大');
   const data=await readFile(output);if(format==='pdf'&&data.subarray(0,5).toString()!=='%PDF-')throw new Error('Office未生成有效PDF');
   if(format==='png'&&data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Object.assign(new Error('Office未生成有效PNG'),{code:'SVG_RENDER_INVALID',kind:'api'});
   return {available:true,engine:'LibreOffice',blob:new Blob([data],{type:format==='png'?'image/png':'application/pdf'})};
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 tail=work;try{return await work;}finally{pending--;}
}

/** 真正Word97-2003只转换独立副本；PK伪装.doc仍由原内容识别处理。 */
export async function convertLegacyDoc(blob,{signal}={}){
 if(signal?.aborted)throw signal.reason;
 const head=Buffer.from(await blob.slice(0,8).arrayBuffer());
 if(head.toString('hex')!=='d0cf11e0a1b11ae1')throw Object.assign(new Error('不是Word97-2003的OLE文件，未按后缀强制转换'),{code:'LEGACY_DOC_TYPE'});
 if(blob.size>20e6)throw Object.assign(new Error('旧DOC超过20MB转换上限'),{code:'LEGACY_DOC_LIMIT'});
 if(!await officeRenderAvailable())throw Object.assign(new Error('旧DOC转换需要服务器安装LibreOffice'),{code:'LEGACY_DOC_UNAVAILABLE'});
 if(pending>=4)throw Object.assign(new Error('Office转换繁忙，请稍后重试'),{code:'LEGACY_DOC_BUSY'});pending++;
 const work=tail.catch(()=>{}).then(async()=>{
  if(signal?.aborted)throw signal.reason;
  const dir=await mkdtemp(path.join(os.tmpdir(),'jarvis-old-doc-'));
  try{
   const profile=path.join(dir,'profile');await mkdir(path.join(profile,'user'),{recursive:true});
   await writeFile(path.join(profile,'user','registrymodifications.xcu'),'<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
   const input=path.join(dir,'document.doc');await writeFile(input,new Uint8Array(await blob.arrayBuffer()));
   const result=await command(['-env:UserInstallation='+pathToFileURL(profile).href,'--headless','--nologo','--nodefault','--nolockcheck','--norestore','--convert-to','docx:Office Open XML Text','--outdir',dir,input],{cwd:dir,signal});
   const output=path.join(dir,'document.docx');if(result.code!==0)throw Object.assign(new Error('旧DOC转换进程失败'),{code:'LEGACY_DOC_FAILED'});
   const info=await stat(output);if(!info.isFile()||info.size>30e6)throw Object.assign(new Error('旧DOC转换输出无效或超过30MB'),{code:'LEGACY_DOC_OUTPUT'});
   const bytes=await readFile(output);if(bytes[0]!==0x50||bytes[1]!==0x4b)throw Object.assign(new Error('旧DOC未转换成有效DOCX'),{code:'LEGACY_DOC_OUTPUT'});
   return new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 tail=work;try{return await work;}finally{pending--;}
}
