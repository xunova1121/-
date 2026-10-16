/** 桌面背景只绘制静态远景；透明角色窗口负责互动，回复由主窗口同步。 */
import { createHologramScene } from './ui/hologramScene.js';
import './ui/wallpaper.css';
const desktop=window.jarvisDesktop,widget=new URLSearchParams(location.search).has('widget');
const forms=[];let scene=null,pending=null,requestSequence=0,timeout;
if(widget){
  document.body.classList.add('wallpaper-widget');
  scene=createHologramScene({compact:true,send:text=>new Promise((resolve,reject)=>{
    if(pending){reject(new Error('请等待当前回复完成'));return;}
    const id=`wp-${Date.now()}-${++requestSequence}`;pending={id,resolve,reject};scene.newTurn();
    if(!desktop){pending=null;reject(new Error('请在未央桌面版中使用'));return;}
    desktop.invoke('wallpaperChat',{text,id}).catch(error=>{clearTimeout(timeout);pending=null;reject(error);});
    timeout=setTimeout(()=>{if(pending?.id===id){pending=null;reject(new Error('回复尚未完成，可打开完整对话查看任务进度'));}},9*60*1000);
  }),openFull:()=>desktop?.invoke('wallpaperOpen').catch(()=>{}),settings:()=>{
    let options=document.querySelector('.wp-size-options');if(options){options.remove();return;}
    options=document.createElement('div');options.className='wp-size-options';options.innerHTML='<span>拖动顶部可调整位置</span>';
    for(const[label,scale]of[['小',.75],['标准',1],['大',1.15]]){const b=document.createElement('button');b.textContent=label;b.onclick=()=>{desktop?.invoke('wallpaperScale',{scale}).catch(()=>{});options.remove();};options.append(b);}scene.root.append(options);
  }});
  document.body.append(scene.root);
  document.querySelector('.wp').remove();
  let scheduled=false;
  const regions=()=>{scheduled=false;if(!desktop)return;const rows=[...document.querySelectorAll('.holo-pet,.holo-chat,.holo-head,.holo-actions,.holo-collapse,.holo-options,.wp-size-options')].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};});desktop.invoke('wallpaperRegions',{regions:rows}).catch(()=>{});};
  const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(regions);}};
  new ResizeObserver(schedule).observe(scene.root);new MutationObserver(schedule).observe(scene.root,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style']});schedule();
}else{
  const tick=()=>{const now=new Date();document.getElementById('wp-time').textContent=now.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});document.getElementById('wp-date').textContent=now.toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});};tick();setInterval(tick,10000);
}
function show(payload){
  if(payload.form)forms.push(payload.form);
  if(payload.scale&&scene)scene.root.style.setProperty('--holo-widget-scale',String(Math.max(.7,Math.min(1.2,payload.scale))));
  if(payload.newTurn)scene?.update({busy:true,state:'think'});
  if(payload.tool)scene?.pose('rub','正在认真帮你处理…');
  if(payload.say){
    scene?.update({text:payload.say,busy:false,state:payload.error?'think':'happy'});
    const say=document.getElementById('wp-say');if(say){say.textContent=String(payload.say).slice(-180);say.hidden=false;}
    if(pending&&payload.requestId===pending.id){clearTimeout(timeout);const p=pending;pending=null;payload.error?p.reject(new Error(payload.say)):p.resolve();}
  }
}
desktop?.onWallpaper?.(show);
document.addEventListener('visibilitychange',()=>scene?.pause(document.hidden));
window.addEventListener('pagehide',()=>{clearTimeout(timeout);scene?.destroy();});
window.__wallpaper={show,forms,get scene(){return scene;},widget};
