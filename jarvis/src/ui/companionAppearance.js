import './companionRefresh.css';

/** 只管理布局：键盘出现时让角色退让，阅读旧消息时保留阅读位置。 */
export function initCompanionAppearance({ showPanel } = {}) {
  const body = document.body, viewport = window.visualViewport;
  body.classList.add('companion-edition');
  let fullHeight = viewport?.height || innerHeight;
  const editing = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  const resize = () => {
    const height = viewport?.height || innerHeight;
    if (!editing()) fullHeight = height;
    const keyboard = editing() && fullHeight - height > 120;
    body.classList.toggle('wy-keyboard-open',keyboard);
    body.style.setProperty('--wy-viewport-height',`${Math.round(height)}px`);
  };
  viewport?.addEventListener('resize',resize);
  addEventListener('resize',resize);
  addEventListener('orientationchange',()=>{fullHeight=viewport?.height || innerHeight;resize();});
  document.addEventListener('focusin',resize);
  document.addEventListener('focusout',()=>requestAnimationFrame(resize));
  resize();
  if (!body.classList.contains('compact')) return;
  const options = document.createElement('details'); options.className='wy-composer-options';
  const summary=Object.assign(document.createElement('summary'),{textContent:'···'});summary.setAttribute('aria-label','更多选项');
  const menu=document.createElement('div');
  for(const [name,panel] of [['选择模型与声音','models'],['专家与技能','skills']]) {
    const button=Object.assign(document.createElement('button'),{type:'button',textContent:name});
    button.onclick=()=>{options.open=false;showPanel?.(panel);};menu.append(button);
  }
  options.append(summary,menu);document.querySelector('#btn-camera')?.after(options);
  document.addEventListener('click',e=>{if(!options.contains(e.target))options.open=false;});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')options.open=false;});
  const root = document.querySelector('#transcript');
  const jump = Object.assign(document.createElement('button'),{type:'button',className:'wy-jump-latest',textContent:'↓ 回到最新回复',hidden:true});
  root.after(jump);
  const update = () => { jump.hidden = !body.classList.contains('wy-reading-history') || root.scrollHeight-root.scrollTop-root.clientHeight<160; };
  root.addEventListener('scroll',update,{passive:true});
  new MutationObserver(update).observe(root,{childList:true,subtree:true,characterData:true});
  jump.onclick = () => {root.scrollTop=root.scrollHeight;body.classList.remove('wy-reading-history');update();};
}
