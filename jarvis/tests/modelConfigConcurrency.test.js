import { it, expect } from 'vitest';
import { request } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';

it('慢请求改型号不能把另一台设备刚保存的新Key覆盖回旧Key',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weiyang-key-race-'));
  const config=path.join(dir,'config.json');
  const oldKey='fixture-old-key-9876',newKey='fixture-new-key-4321';
  fs.writeFileSync(config,JSON.stringify({provider:'openrouter',keys:{openrouter:oldKey},models:{openrouter:'before'}}));
  const mode=createServerMode({dataDir:dir,password:'fixture-password'});await mode.ready;
  const http=createServer({serverMode:mode,ollama:null});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${http.address().port}/api/server/config`;
  const headers={Authorization:'Bearer '+tokenFor('fixture-password'),'Content-Type':'application/json'};
  let slow;
  try {
    let started;
    const received=new Promise(resolve=>{started=resolve;});
    // 明确等服务器开始读慢请求，再发送第二台设备保存；只观察监听器，不消费正文。
    http.prependListener('request',req=>{if(req.headers['x-fixture-slow'])req.on('newListener',event=>{if(event==='readable')queueMicrotask(started);});});
    const response=new Promise((resolve,reject)=>{
      slow=request(url,{method:'PUT',headers:{...headers,'x-fixture-slow':'1'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
      slow.on('error',reject);slow.write('{"models":');
    });
    await received;
    const newer=await fetch(url,{method:'PUT',headers,body:JSON.stringify({keys:{openrouter:newKey}})});
    expect(newer.status).toBe(200);await newer.arrayBuffer();
    expect(JSON.parse(fs.readFileSync(config,'utf8')).keys.openrouter).toBe(newKey);
    slow.end('{"openrouter":"after"}}');
    expect(await response).toBe(200);
    const saved=JSON.parse(fs.readFileSync(config,'utf8'));
    expect(saved.keys.openrouter).toBe(newKey);
    expect(saved.models.openrouter).toBe('after');
    const masked=await (await fetch(url,{headers})).json();
    expect(masked.keys.openrouter).toBe('••••4321');
  }finally{
    slow?.destroy();await mode.runner.settled();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));useBackend(null);fs.rmSync(dir,{recursive:true,force:true});
  }
});
