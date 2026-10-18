
import {describe,it,expect} from 'vitest';
import http from 'node:http';
import {EventEmitter,once} from 'node:events';
import WebSocket from 'ws';
import {attachQwenGateway} from '../server/qwenRealtime.mjs';
import {createServer} from '../server/server.mjs';
import {QWEN_ASR} from '../shared/qwenRealtime.js';

async function setup({serverMode=null,localAllowed=()=>true}={}){
  const calls=[],upstreams=[];
  const server=http.createServer((req,res)=>res.end());
  attachQwenGateway(server,{serverMode,localAllowed,createUpstream:(url,options)=>{
    calls.push({url,options});const ws=new EventEmitter();ws.readyState=1;ws.bufferedAmount=0;ws.sent=[];ws.send=s=>ws.sent.push(JSON.parse(s));ws.terminate=()=>{ws.terminated=true;};
    upstreams.push(ws);queueMicrotask(()=>ws.emit('open'));return ws;
  }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='ws://127.0.0.1:'+server.address().port+'/api/voice/qwen';
  const clients=[];
  return {calls,upstreams,async client(){
    const client=new WebSocket(url);clients.push(client);await once(client,'open');return client;
  },async close(){clients.forEach(ws=>ws.terminate());await new Promise(r=>server.close(r));}};
}
async function next(ws,send){const p=once(ws,'message');send();return JSON.parse((await p)[0].toString());}
describe('百炼实时网关',()=>{
  it('实际本机网关允许同源浏览器WS，不要求浏览器无法设置的自定义头',async()=>{
    const server=createServer({ollama:null});await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base='127.0.0.1:'+server.address().port;
    const client=new WebSocket('ws://'+base+'/api/voice/qwen',{origin:'http://'+base});
    try{await once(client,'open');expect((await next(client,()=>client.send(JSON.stringify({model:'invalid'})))).type).toBe('transport.error');}
    finally{client.terminate();await new Promise(r=>server.close(r));}
  });

  it('鉴权通过才连固定上游，密钥只在头里，双向转发并随客户端释放',async()=>{
    const env=await setup({serverMode:{authorized:req=>req.headers.authorization==='Bearer app-token',realtimeKey:()=> 'server-key'}});
    try{
      const client=await env.client();
      expect(await next(client,()=>client.send(JSON.stringify({model:QWEN_ASR,region:'beijing',token:'app-token'})))).toEqual({type:'transport.ready'});
      expect(env.calls[0].url).not.toContain('server-key');expect(env.calls[0].options.headers.Authorization).toBe('Bearer server-key');
      const incoming=once(client,'message');
      client.send(JSON.stringify({event_id:'1',type:'session.update',session:{input_audio_format:'pcm'}}));
      await new Promise(r=>setTimeout(r,20));
      expect(env.upstreams[0].sent[0].type).toBe('session.update');
      env.upstreams[0].emit('message',Buffer.from(JSON.stringify({type:'session.updated'})),false);
      expect(JSON.parse((await incoming)[0].toString()).type).toBe('session.updated');
      const closed=once(client,'close');client.close();await closed;expect(env.upstreams[0].terminated).toBe(true);
    }finally{await env.close();}
  });
  it('没有服务器令牌不能借用服务器密钥或自带密钥连接',async()=>{
    const env=await setup({serverMode:{authorized:()=>false,realtimeKey:()=> 'server-key'}});
    try{
      const client=await env.client();
      const r=await next(client,()=>client.send(JSON.stringify({model:QWEN_ASR,key:'own-key'})));
      expect(r.type).toBe('transport.error');expect(env.calls).toHaveLength(0);
    }finally{await env.close();}
  });
  it('即使已登录也不能连接其他模型或任意主机',async()=>{
    for(const model of ['other-model','wss://127.0.0.1/private']){
      const env=await setup();
      try{const client=await env.client();expect((await next(client,()=>client.send(JSON.stringify({model,key:'k'})))).type).toBe('transport.error');expect(env.calls).toHaveLength(0);}
      finally{await env.close();}
    }
  });
  it('本机网关拒绝外部网页的跨站连接',async()=>{
    const env=await setup({localAllowed:()=>false});
    try{await expect(env.client()).rejects.toThrow();expect(env.calls).toHaveLength(0);}
    finally{await env.close();}
  });
});
