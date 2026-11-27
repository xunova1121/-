
import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('../src/perception/voiceFx.js',()=>({buildFx:()=>({input:{},detune:0,dispose(){},analyser:{fftSize:16}}),levelOf:()=>0,playCue:()=>{}}));
vi.mock('../src/perception/qwenRealtime.js',()=>({streamQwenSpeech:vi.fn()}));
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
async function setup(){
  const sources=[];
  class Context{
    constructor(){this.state='running';this.currentTime=0;}
    createBuffer(ch,n,rate){return{duration:n/rate,getChannelData:()=>new Float32Array(n)};}
    createBufferSource(){const src={detune:{value:0},connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn(),onended:null};sources.push(src);return src;}
  }
  vi.stubGlobal('AudioContext',Context);
  const {Speaker}=await import('../src/perception/speaker.js');
  const {streamQwenSpeech}=await import('../src/perception/qwenRealtime.js');
  return {Speaker,streamQwenSpeech,sources};
}
describe('百炼实时播放生命周期',()=>{
  it('收到PCM就安排播放，切后台停止全部已排队音源并拒绝迟到声音',async()=>{
    const {Speaker,streamQwenSpeech,sources}=await setup();let callbacks;
    streamQwenSpeech.mockImplementation((text,o)=>{callbacks=o;return new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});o.onAudio(new Float32Array(240),24000);o.onAudio(new Float32Array(240),24000);});});
    const idle=vi.fn(),speaker=new Speaker({onIdle:idle,getVoiceConfig:()=>({engine:'qwen-realtime',voices:{'qwen-realtime':'Mia'},cues:false}),getKeys:()=>({qwen:'k'})});
    speaker.speak('你好');
    await vi.waitFor(()=>expect(sources).toHaveLength(2));
    expect(sources.every(s=>s.start.mock.calls.length===1)).toBe(true);
    speaker.setForeground(false);
    expect(sources.every(s=>s.stop.mock.calls.length>=1)).toBe(true);
    expect(speaker.speaking).toBe(false);expect(idle).toHaveBeenCalledOnce();
    expect(()=>callbacks.onAudio(new Float32Array(240),24000)).toThrow();
    speaker.speak('后台消息');expect(streamQwenSpeech).toHaveBeenCalledOnce();
  });
  it('显式百炼音色失败会报告，不把系统声音当作成功',async()=>{
    const {Speaker,streamQwenSpeech}=await setup();
    streamQwenSpeech.mockRejectedValue(new Error('模型权限未开通'));
    const error=vi.fn(),speaker=new Speaker({onError:error,getVoiceConfig:()=>({engine:'qwen-realtime',cues:false})});
    speaker.speak('你好');
    await vi.waitFor(()=>expect(error).toHaveBeenCalledOnce());
    expect(speaker.speaking).toBe(false);
    await expect(speaker.test()).rejects.toThrow('模型权限');
  });
});
