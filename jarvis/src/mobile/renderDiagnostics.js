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
  const text=JSON.stringify({time:new Date().toISOString(),native,view:snapshot,errors:events,hasPreviousCrash:Boolean(read('jarvis.lastCrash')),screen:read('jarvis.lastScreen')},null,2);
  if(plugin?.copyDiagnostics)await plugin.copyDiagnostics({text});else await clipboard.writeText(text);
  return text;
}

/**
 * 当前在哪个界面（只记界面、打开多久和规模，不记聊天内容）。
 * 崩溃后把上一次记下的这行附在异常记录里，用来判断是启动时、首页空闲、对话中还是面板里崩的。
 */
export function describeScreen({ doc = document, startedAt = 0, now = Date.now() } = {}) {
  const view = renderSnapshot({ doc, perf: null });
  const where = doc.getElementById?.('app-splash') ? '启动页' : view.pane !== 'chat' ? `面板（${view.pane}）` : view.messages ? '对话' : '首页';
  const sec = Math.max(0, Math.round((now - startedAt) / 1000));
  const opened = sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
  const anims = typeof doc.getAnimations === 'function' ? doc.getAnimations().length : null;
  // 最后一次操作（发消息、切换对话、语音、看图片……）：闪退后能对上是哪一步出的事
  const act = globalThis.__jarvisLastAction;
  const lastAct = act?.what ? `最后操作：${act.what}（${Math.max(0, Math.round((now - act.at) / 1000))} 秒前）` : '';
  return [where, `已打开 ${opened}`, `消息 ${view.messages} 条`, anims === null ? '' : `动画 ${anims} 个`, `元素 ${view.nodes} 个`,
    view.safeDisplay ? '兼容显示开' : '兼容显示关', view.hidden ? '在后台' : '', lastAct].filter(Boolean).join(' · ');
}

/** 记下用户刚做了什么（只记动作名，不记内容），写进下一次的“崩溃前界面” */
export const noteAction = (what) => { globalThis.__jarvisLastAction = { what, at: Date.now() }; };

export const SCREEN_KEY = 'jarvis.lastScreen';
export const SCREEN_STARTING = '刚打开（不到 5 秒，界面可能还没显示出来）';

/** 每 5 秒、切到后台 / 回到前台时记一次当前界面；返回上一次运行最后记下的那行 */
export function startScreenTrail({ storage = globalThis.localStorage, doc = document, now = Date.now, every = 5000, timer = setInterval, note = (screen) => globalThis.__jarvisRenderHealthPlugin?.note?.({ screen })?.catch?.(() => {}) } = {}) {
  let prev = '';
  try { prev = storage.getItem(SCREEN_KEY) || ''; storage.setItem(SCREEN_KEY, SCREEN_STARTING); } catch { /* 存不了就不记 */ }
  // 同时报给原生层：渲染进程崩了、界面打不开时，原生的异常记录里也有“崩溃前界面”
  try { note(SCREEN_STARTING); } catch { /* 旧安装包没有这个方法 */ }
  const startedAt = now();
  const tick = () => {
    const screen = describeScreen({ doc, startedAt, now: now() });
    try { storage.setItem(SCREEN_KEY, screen); } catch { /* 存不了就不记 */ }
    try { note(screen); } catch { /* 旧安装包没有这个方法 */ }
  };
  timer(tick, every);
  doc.addEventListener?.('visibilitychange', tick);
  return prev;
}
