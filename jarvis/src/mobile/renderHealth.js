import { copyRenderDiagnostics, recordRenderError } from './renderDiagnostics.js';
/** 兼容显示只降低绘图开销，不改变任务、语音或已保存的数据。 */
export function applyDisplayMode(safe, { root = document.documentElement, storage = globalThis.localStorage } = {}) {
  safe = Boolean(safe);
  root.classList.toggle('safe-render', safe);
  try { storage.setItem('jarvis.renderSafe', String(safe)); } catch { /* 存储被禁用时本次仍生效 */ }
  return safe;
}

export function initRenderHealthPanel({ mobile = false, toast = () => {}, onChange = () => {} } = {}) {
  const row = document.getElementById('row-render-health');
  if (!mobile || !row) return;
  row.hidden = false;
  const input = row.querySelector('input');
  input.checked = document.documentElement.classList.contains('safe-render');
  addEventListener('error',event=>recordRenderError(event));
  addEventListener('unhandledrejection',event=>recordRenderError(event));
  addEventListener('jarvis:memory-pressure',()=>{applyDisplayMode(true);input.checked=true;onChange();});
  const copy=Object.assign(document.createElement('button'),{type:'button',className:'btn ghost sm',id:'btn-copy-render-diagnostics',textContent:'复制异常诊断'});
  copy.onclick=async()=>{try{await copyRenderDiagnostics();toast('异常诊断已复制');}catch{toast('诊断复制失败，可截图版本下的异常记录');}};
  row.append(copy);
  input.addEventListener('change', async () => {
    const safe = input.checked;
    input.disabled = true;
    try {
      await globalThis.__jarvisRenderHealthPlugin?.setDisplayMode({ safe });
      applyDisplayMode(safe);
      onChange();
      toast(safe ? '已开启兼容显示，减少动效并缩短单页对话' : '已恢复标准显示');
    } catch (error) {
      input.checked = !safe;
      toast(`显示设置未保存：${error.message || error}`);
    } finally { input.disabled = false; }
  });
}
