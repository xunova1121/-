import './weiyangShell.css';
export function initWeiyangShell({closePanel}) {
 const body=document.body;
 document.title='未央 · 智能工作台';
 if(globalThis.jarvisDesktop){body.classList.add('weiyang-desktop');const bar=document.createElement('div');bar.className='weiyang-titlebar';bar.textContent='未央';body.prepend(bar);globalThis.jarvisDesktop.setTitleBar({color:'#ffffff',symbolColor:'#72727d',height:32}).catch(()=>{});}
 const mobile=matchMedia('(max-width:700px)'),toggle=document.querySelector('.wb-rail-toggle');
 const shade=document.createElement('button');shade.className='weiyang-menu-shade';shade.setAttribute('aria-label','关闭导航');shade.hidden=true;body.append(shade);
 function closeMenu(){body.classList.remove('weiyang-menu-open');shade.hidden=true;if(mobile.matches){toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','打开导航');}}
 const desktopClick=toggle.onclick;
 toggle.onclick=()=>{if(!mobile.matches)return desktopClick();const open=!body.classList.contains('weiyang-menu-open');body.classList.toggle('weiyang-menu-open',open);shade.hidden=!open;toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'关闭导航':'打开导航');};
 shade.onclick=closeMenu;document.querySelector('.rail').addEventListener('click',e=>{if(e.target.closest('button')&&mobile.matches)closeMenu();});
 mobile.addEventListener('change',closeMenu);closeMenu();
 document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu();});
 // Native Android back closes this edition's navigation before minimizing.
 window.addEventListener('weiyang:back',()=>{if(body.classList.contains('weiyang-menu-open'))closeMenu();else if(!body.classList.contains('side-closed'))closePanel();else if(body.classList.contains('wb-info-open'))document.querySelector('.wb-info-toggle')?.click();});
 const viewport=window.visualViewport;
 const resize=()=>{if(mobile.matches&&viewport)body.style.setProperty('--weiyang-height',`${Math.round(viewport.height)}px`);else body.style.removeProperty('--weiyang-height');};viewport?.addEventListener('resize',resize);resize();
}
