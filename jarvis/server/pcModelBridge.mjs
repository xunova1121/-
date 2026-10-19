/** 仅代理模型推理；文件/鼠标/命令工具始终留在PC，由PC执行原有确认流程。 */
import { createAdapter } from '../src/llm/config.js';
import { routeFor, fallbackRoutes, canFallback } from '../src/llm/router.js';

export function bridgeInput(body) {
  if(!body||!Array.isArray(body.messages)||body.messages.length>2000||!Array.isArray(body.system)||body.system.length>16||!body.system.every(s=>typeof s==='string')||!Array.isArray(body.tools)||body.tools.length>256)throw Object.assign(new Error('PC模型请求格式不正确'),{status:400});
  if(!body.messages.every(m=>m&&['user','assistant','tool'].includes(m.role)))throw Object.assign(new Error('PC模型消息格式不正确'),{status:400});
  const tools=body.tools.map(t=>{
    if(!t||!/^[-\w]{1,128}$/.test(t.name)||typeof t.description!=='string'||!t.input_schema||typeof t.input_schema!=='object')throw Object.assign(new Error('PC工具说明格式不正确'),{status:400});
    return{name:t.name,description:t.description,input_schema:t.input_schema};
  });
  const bounded=(n,f,min,max)=>Number.isFinite(n)?Math.max(min,Math.min(max,n)):f;
  return { system:body.system,messages:body.messages,tools,
    ...(typeof body.effort==='string'&&['low','medium','high','max','xhigh','minimal'].includes(body.effort)&&{effort:body.effort}),
    allowWebSearch:body.allowWebSearch!==false,
    stallTimeouts:{first:bounded(body.stallTimeouts?.first,45000,5000,60000),between:bounded(body.stallTimeouts?.between,60000,5000,90000)},
    maxTransientRetries:bounded(body.maxTransientRetries,1,0,1),maxPartialRetries:1 };
}

export async function streamPCModel(req,res,body,{cfg,makeAdapter=createAdapter}) {
  const input=bridgeInput(body);
  if(cfg.provider==='mock')throw Object.assign(new Error('服务器仍是演示模型，请先配置真实模型；不会用演示结果冒充电脑任务已完成'),{status:409});
  const kind=['chat','code','write','reason','vision'].includes(body.task)?body.task:'chat';
  const route=routeFor(cfg,kind),first=makeAdapter(route.cfg);
  if(first.problem)throw Object.assign(new Error(`服务器模型配置不可用：${first.problem}`),{status:409});
  // 只使用服务器已配置的模型，客户端不能提交任意上游URL或密钥。
  const configured=[{...first,provider:route.cfg.provider},...fallbackRoutes(cfg,{provider:route.cfg.provider,model:first.model}).map(f=>({...makeAdapter(f.cfg),provider:f.provider})).filter(f=>!f.problem&&f.adapter&&f.model)];
  // 本轮已切到可用备用模型时，后续步骤不要再次等待故障主模型；只能选择服务器配置中的候选。
  const preferred=configured.find(m=>m.model===body.preferredModel?.model&&m.provider===body.preferredModel?.provider);
  const models=preferred?[preferred,...configured.filter(m=>m!==preferred)]:configured;
  const ctrl=new AbortController(),abort=()=>ctrl.abort();
  req.on('aborted',abort);res.on('close',abort);
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no',Connection:'keep-alive'});
  const send=e=>{if(!res.destroyed&&!res.writableEnded)res.write(`data: ${JSON.stringify(e)}\n\n`);};
  const beat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': ping\n\n');},15000);beat.unref?.();
  const safe=e=>{
    let s=String(e?.message||'服务器模型请求失败');
    for(const key of Object.values(cfg.keys||{}).filter(k=>typeof k==='string'&&k))s=s.replaceAll(key,'[已隐藏]');
    return s.replace(/Bearer\s+\S+/gi,'[令牌已隐藏]').slice(0,500);
  };
  try {
    for(let i=0;i<models.length;i++){
      const cur=models[i];let text=false;
      if(ctrl.signal.aborted)break;
      send({type:'model',model:cur.model,provider:cur.provider,fallback:cur.model!==first.model||cur.provider!==route.cfg.provider});
      try{
        const result=await cur.adapter.stream({...input,model:cur.model,signal:ctrl.signal,
          onRetry:(attempt)=>send({type:'retry',attempt}),
          onText:(delta,meta)=>{if(delta)text=true;send({type:'text',delta:delta||'',...(meta?.serverTool&&{meta:{serverTool:meta.serverTool}})});}});
        if(!ctrl.signal.aborted)send({type:'result',result:{text:result.text,toolCalls:result.toolCalls||[],stop:result.stop,raw:result.raw}});
        break;
      }catch(e){
        if(ctrl.signal.aborted)break;
        if(!text&&i+1<models.length&&canFallback(e))continue;
        send({type:'error',message:safe(e),status:Number(e.status)||502,stalled:Boolean(e.stalled)});break;
      }
    }
  } finally {clearInterval(beat);req.removeListener('aborted',abort);res.removeListener('close',abort);if(!res.writableEnded)res.end();}
}
