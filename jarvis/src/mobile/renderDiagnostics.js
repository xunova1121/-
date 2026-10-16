/** 诊断只含运行规模、版本与错误类型，不收集聊天正文、服务地址或密钥。 */
export function renderSnapshot({ doc = document, perf = globalThis.performance } = {}) {
  const messages=[...doc.querySelectorAll('#transcript .msg')];
  return {
    safeDisplay:doc.documentElement.classList.contains('safe-render'),
    pane:doc.body.classList.contains('side-open') ? doc.querySelector('[data-pane]:not([hidden])')?.dataset.pane || 'panel' : 'chat',
    messages:messages.length,
    characters:messages.reduce((n,el)=>n+(el.querySelector('.body')?.textContent.length||0),0),
    nodes:doc.getElementsByTagName('*').length,
    jsHeapMB:perf?.memory ? Math.round(perf.memory.usedJSHeapSize/1048576) : null,
    hidden:doc.hidden
  };
}
export function recordRenderError(event, storage=globalThis.localStorage) {
  try {
    const entries=JSON.parse(storage.getItem('jarvis.renderEvents')||'[]');
    entries.push({time:Date.now(),kind:event.type,name:/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(event.error?.name||event.reason?.name||'') ? event.error?.name||event.reason?.name : 'Error',line:Number(event.lineno)||0});
    storage.setItem('jarvis.renderEvents',JSON.stringify(entries.slice(-10)));
  } catch { /* 诊断不可写不影响运行 */ }
}
export async function copyRenderDiagnostics({ plugin=globalThis.__jarvisRenderHealthPlugin, storage=globalThis.localStorage, snapshot=renderSnapshot(), clipboard=navigator.clipboard } = {}) {
  let native={};
  try { native=await plugin?.diagnostics?.()||{}; } catch { /* 旧安装包没有新诊断方法 */ }
  const read=key=>{try{return storage.getItem(key)||'';}catch{return '';}};
  let events=[];try{events=JSON.parse(read('jarvis.renderEvents')||'[]');}catch{}
  const text=JSON.stringify({time:new Date().toISOString(),native,view:snapshot,errors:events,hasPreviousCrash:Boolean(read('jarvis.lastCrash'))},null,2);
  if(plugin?.copyDiagnostics)await plugin.copyDiagnostics({text});else await clipboard.writeText(text);
  return text;
}
