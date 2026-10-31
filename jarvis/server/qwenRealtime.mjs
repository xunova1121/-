
import WebSocket, { WebSocketServer } from 'ws';
import { qwenUrl, QWEN_EVENTS } from '../shared/qwenRealtime.js';
/** 一条客户端连接对应一条百炼连接；认证信息只在首个消息和上游请求头中出现。 */
export function attachQwenGateway(server,{serverMode=null,localAllowed,createUpstream=(url,options)=>new WebSocket(url,options)}={}) {
  const wss=new WebSocketServer({noServer:true,maxPayload:256*1024,perMessageDeflate:false});
  const clients=new Set();
  server.on('upgrade',(req,socket,head)=>{
    if(new URL(req.url,'http://localhost').pathname!=='/api/voice/qwen'){socket.destroy();return;}
    if(clients.size>=8||(!serverMode&&!localAllowed?.(req))){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,client=>{
      clients.add(client);
      let upstream,initialized=false,ended=false;
      const end=()=>{if(ended)return;ended=true;clearTimeout(timer);clearTimeout(idle);clients.delete(client);upstream?.terminate?.();client.close();};
      const error=()=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'transport.error'}));end();};
      let idle;
      const touch=()=>{clearTimeout(idle);idle=setTimeout(error,45000);idle.unref?.();};
      const timer=setTimeout(error,5000);timer.unref?.();
      client.on('error',end);client.on('close',end);
      client.on('message',(raw,binary)=>{
        if(ended||binary)return error();
        let msg;try{msg=JSON.parse(raw.toString());}catch{return error();}
        if(!initialized){
          initialized=true;clearTimeout(timer);
          if(serverMode&&!serverMode.authorized({...req,url:'/api/voice/qwen',headers:{...req.headers,authorization:'Bearer '+String(msg.token||'')}}))return error();
          if(!serverMode&&req.headers.origin==='null'&&!msg.key)return error(); // 单文件只准使用自己明确提供的密钥
          let url;try{url=qwenUrl(msg.model,msg.region);}catch{return error();}
          const key=String(msg.key||serverMode?.realtimeKey?.()||process.env.DASHSCOPE_API_KEY||'');
          if(!key||key.length>2048||/[\r\n]/.test(key))return error();
          try{upstream=createUpstream(url,{headers:{Authorization:'Bearer '+key,'OpenAI-Beta':'realtime=v1'},handshakeTimeout:15000,maxPayload:1024*1024,perMessageDeflate:false});}catch{return error();}
          touch();
          upstream.on('open',()=>{if(ended)return;client.send(JSON.stringify({type:'transport.ready'}));touch();});
          upstream.on('message',(data,isBinary)=>{
            if(ended||isBinary)return error();
            touch();if(client.bufferedAmount>1024*1024)return error();
            client.send(data.toString());
          });
          upstream.on('error',error);upstream.on('close',end);
          return;
        }
        if(!QWEN_EVENTS.has(msg.type)||upstream?.readyState!==WebSocket.OPEN||upstream.bufferedAmount>256*1024)return error();
        touch();upstream.send(JSON.stringify(msg));
      });
    });
  });
  server.on('close',()=>{for(const ws of clients)ws.terminate();wss.close();});
  return wss;
}
