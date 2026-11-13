import { BargeGate } from './bargeGate.js';

import { openQwenSession, Pcm16Encoder, bytesToBase64, QWEN_ASR } from './qwenRealtime.js';
/** 连续PCM实时识别：不加载ONNX，不积累整段录音；只使用转写文本，忽略情绪字段。 */
export class QwenVoice {
  constructor({getConfig,getGateway,sessionFactory=openQwenSession,allowBargeIn=()=>false,...handlers}={}) {
    Object.assign(this,handlers);this.getConfig=getConfig;this.getGateway=getGateway;this.sessionFactory=sessionFactory;
    this.allowBargeIn=allowBargeIn;this.barge=new BargeGate();this.echoSafe=false;
    this.mode='off';this.gen=0;this.suppressed=false;this.seen=new Set();this.retries=0;
  }
  setMode(mode){this.mode=mode;this.onMode?.(mode);}
  async enable({silenceMs=800}={}) {
    this.disable();const gen=++this.gen;this.silenceMs=silenceMs;this.retries=0;this.setMode('loading');
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(gen!==this.gen){stream.getTracks().forEach(t=>t.stop());return 'off';}
      this.stream=stream;this.echoSafe=stream.getAudioTracks?.()[0]?.getSettings?.().echoCancellation===true;
      const Context=globalThis.AudioContext||globalThis.webkitAudioContext;
      if(!Context)throw new Error('当前系统没有实时音频采集能力');
      this.context=new Context();await this.context.resume();
      if(gen!==this.gen)return 'off';
      this.encoder=new Pcm16Encoder(this.context.sampleRate);
      this.source=this.context.createMediaStreamSource(stream);
      this.processor=this.context.createScriptProcessor(2048,1,1);
      this.source.connect(this.processor);this.processor.connect(this.context.destination);
      this.processor.onaudioprocess=e=>this.process(e.inputBuffer.getChannelData(0));
      await this.connect(gen);
      return this.mode;
    }catch(e){if(gen===this.gen)this.disable();throw e;}
  }
  async connect(gen){
    const ctrl=this.ctrl=new AbortController();
    const cfg=this.getConfig(),key=cfg.keys?.qwen||'';
    this.onStatus?.('正在连接百炼实时识别…');
    const session=await this.sessionFactory({model:QWEN_ASR,key,region:cfg.voice?.qwenRegion||'beijing',gateway:this.getGateway?.(),silenceMs:this.silenceMs,signal:ctrl.signal,
      onEvent:e=>{if(gen===this.gen)this.event(e);},onError:e=>{if(gen===this.gen)this.reconnect(e,gen);}
    });
    if(gen!==this.gen||ctrl.signal.aborted){session.close();return;}
    this.session=session;this.retries=0;this.setMode('vad');this.onStatus?.('ready');
  }
  event(e){
    if(this.mode==='off')return;
    if(this.suppressed){
      if(e.type!=='input_audio_buffer.speech_started'||!this.echoSafe||!this.allowBargeIn())return;
      this.bargeServerAt=performance.now();
      if(!this.barge.recent)return;
      this.suppressed=false;this.barge.reset();
    }
    if(e.type==='input_audio_buffer.speech_started'){this.onConfirm?.();this.onStatus?.('speech');}
    if(e.type==='input_audio_buffer.speech_stopped')this.onStatus?.('processing');
    if(e.type==='conversation.item.input_audio_transcription.text')this.onInterim?.(String(e.text||'')+String(e.stash||''));
    if(e.type==='conversation.item.input_audio_transcription.completed'){
      const id=e.item_id||e.event_id;if(id&&this.seen.has(id))return;
      if(id){this.seen.add(id);if(this.seen.size>128)this.seen.delete(this.seen.values().next().value);}
      const text=String(e.transcript||'').trim();
      if(text)this.onFinal?.(text);else this.onCancel?.();
      this.onStatus?.('ready');
    }
    if(e.type==='conversation.item.input_audio_transcription.failed'){this.onCancel?.();this.onError?.('语音识别失败，请重新说这一句');}
  }
  process(samples){
    if(this.mode!=='vad'||!this.session)return;
    const rms=Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/Math.max(1,samples.length));
    const listeningDuringSpeech=this.suppressed&&this.echoSafe&&this.allowBargeIn();
    if(listeningDuringSpeech&&this.barge.feed(rms)&&performance.now()-(this.bargeServerAt??-Infinity)<800){
      this.suppressed=false;this.barge.reset();this.onConfirm?.();this.onStatus?.('speech');
    }
    this.onEnergy?.(this.suppressed?0:Math.min(1,rms*8));
    const bytes=this.encoder.encode(this.suppressed&&!listeningDuringSpeech?new Float32Array(samples.length):samples);
    if(bytes.length)try{this.session.send({type:'input_audio_buffer.append',audio:bytesToBase64(bytes)});}catch(e){this.reconnect(e,this.gen);}
  }
  reconnect(error,gen){
    if(gen!==this.gen||this.mode==='off'||this.reconnecting)return;
    this.reconnecting=true;this.session?.close();this.session=null;this.ctrl?.abort();this.onCancel?.();
    if(this.retries++>=2){this.disable();this.onError?.(error.message);return;}
    this.reconnecting=true;this.setMode('loading');this.onStatus?.('连接中断，正在重连；未识别完的一句请重说');
    this.timer=setTimeout(async()=>{
      this.reconnecting=false;if(gen!==this.gen)return;
      try{await this.connect(gen);}catch(e){this.reconnect(e,gen);}
    },500*this.retries);
  }
  disable(){
    this.gen++;clearTimeout(this.timer);this.reconnecting=false;this.ctrl?.abort();this.ctrl=null;
    this.session?.close();this.session=null;
    if(this.processor){this.processor.onaudioprocess=null;this.processor.disconnect();}
    this.source?.disconnect();this.stream?.getTracks().forEach(t=>t.stop());this.context?.close().catch(()=>{});
    this.context=this.processor=this.source=this.stream=null;this.seen.clear();this.onEnergy?.(0);this.setMode('off');
  }
  setSuppressed(on){this.suppressed=on;this.barge.reset();this.bargeServerAt=-Infinity;if(on){this.onInterim?.('');this.onEnergy?.(0);}}
  setSilenceMs(ms){this.silenceMs=ms;}
  pttStart(){} pttEnd(){}
}
