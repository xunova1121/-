/** 小文件差量准备未发布测试代码；不下载仓库历史/无关资产，不修改正式安装。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const invalid=()=>Object.assign(new Error('测试源码清单不合法'),{code:'ARCHITECTURE_RUNTIME_MANIFEST'});
export function validateRuntimeManifest(manifest){
 if(manifest.version!==1||!/^[a-f0-9]{40}$/.test(manifest.revision)||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>1000)throw invalid();
 let total=0;const seen=new Set();
 for(const file of manifest.files){
  if(typeof file.path!=='string'||file.path.length>400||file.path.includes('\\')||file.path.split('/').some(part=>!part||part==='.'||part==='..')||!(/^(?:src|server|shared|evals)\//.test(file.path)||['package.json','package-lock.json'].includes(file.path))||seen.has(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>20e6)throw invalid();
  seen.add(file.path);total+=file.bytes;
 }
 if(total>100e6)throw invalid();
 return manifest;
}
async function matches(file,item){try{const stat=await fs.stat(file);return stat.isFile()&&stat.size===item.bytes&&digest(await fs.readFile(file))===item.sha256;}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return false;throw error;}}
async function download(url,target,max){await promisify(execFile)('curl',['--fail','--silent','--show-error','--connect-timeout','15','--max-time','60','--retry','2','--retry-delay','2','--max-filesize',String(Math.max(max,1)),url,'-o',target],{timeout:200000,maxBuffer:64000});}
export async function prepareRuntime(manifest,production,target,{fetchFile=download,progress=()=>{}}={}){
 validateRuntimeManifest(manifest);
 const sourceRoot=await fs.realpath(production);
 const destination=await fs.realpath(target).catch(error=>{if(error.code==='ENOENT')return path.resolve(target);throw error;});
 if(destination===sourceRoot||destination.startsWith(sourceRoot+path.sep))throw invalid();
 const result={reused:0,downloaded:0,downloadedBytes:0};let next=0,done=0,cancelled=false;
 await fs.mkdir(target,{recursive:true,mode:0o700});
 async function worker(){
  while(!cancelled&&next<manifest.files.length){
   const item=manifest.files[next++],output=path.join(target,item.path);
   await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
   if(await matches(output,item)){result.reused++;}
   else if(await matches(path.join(production,item.path),item)){
    await fs.copyFile(path.join(production,item.path),output);
    if(!await matches(output,item))throw Object.assign(new Error('正式文件在复制期间变化，未启动测试'),{code:'ARCHITECTURE_RUNTIME_CHANGED'});
    result.reused++;
   }else{
    const url='https://raw.githubusercontent.com/xunova1121/-/'+manifest.revision+'/jarvis/'+item.path.split('/').map(encodeURIComponent).join('/');
    const temporary=output+'.part';await fetchFile(url,temporary,item.bytes);
    if(!await matches(temporary,item))throw Object.assign(new Error('下载代码哈希不符，未启动测试'),{code:'ARCHITECTURE_RUNTIME_HASH'});
    await fs.rename(temporary,output);result.downloaded++;result.downloadedBytes+=item.bytes;
   }
   done++;if(done%40===0||done===manifest.files.length)progress({...result,done,total:manifest.files.length});
  }
 }
 // 4个HTTP工作者有界并发；失败也等待其余工作者退出，不留下后台下载进程。
 const settled=await Promise.allSettled(Array.from({length:4},async()=>{try{return await worker();}catch(error){cancelled=true;throw error;}}));
 const failed=settled.find(item=>item.status==='rejected');if(failed)throw failed.reason;
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [manifestPath,production,target]=process.argv.slice(2);
 const blob=await fs.readFile(manifestPath);if(blob.length>1e6)throw invalid();
 const manifest=JSON.parse(blob);
 const result=await prepareRuntime(manifest,production,target,{progress:item=>console.log(`代码 ${item.done}/${item.total}；复用${item.reused}；下载${item.downloaded}`)});
 console.log(`准备完成：复用${result.reused}文件，仅下载${result.downloaded}文件/${result.downloadedBytes}字节`);
 await fs.writeFile(path.join(target,'runtime-revision.txt'),manifest.revision,{mode:0o600});
}
