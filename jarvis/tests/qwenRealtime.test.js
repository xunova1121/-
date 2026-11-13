
import { describe,it,expect,vi,afterEach } from 'vitest';
import { QWEN_ASR,QWEN_TTS,qwenUrl,qwenSettings } from '../shared/qwenRealtime.js';
import { openQwenSession,streamQwenSpeech,Pcm16Encoder,bytesToBase64,pcmFromBase64 } from '../src/perception/qwenRealtime.js';
import { QwenVoice } from '../src/perception/qwenVoice.js';
import { resolveStt } from '../src/perception/stt.js';
import { selectVoiceEngine } from '../src/perception/voiceSelection.js';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe('百炼实时协议',()=>{
  it('仅连接两个指定模型与对应地域，不接受任意目标',()=>{
    expect(qwenUrl(QWEN_ASR)).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model='+QWEN_ASR);
    expect(qwenUrl(QWEN_TTS,'singapore')).toContain('dashscope-intl.aliyuncs.com');
    expect(()=>qwenUrl('https://evil.example')).toThrow();
    expect(()=>qwenUrl(QWEN_ASR,'wrong')).toThrow();
  });
  it('识别配置16k PCM和服务端断句，合成使用24k PCM与所选音色',()=>{
    expect(qwenSettings(QWEN_ASR,{silenceMs:100})).toMatchObject({sample_rate:16000,turn_detection:{silence_duration_ms:400}});
    expect(qwenSettings(QWEN_TTS,{voice:'Mia'})).toMatchObject({voice:'Mia',sample_rate:24000,response_format:'pcm',mode:'commit'});
    expect(()=>qwenSettings(QWEN_TTS,{voice:'made-up'})).toThrow();
  });
  it('输入重采样跨分块连续，48k和44.1k音频得到相同的16k时长',()=>{
    for(const rate of [48000,44100,16000]){
      const samples=Float32Array.from({length:rate},(_,i)=>Math.sin(i*2*Math.PI*440/rate));
      const whole=new Pcm16Encoder(rate).encode(samples);
      const encoder=new Pcm16Encoder(rate),parts=[];
      for(let i=0;i<samples.length;i+=777)parts.push(encoder.encode(samples.subarray(i,i+777)));
      const joined=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let off=0;for(const p of parts){joined.set(p,off);off+=p.length;}
      expect(joined.length).toBe(whole.length);const a=new DataView(joined.buffer),b=new DataView(whole.buffer);for(let i=0;i<joined.length;i+=2)expect(Math.abs(a.getInt16(i,true)-b.getInt16(i,true))).toBeLessThanOrEqual(1);expect(Math.abs(whole.length/2-16000)).toBeLessThanOrEqual(1);
    }
  });
  it('PCM正负幅度与字节序正确，拒绝半个采样',()=>{
    const bytes=new Uint8Array([0,128,0,0,255,127]);
    expect([...pcmFromBase64(bytesToBase64(bytes))]).toEqual([-1,0,32767/32768]);
    expect(()=>pcmFromBase64(bytesToBase64(new Uint8Array([1])))).toThrow();
  });
  it('收到session.updated才放行发送，事件编号唯一',async()=>{
    const sent=[],close=vi.fn();
    const session=await openQwenSession({model:QWEN_ASR,connect:async o=>({close,send:e=>{sent.push(e);if(e.type==='session.update')queueMicrotask(()=>o.onEvent({type:'session.updated'}));}})});
    expect(sent).toHaveLength(1);
    session.send({type:'input_audio_buffer.append',audio:'AA=='});session.send({type:'session.finish'});
    expect(new Set(sent.map(e=>e.event_id)).size).toBe(3);
    session.close();expect(close).toHaveBeenCalledOnce();
  });
  it('初始化中取消会关闭连接，不等待15秒超时',async()=>{
    const ctrl=new AbortController(),close=vi.fn();
    const promise=openQwenSession({model:QWEN_ASR,signal:ctrl.signal,connect:async()=>({send:vi.fn(),close})});
    await Promise.resolve();ctrl.abort();
    await expect(promise).rejects.toMatchObject({name:'AbortError'});expect(close).toHaveBeenCalledOnce();
  });
  it('握手后发送配置失败立即报告，关闭连接而不悬挂到超时',async()=>{
    const close=vi.fn();
    await expect(openQwenSession({model:QWEN_ASR,connect:async()=>({close,send:()=>{throw new Error('连接已断开');}})})).rejects.toThrow('连接已断开');
    expect(close).toHaveBeenCalledOnce();
  });
  it('服务端鉴权失败不泄漏原错误中的密钥',async()=>{
    const close=vi.fn();
    const promise=openQwenSession({model:QWEN_TTS,connect:async o=>({close,send:()=>queueMicrotask(()=>o.onEvent({type:'error',error:{message:'secret-key-value'}}))})});
    await expect(promise).rejects.toThrow('权限');
    await expect(promise).rejects.not.toThrow('secret-key-value');expect(close).toHaveBeenCalledOnce();
  });
  it('合成顺序为文字、提交、结束；分片立即交给播放器',async()=>{
    const sent=[],audio=[],close=vi.fn();
    await streamQwenSpeech('你好',{voice:'Bella',onAudio:pcm=>audio.push([...pcm]),sessionFactory:async o=>({close,send:e=>{
      sent.push(e.type);if(e.type==='session.finish')queueMicrotask(()=>{o.onEvent({type:'response.audio.delta',delta:'AAA='});o.onEvent({type:'response.audio.delta',delta:'AAA='});o.onEvent({type:'session.finished'});});
    }})});
    expect(sent).toEqual(['input_text_buffer.append','input_text_buffer.commit','session.finish']);
    expect(audio).toEqual([[0],[0]]);expect(close).toHaveBeenCalledOnce();
  });
  it('合成没有声音或PCM损坏会报错，不假装成功',async()=>{
    for(const events of [[{type:'session.finished'}],[{type:'response.audio.delta',delta:'AA=='}]]){
      await expect(streamQwenSpeech('你好',{sessionFactory:async o=>({close:vi.fn(),send:e=>{if(e.type==='session.finish')queueMicrotask(()=>events.forEach(o.onEvent));}})})).rejects.toThrow();
    }
  });
  it('合成中取消停止等待并关闭会话',async()=>{
    const ctrl=new AbortController(),close=vi.fn();
    const p=streamQwenSpeech('你好',{signal:ctrl.signal,onAudio:()=>ctrl.abort(),sessionFactory:async o=>({close,send:e=>{if(e.type==='session.finish')queueMicrotask(()=>o.onEvent({type:'response.audio.delta',delta:'AAA='}));}})});
    await expect(p).rejects.toMatchObject({name:'AbortError'});expect(close).toHaveBeenCalledOnce();
  });
});
describe('实时转写与选择',()=>{
  it('前缀加草稿显示预览，只提交一次最终文字，不读取情绪',()=>{
    const interim=vi.fn(),final=vi.fn(),confirm=vi.fn();
    const voice=new QwenVoice({onInterim:interim,onFinal:final,onConfirm:confirm});voice.mode='vad';
    voice.event({type:'input_audio_buffer.speech_started'});
    voice.event({type:'conversation.item.input_audio_transcription.text',text:'今天',stash:'天气'});
    const e={type:'conversation.item.input_audio_transcription.completed',item_id:'one',transcript:'今天天气怎么样',emotion:'sad'};
    voice.event(e);voice.event(e);
    expect(interim).toHaveBeenCalledWith('今天天气');expect(final).toHaveBeenCalledOnce();expect(final).toHaveBeenCalledWith('今天天气怎么样');expect(confirm).toHaveBeenCalledOnce();
    voice.disable();
  });
  it('等待麦克风授权时退出，迟到的音轨也立即释放',async()=>{
    let grant;const stop=vi.fn(),sessionFactory=vi.fn();
    vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>new Promise(r=>{grant=r;})}});
    const voice=new QwenVoice({sessionFactory});
    const enabling=voice.enable();voice.disable();grant({getTracks:()=>[{stop}]});
    expect(await enabling).toBe('off');expect(stop).toHaveBeenCalledOnce();expect(sessionFactory).not.toHaveBeenCalled();
  });
  it('断线重连连续失败最多两次，结束后不再保留收音状态',async()=>{
    vi.useFakeTimers();
    const factory=vi.fn().mockRejectedValue(new Error('断网')),error=vi.fn();
    const voice=new QwenVoice({getConfig:()=>({keys:{qwen:'k'}}),sessionFactory:factory,onError:error});
    voice.mode='vad';voice.ctrl=new AbortController();
    voice.reconnect(new Error('断网'),voice.gen);
    await vi.advanceTimersByTimeAsync(2000);
    expect(factory).toHaveBeenCalledTimes(2);expect(voice.mode).toBe('off');expect(error).toHaveBeenCalledOnce();
  });
  it('朗读抑制与退出后不再提交延迟到达的转写',()=>{
    const final=vi.fn(),voice=new QwenVoice({onFinal:final});voice.mode='vad';voice.setSuppressed(true);
    voice.event({type:'conversation.item.input_audio_transcription.completed',transcript:'扬声器中的话'});
    voice.disable();voice.event({type:'conversation.item.input_audio_transcription.completed',transcript:'晚到的结果'});
    expect(final).not.toHaveBeenCalled();
  });
  it('百炼语音独立于聊天模型，可显式选择；旧默认在无百炼密钥时保持原样',()=>{
    const cfg={provider:'mock',keys:{qwen:'key'},voice:{engine:'qwen-realtime'},stt:{engine:'qwen-realtime'}};
    expect(resolveStt(cfg,{browserSupported:false})).toBe('qwen-realtime');expect(selectVoiceEngine(cfg)).toBe('qwen-realtime');
    expect(resolveStt({provider:'mock',keys:{}},{browserSupported:false})).toBe('none');
    expect(selectVoiceEngine({provider:'mock',keys:{},voice:{engine:'auto'}})).toBe('browser');
  });
});

describe('通话抢话保护',()=>{
 it('只有已确认AEC、近端持续声音和服务端语音起点同时存在才停止朗读',()=>{
  const confirm=vi.fn(),voice=new QwenVoice({onConfirm:confirm,allowBargeIn:()=>true});voice.mode='vad';voice.echoSafe=true;voice.setSuppressed(true);
  voice.event({type:'input_audio_buffer.speech_started'});expect(confirm).not.toHaveBeenCalled();
  voice.barge.feed(.1);voice.barge.started=performance.now()-200;voice.barge.feed(.1);
  voice.event({type:'input_audio_buffer.speech_started'});expect(confirm).toHaveBeenCalledOnce();expect(voice.suppressed).toBe(false);voice.disable();
 });
 it('系统没有确认AEC时不允许自动抢话，即使有响声',()=>{
  const confirm=vi.fn(),voice=new QwenVoice({onConfirm:confirm,allowBargeIn:()=>true});voice.mode='vad';voice.echoSafe=false;voice.setSuppressed(true);
  voice.barge.last=performance.now();voice.event({type:'input_audio_buffer.speech_started'});expect(confirm).not.toHaveBeenCalled();expect(voice.suppressed).toBe(true);voice.disable();
 });
});
