import {it,expect,beforeEach,afterEach} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createTools} from '../src/agent/tools.js';
import {createFileStore} from '../server/fileStore.mjs';
import {useBackend} from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
let dir;beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-image-read-'));useBackend(createFileStore(dir));});
afterEach(()=>{useBackend(null);fs.rmSync(dir,{recursive:true,force:true});});
it('服务器读取补充图片时直接给模型图片，不按文档解析',async()=>{
 const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ2kAAAAASUVORK5CYII=';
 await ws.write('补充.png',new Blob([Buffer.from(data,'base64')],{type:'image/png'}));
 const tool=createTools({}).find(t=>t.name==='read_file');const result=await tool.run({path:'补充.png'});
 expect(result.images).toEqual([{mime:'image/png',data}]);expect(result.text).toContain('补充.png');
});
it('伪装成图片的文本不会传给视觉模型',async()=>{
 await ws.write('假的.png',new Blob(['not an image']));const tool=createTools({}).find(t=>t.name==='read_file');
 await expect(tool.run({path:'假的.png'})).rejects.toThrow('图片文件头');
});
