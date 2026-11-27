import { createMascot, setMascotState } from './mascot.js';
import { actionFromText } from './companion.js';
import './hologramScene.css';

/** 共用的轻量陪伴场景：不用 WebGL，不另开智能体，不在输入时重建表单。 */
export function createHologramScene({ send, close, openFull, wallpaper, settings, compact = false } = {}) {
  const root = document.createElement('section'); root.className = 'wy-hologram';
  root.innerHTML = `<header class="holo-head"><button type="button" class="holo-back" aria-label="收起陪伴">‹</button><span>未央 · 陪伴 <i></i></span><button type="button" class="holo-settings" aria-label="陪伴设置">⚙</button></header><div class="holo-bubble" role="status">你一叫，我就在呀</div><div class="holo-stage"><button type="button" class="holo-pet" aria-label="摸摸未央的头"></button><div class="holo-orbit" aria-hidden="true"></div><div class="holo-ripple" aria-hidden="true">✦</div></div><section class="holo-chat" aria-label="和未央聊天"><div class="holo-chat-head"><span class="holo-avatar"></span><b>未央</b><span class="holo-status">在这里陪你</span><button type="button" class="holo-full">完整对话 ↗</button></div><div class="holo-messages" role="log" aria-label="陪伴对话"></div><form class="holo-form"><input aria-label="和未央说句话" placeholder="和未央说句话…" maxlength="2000" autocomplete="off"><button type="submit" aria-label="发送给未央">↑</button></form></section><div class="holo-actions"><button type="button" data-pose="pet">✧ 摸摸头</button><button type="button" data-pose="love">♡ 比个心</button><button type="button" data-pose="talk">◌ 聊一会</button></div><button type="button" class="holo-collapse">收起陪伴 ⌃</button>`;
  const $ = s => root.querySelector(s), mascot = createMascot('wave');
  $('.holo-pet').append(mascot); $('.holo-avatar').append(createMascot('idle'));
  const input=$('input'), messages=$('.holo-messages'), bubble=$('.holo-bubble');
  let idleTimer, poseTimer, rippleTimer, disposed=false, busy=false, petCount=0, replyNode=null;
  if(compact)root.classList.add('holo-widget');
  const status=text=>{$('.holo-status').textContent=text;};
  const add=(role,text)=>{const el=document.createElement('p');el.className=`holo-message ${role}`;el.textContent=String(text).slice(-4000);messages.append(el);while(messages.children.length>8)messages.firstElementChild.remove();messages.scrollTop=messages.scrollHeight;return el;};
  function wake(){clearTimeout(idleTimer);if(disposed)return;idleTimer=setTimeout(()=>{if(!busy&&document.activeElement!==input){setMascotState(mascot,'sleep');bubble.textContent='我眯一会，有事就叫我呀';}},45000);}
  function pose(state,caption){clearTimeout(poseTimer);setMascotState(mascot,state);if(caption)bubble.textContent=caption;wake();poseTimer=setTimeout(()=>{if(!busy)setMascotState(mascot,'idle');},state==='sleep'?18000:5000);}
  function pet(){petCount++;pose(petCount%3===0?'shy':petCount%2?'pet':'happy',petCount%3===0?'嘿嘿，被你摸得害羞啦':'摸摸头，今天也要开心呀');root.classList.remove('holo-touched');void root.offsetWidth;root.classList.add('holo-touched');clearTimeout(rippleTimer);rippleTimer=setTimeout(()=>root.classList.remove('holo-touched'),900);}
  $('.holo-pet').onclick=pet;
  $('.holo-actions').onclick=e=>{const id=e.target.closest('[data-pose]')?.dataset.pose;if(id==='pet')pet();else if(id==='love')pose('love','送你一颗小小的心');else if(id==='talk'){root.classList.remove('holo-chat-collapsed');input.focus();}};
  function collapse(){if(close)close();else{root.classList.toggle('holo-chat-collapsed');input.blur();}}
  $('.holo-back').onclick=collapse;$('.holo-collapse').onclick=collapse;
  $('.holo-full').onclick=()=>openFull?.();
  $('.holo-settings').onclick=()=>{let menu=$('.holo-options');if(menu){menu.remove();return;}menu=document.createElement('div');menu.className='holo-options';const choices=[['安静动效',()=>{root.classList.toggle('holo-quiet');menu.remove();}],...(wallpaper?[['设为手机动态壁纸',async()=>{menu.remove();try{await wallpaper();}catch(e){bubble.textContent=e.message||'系统暂不支持动态壁纸';}}]]:[]),...(settings?[['角色大小与位置',()=>{settings();menu.remove();}]]:[])];for(const [label,fn]of choices){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;menu.append(b);}root.append(menu);};
  $('form').onsubmit=async e=>{e.preventDefault();const text=input.value.trim();if(!text||busy)return;wake();input.value='';add('user',text);replyNode=null;const action=actionFromText(text);if(action){pose(action[0],action[2]);add('assistant',action[2]);return;}if(!send){add('assistant','请打开未央主窗口继续对话。');return;}busy=true;status('正在想…');root.dataset.busy='true';$('form button').disabled=true;setMascotState(mascot,'think');bubble.textContent='我在想，稍等一下哦';try{await send(text);}catch(error){add('assistant',`这次没有完成：${error.message||error}`);}finally{busy=false;delete root.dataset.busy;$('form button').disabled=false;status('在这里陪你');if(!disposed)pose('happy','我在呀，还有什么想和我说？');}};
  root.addEventListener('pointerdown',wake,{passive:true});input.addEventListener('focus',()=>{root.classList.add('holo-editing');wake();});input.addEventListener('blur',()=>root.classList.remove('holo-editing'));
  function update({text,state,busy:working}={}){if(disposed)return;if(state)setMascotState(mascot,state);if(working!==undefined){root.classList.toggle('holo-working',working);status(working?'正在想…':'在这里陪你');}if(text){const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<60;if(!replyNode||!replyNode.isConnected)replyNode=add('assistant',text);else replyNode.textContent=String(text).slice(-4000);if(nearBottom)messages.scrollTop=messages.scrollHeight;}}
  wake();return{root,update,pose,pet,focus:()=>input.focus(),newTurn:()=>{replyNode=null;},pause(on){root.classList.toggle('holo-paused',on);if(on){clearTimeout(idleTimer);clearTimeout(poseTimer);}else wake();},destroy(){disposed=true;clearTimeout(idleTimer);clearTimeout(poseTimer);clearTimeout(rippleTimer);root.remove();}};
}

/** 应用内全屏入口，回复沿用主对话；关闭不会中断已经开始的任务。 */
export function initHologramCompanion({send,wallpaper,onFull}={}){
  const dialog=document.createElement('dialog');dialog.className='holo-dialog';dialog.setAttribute('aria-label','未央全息陪伴');
  let previousFocus,observer,scene,lastReply,lastText='',queued=false;
  const sync=()=>{queued=false;if(!dialog.open)return;const reply=[...document.querySelectorAll('#transcript .msg.agent')].at(-1);if(reply!==lastReply){lastReply=reply;scene.newTurn();}const text=[...(reply?.querySelectorAll('.body')||[])].map(el=>el.textContent).join('\n');scene.update({...(text!==lastText?{text}:{}),busy:!!reply?.classList.contains('streaming'),state:reply?reply.classList.contains('streaming')?'think':'happy':'idle'});lastText=text;};
  const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(sync);}};
  const close=()=>dialog.close();
  scene=createHologramScene({send,close,openFull:()=>{close();onFull?.();},wallpaper});dialog.append(scene.root);document.body.append(dialog);
  function open(){if(dialog.open)return;previousFocus=document.activeElement;dialog.showModal();scene.pause(false);scene.pose('wave','你一叫，我就在呀');lastReply=null;lastText='';sync();observer=new MutationObserver(schedule);observer.observe(document.querySelector('#transcript'),{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class']});document.body.classList.add('holo-open');dispatchEvent(new Event('jarvis:chrome-ready'));}
  dialog.addEventListener('close',()=>{observer?.disconnect();scene.pause(true);document.body.classList.remove('holo-open');previousFocus?.focus();dispatchEvent(new Event('jarvis:chrome-ready'));});
  const visibility=()=>scene.pause(document.hidden||!dialog.open);document.addEventListener('visibilitychange',visibility);
  scene.pause(true);return{open,close};
}
