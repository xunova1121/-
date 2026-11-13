/** 从真实Office PDF逐页栅格化；不使用生成器SVG假装Office预览。 */
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {contactSheet} from './presentationContactSheet.mjs';
import {inspectRenderedPdf} from '../src/agent/pdfQuality.js';
import {throwControl} from '../src/core/networkRequest.js';
function raster(dir,pages,signal) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn('pdftoppm',['-f','1','-l',String(pages),'-scale-to','1000','-png','input.pdf','page'],{cwd:dir,stdio:'ignore'});
    let settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){child.kill('SIGKILL');reject(error);}else resolve();};
    const abort=()=>finish(signal.reason||new DOMException('Aborted','AbortError'));
    const timer=setTimeout(()=>finish(new Error('真实PDF栅格化超过45秒')),45000);
    signal?.addEventListener('abort',abort,{once:true});
    child.on('error',error=>finish(error.code==='ENOENT'?new Error('服务器缺 poppler-utils（pdftoppm），无法生成真实PPT总览'):error));
    child.on('close',code=>finish(code?new Error('真实PDF栅格化失败'):null));
    if(signal?.aborted)abort();
  });
}
export async function presentationOverview(pdf,{signal}={}) {
  const check=await inspectRenderedPdf(pdf,{signal});
  if(check.pages>40)throw new Error('真实PPT总览最多40页，请分批；未以抽样冒充全页检查');
  const dir=await mkdtemp(path.join(os.tmpdir(),'jarvis-ppt-overview-'));
  try {
    await writeFile(path.join(dir,'input.pdf'),new Uint8Array(await pdf.arrayBuffer()));
    await raster(dir,check.pages,signal);
    const files=(await readdir(dir)).filter(file=>/^page-\d+\.png$/.test(file)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
    if(files.length!==check.pages)throw new Error('真实PDF栅格页数不一致');
    const pages=[];let total=0;
    for(const file of files){signal?.throwIfAborted();total+=(await stat(path.join(dir,file))).size;if(total>30e6)throw new Error('PPT总览图片超过30MB');pages.push(new Blob([await readFile(path.join(dir,file))],{type:'image/png'}));}
    const sheets=[];
    for(let start=0;start<pages.length;start+=6){
      const group=pages.slice(start,start+6);
      const blob=await contactSheet(group,start+1,{signal});
      sheets.push({blob,pages:group.map((_,i)=>start+i+1)});
    }
    return {sheets,pages:check.pages,pdfCheck:check,engine:'LibreOffice PDF + pdftoppm'};
  }catch(error){throwControl(error,signal);throw error;}
  finally{await rm(dir,{recursive:true,force:true});}
}
