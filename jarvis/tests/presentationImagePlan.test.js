import {it,expect,beforeEach,afterEach,vi} from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {createFileStore} from '../server/fileStore.mjs'; import {useBackend} from '../src/agent/store.js';
import {preparePresentationImages,imagePool} from '../src/agent/presentationImagePlan.js';
const bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'));
let dir; beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'imageplan-'));useBackend(createFileStore(dir));}); afterEach(()=>{useBackend(null);fs.rmSync(dir,{recursive:true,force:true});});
it('两路并发、稳定顺序；用户停止不吞',async()=>{
 let active=0,max=0; const release=[];
 const pending=imagePool([1,2,3],async n=>{active++;max=Math.max(max,active);await new Promise(ok=>release.push(ok));active--;return n;});
 expect(release.length).toBe(2); release.shift()(); await new Promise(ok=>setTimeout(ok,0)); expect(release.length).toBe(2); release.splice(0).forEach(ok=>ok());
 expect((await pending).map(r=>r.value)).toEqual([1,2,3]);expect(max).toBe(2);
 const control=new AbortController();control.abort();await expect(imagePool([1],()=>{},control.signal)).rejects.toMatchObject({name:'AbortError'});
});
it('每页配图含封面、原图保留、重排不重画',async()=>{
 const imageGen=vi.fn(async()=>({blob:new Blob([bytes],{type:'image/png'})}));
 const content='## 数据\n- 20 场：未开赛\n- 7 场：进行中\n\n## 现场\n![用户图](uploads/own.png)';
 const options={title:'赛程',requirements:'PPT每页都要图',style:'business'};
 const first=await preparePresentationImages({imageGen},content,options);
 expect(first.plan).toHaveLength(3);expect(first.issues).toEqual([]);expect(first.content).toContain('uploads/own.png');expect(imageGen).toHaveBeenCalledTimes(2);
 await preparePresentationImages({imageGen},content,options);expect(imageGen).toHaveBeenCalledTimes(2);
 await preparePresentationImages({imageGen},content,{...options,requirements:options.requirements+'，正文字号24磅'});expect(imageGen).toHaveBeenCalledTimes(2);
});
it('缺能力不虚报成功；普通无配图要求不额外请求',async()=>{
 const out=await preparePresentationImages({},'## 说明\n正文',{title:'说明',requirements:'每页都要图'});expect(out.issues.length).toBeGreaterThan(0);
 const imageGen=vi.fn();await preparePresentationImages({imageGen},'## 说明\n正文',{title:'说明',requirements:'做PPT'});expect(imageGen).not.toHaveBeenCalled();
});
it('普通图库失败可回退AI；用户禁止AI时不能回退',async()=>{
 const imageGen=vi.fn(async()=>({blob:new Blob([bytes],{type:'image/png'})}));
 const stockImageForSlide=vi.fn(async()=>{throw new Error('source unavailable');});
 const first=await preparePresentationImages({imageGen,stockImageForSlide},'## 球场\n介绍',{title:'球场',requirements:'每页都要图'});
 expect(first.issues).toEqual([]);expect(imageGen).toHaveBeenCalled();imageGen.mockClear();
 const second=await preparePresentationImages({imageGen,stockImageForSlide},'## 球场\n介绍',{title:'球场',requirements:'每页都要图，不要AI'});
 expect(second.issues.length).toBeGreaterThan(0);expect(imageGen).not.toHaveBeenCalled();
});
