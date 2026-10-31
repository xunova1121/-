
import { qwenUrl } from '../../shared/qwenRealtime.js';
import { loadServerSettings } from '../core/serverClient.js';

/** 安卓用原生 WSS 请求头鉴权；PC/网页只连自己的网关，密钥不进 URL。 */
export async function connectQwen({ model, region='beijing', key='', gateway=null, signal, onEvent, onError, onClose }) {
  qwenUrl(model,region);
  if(key.startsWith('••••'))key='';
  if (signal?.aborted) throw new DOMException('Aborted','AbortError');
  const native = globalThis.__jarvisQwenSocket;
  if (native && key) {
    const id=crypto.randomUUID();
    let closed=false, listener;
    const close=()=>{if(closed)return;closed=true;signal?.removeEventListener('abort',close);listener?.remove();native.close({id}).catch(()=>{});};
    listener=await native.addListener('event', e=>{
      if(e.id!==id||closed)return;
      if(e.phase==='message'){try{onEvent(JSON.parse(e.data));}catch{onError?.(new Error('百炼实时数据格式错误'));}}
      else if(e.phase==='error')onError?.(new Error('百炼实时连接失败，请检查密钥、地域、网络与额度'));
      else if(e.phase==='close')onClose?.();
    });
    signal?.addEventListener('abort',close,{once:true});
    try {
      if(signal?.aborted){close();throw new DOMException('Aborted','AbortError');}
      await native.connect({id,model,region,key});
      if(closed||signal?.aborted)throw new DOMException('Aborted','AbortError');
      return {send:e=>{if(closed)throw new Error('实时连接已关闭');native.send({id,data:JSON.stringify(e)}).catch(()=>onError?.(new Error('百炼实时发送失败')));},close};
    } catch(e){close();throw e;}
  }
  const remote=loadServerSettings();
  const base=gateway?.origin || (remote.enabled&&remote.token?remote.url:'');
  if(!base)throw new Error('百炼实时语音需要新版安卓 App，或连接自己的未央网关/服务器');
  const url=new URL('/api/voice/qwen',base);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url);
    let ready=false,closed=false;
    const close=()=>{if(closed)return;closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);ws.close();};
    const fail=()=>{const e=new Error('百炼实时连接失败，请检查密钥、地域、网络与服务器版本');if(!ready)reject(e);else onError?.(e);close();};
    const abort=()=>{reject(new DOMException('Aborted','AbortError'));close();};
    const timer=setTimeout(fail,15000);
    signal?.addEventListener('abort',abort,{once:true});
    ws.onopen=()=>{if(closed)return;ws.send(JSON.stringify({model,region,key,token:remote.enabled&&remote.url===base?remote.token:''}));};
    ws.onmessage=e=>{
      if(closed)return;
      let data;try{data=JSON.parse(e.data);}catch{return fail();}
      if(data.type==='transport.ready'){ready=true;clearTimeout(timer);resolve({send:v=>{if(closed||ws.readyState!==1)throw new Error('实时连接已关闭');if(ws.bufferedAmount>256*1024){fail();return;}ws.send(JSON.stringify(v));},close});}
      else if(data.type==='transport.error')fail();
      else onEvent(data);
    };
    ws.onerror=fail;
    ws.onclose=()=>{if(closed)return;if(!ready)fail();else{close();onClose?.();}};
    if(signal?.aborted)abort();
  });
}
