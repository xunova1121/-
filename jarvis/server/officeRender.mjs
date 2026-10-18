/** 可选的本机LibreOffice真实渲染；不上传文档，不接收任意命令。 */
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
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
 if(!['docx','pptx','xlsx'].includes(ext))throw new Error('不支持此格式的Office渲染');
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
   const result=await command(['-env:UserInstallation='+pathToFileURL(profile).href,'--headless','--nologo','--nodefault','--nolockcheck','--norestore','--convert-to','pdf','--outdir',dir,input],{cwd:dir,signal});
   const output=path.join(dir,'document.pdf');if(result.code!==0)throw new Error('Office渲染进程失败');
   if((await stat(output)).size>30e6)throw new Error('Office预览PDF过大');
   const data=await readFile(output);if(data.subarray(0,5).toString()!=='%PDF-')throw new Error('Office未生成有效PDF');
   return {available:true,engine:'LibreOffice',blob:new Blob([data],{type:'application/pdf'})};
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 tail=work;try{return await work;}finally{pending--;}
}
