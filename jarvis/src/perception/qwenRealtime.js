
import { QWEN_ASR, QWEN_TTS, qwenSettings } from '../../shared/qwenRealtime.js';
import { connectQwen } from './qwenTransport.js';
export { QWEN_ASR, QWEN_TTS };
export const bytesToBase64 = bytes => {let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
export function pcmFromBase64(text) {
  const raw=atob(text);if(raw.length%2)throw new Error('百炼音频采样不完整');
  const v=new DataView(Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer),out=new Float32Array(raw.length/2);
  for(let i=0;i<out.length;i++)out[i]=v.getInt16(i*2,true)/32768;
  return out;
}
/** 分块重采样保持跨帧相位，避免把44.1/48kHz麦克风音频误标为16kHz。 */
export class Pcm16Encoder {
  constructor(rate){if(rate<16000)throw new Error('麦克风采样率过低');this.ratio=rate/16000;this.pending=new Float32Array();this.pos=0;}
  encode(input){
    const all=new Float32Array(this.pending.length+input.length);all.set(this.pending);all.set(input,this.pending.length);
    const values=[];
    while(this.pos+1<all.length){const i=Math.floor(this.pos),f=this.pos-i;values.push(all[i]*(1-f)+all[i+1]*f);this.pos+=this.ratio;}
    const used=Math.min(Math.floor(this.pos),all.length);this.pending=all.slice(used);this.pos-=used;
    const bytes=new Uint8Array(values.length*2),v=new DataView(bytes.buffer);
    values.forEach((x,i)=>{x=Math.max(-1,Math.min(1,x));v.setInt16(i*2,x<0?x*32768:x*32767,true);});return bytes;
  }
}
/** 等待服务端确认 session.update 后才发送音频/文字。 */
export function openQwenSession({model,voice,silenceMs,onEvent=()=>{},onError=()=>{},signal,connect=connectQwen,...options}) {
  return new Promise((resolve,reject)=>{
    let transport,closed=false,ready=false,seq=0,pending=[];
    const abort=()=>fail(new DOMException('Aborted','AbortError'));
    const close=()=>{if(closed)return;closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);transport?.close();};
    const fail=e=>{if(closed)return;if(!ready)reject(e);else onError(e);close();};
    const send=e=>{if(closed)throw new Error('实时会话已结束');transport.send({event_id:'wy_'+Date.now()+'_'+(++seq),...e});};
    const receive=e=>{
      if(closed)return;
      if(!transport){pending.push(e);return;}
      if(e.type==='error')return fail(new Error('百炼语音服务拒绝请求，请检查密钥、地域、模型权限或额度'));
      if(e.type==='session.updated'&&!ready){ready=true;clearTimeout(timer);resolve({send,close});}
      onEvent(e);
    };
    const timer=setTimeout(()=>fail(new Error('百炼实时语音连接超时')),15000);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    let settings;try{settings=qwenSettings(model,{voice,silenceMs});}catch(e){fail(e);return;}
    connect({...options,model,signal,onEvent:receive,onError:fail,onClose:()=>fail(new Error('百炼实时连接已断开'))}).then(t=>{
      transport=t;if(closed){t.close();return;}
      send({type:'session.update',session:settings});
      for(const e of pending)receive(e);pending=[];
    },fail);
  });
}
/** 一句文字以PCM分片返回，收到即播放，不等待整句音频下载。 */
export async function streamQwenSpeech(text,{voice='Bella',onAudio,signal,sessionFactory=openQwenSession,...options}={}) {
  let finish,fail,session,received=0;
  const done=new Promise((r,j)=>{finish=r;fail=j;});done.catch(()=>{});
  const abort=()=>fail(new DOMException('Aborted','AbortError'));
  signal?.addEventListener('abort',abort,{once:true});
  let timer;
  try{
    session=await sessionFactory({...options,model:QWEN_TTS,voice,signal,onError:fail,onEvent:e=>{
      clearTimeout(timer);timer=setTimeout(()=>fail(new Error('百炼语音返回超时')),30000);
      if(e.type==='response.audio.delta'){try{const pcm=pcmFromBase64(e.delta);received+=pcm.length;onAudio?.(pcm,24000);}catch(err){fail(err);}}
      if(e.type==='session.finished')received?finish():fail(new Error('百炼没有返回音频'));
    }});
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    session.send({type:'input_text_buffer.append',text:String(text)});
    session.send({type:'input_text_buffer.commit'});
    session.send({type:'session.finish'});
    timer=setTimeout(()=>fail(new Error('百炼语音返回超时')),30000);
    await done;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);session?.close();}
}
