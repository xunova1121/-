import { parseSse } from './serverClient.js';

/** 推理沿用服务器配置；模型返回的工具调用由本机runAgent审批/执行，绝不在服务器执行。 */
export function createPCModelAdapter(client,{task='chat',onModel}={}) {
  let checked=false,preferredModel;
  return { async stream(o) {
    if(o.signal?.aborted)throw Object.assign(new Error('aborted'),{name:'AbortError'});
    const ctrl=new AbortController();let timer,reader,expired=false,gotText=false;
    const abort=()=>{ctrl.abort();reader?.cancel().catch(()=>{});};
    o.signal?.addEventListener('abort',abort,{once:true});
    const arm=first=>{clearTimeout(timer);timer=setTimeout(()=>{expired=true;abort();},(first?o.stallTimeouts?.first??45000:o.stallTimeouts?.between??60000)+5000);};
    arm(true);
    try{
      if(!checked){const s=await client.status(ctrl.signal);if(!s.features?.pcModelBridge)throw Object.assign(new Error('服务器尚不支持PC本机工具推理，请先“立即更新服务器”；不会退回演示模型'),{status:409});checked=true;}
      if(ctrl.signal.aborted)throw new Error('aborted');
      const res=await client.modelEvents({task,preferredModel,system:o.system,messages:o.messages,tools:o.tools,
        effort:o.effort,allowWebSearch:o.allowWebSearch,stallTimeouts:o.stallTimeouts,maxTransientRetries:o.maxTransientRetries},ctrl.signal);
      if(!res.ok)throw Object.assign(new Error(res.status===401?'服务器登录已失效，请重新登录':`服务器PC模型接口返回${res.status}`),{status:res.status});
      if(!res.body)throw new Error('服务器没有返回模型事件流');
      reader=res.body.getReader();
      const cancel=()=>reader.cancel().catch(()=>{});ctrl.signal.addEventListener('abort',cancel,{once:true});
      try{
        let buf='';const dec=new TextDecoder();
        for(;;){
          if(ctrl.signal.aborted)throw new Error('aborted');
          const {done,value}=await reader.read();
          if(ctrl.signal.aborted)throw new Error('aborted');
          if(done)break;
          buf+=dec.decode(value,{stream:true});if(buf.length>8*1024*1024)throw new Error('服务器模型响应过大');
          const parsed=parseSse(buf);buf=parsed.rest;
          for(const e of parsed.events){
            if(e.type==='model'){if(e.model&&e.provider)preferredModel={model:e.model,provider:e.provider};onModel?.(e.model,e);arm(!gotText);}
            else if(e.type==='retry'){o.onRetry?.(e.attempt);arm(!gotText);}
            else if(e.type==='text'){if(e.delta||e.meta?.serverTool){if(e.delta)gotText=true;arm(false);o.onText?.(e.delta,e.meta);}}
            else if(e.type==='error')throw Object.assign(new Error(e.message||'服务器模型失败'),{status:e.status,stalled:e.stalled});
            else if(e.type==='result'){
              const r=e.result;
              if(!r||typeof r.text!=='string'||!Array.isArray(r.toolCalls)||(!r.text&&!r.toolCalls.length&&r.stop!=='pause_turn'))throw new Error('服务器模型未返回有效回答或操作');
              return r;
            }
          }
        }
        throw new Error('服务器模型连接中断，未收到完整结果；未自动重复执行操作');
      }finally{ctrl.signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock?.();}
    }catch(e){
      if(o.signal?.aborted)throw Object.assign(new Error('aborted'),{name:'AbortError'});
      if(expired)throw Object.assign(new Error('服务器PC模型长时间没有有效进展，已停止等待'),{stalled:true});
      throw e;
    }finally{clearTimeout(timer);o.signal?.removeEventListener('abort',abort);}
  }};
}
