import {createMascot,setMascotState} from './mascot.js';
import {createHomeWeather} from './homeWeather.js';
import './home.css';
const el=(tag,text,cls)=>Object.assign(document.createElement(tag),{...(text!==undefined?{textContent:text}:{}),className:cls||''});
export function createHome({weather,fill,send,openPanel}){
  const root=el('div',undefined,'welcome wy-home');
  const hero=el('section',undefined,'home-hero'),copy=el('div',undefined,'home-hero-copy');
  const hour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'}).format(new Date()));
  const greeting=hour<5?'夜深了':hour<11?'早上好':hour<13?'中午好':hour<18?'下午好':'晚上好';
  const title=el('h1');title.append(el('span',`${greeting}，`),el('span','今天也陪着你。'));const care=el('p','把想法交给我，我们一起完成。','home-care');copy.append(title,care);
  const pet=el('button',undefined,'home-pet');pet.type='button';pet.setAttribute('aria-label','摸摸未央的头');const mascot=createMascot('wave');const bubble=el('span','摸摸我的头，打个招呼呀～','home-pet-hint');bubble.setAttribute('role','status');bubble.setAttribute('aria-live','polite');pet.append(mascot,bubble);
  let timer,pose=0;const poses=['pet','love','wink','shy'];pet.onclick=()=>{clearTimeout(timer);setMascotState(mascot,poses[pose++%poses.length]);pet.classList.remove('petted');void pet.offsetWidth;pet.classList.add('petted');pet.querySelector('.home-pet-hint').textContent=['嘿嘿，收到你的温柔啦～','送你一颗小小的心呀♡','嘻嘻，我一直都在呢～','见到你就很开心呀～'][ (pose-1)%4];timer=setTimeout(()=>{setMascotState(mascot,'wave');pet.classList.remove('petted');},2400);};hero.append(copy,pet);
  const weatherUI=createHomeWeather({client:weather,onAdvice:text=>{care.textContent=text;}});root.append(weatherUI.root,hero);
  const featured=el('section',undefined,'home-featured');const info=el('div');info.append(el('small','从一个想法开始'),el('h2','把想法，变成好作品'),el('p','写方案、做演示、整理文档，都可以。'));const start=el('button','开始创作  ↗','home-start');start.type='button';start.onclick=()=>fill('我想创作一份作品，请先帮我梳理目标：');info.append(start);const art=el('div',undefined,'home-paper');art.setAttribute('aria-hidden','true');art.innerHTML='<i></i><i></i><i></i><b>✦</b>';featured.append(info,art);root.append(featured);
  const head=el('div',undefined,'home-suggestions-head');head.append(el('span','今天，想一起做点什么？'));const refresh=el('button','换一换  ↻');refresh.type='button';head.append(refresh);const grid=el('div',undefined,'home-suggestions');
  const choices=[['▤','看看今日热点','几分钟，掌握重点',()=>send('今天有哪些重点新闻，请附上来源和日期')],['☀','安排明天行程','把重要的事，提前安排好',()=>fill('帮我安排明天的行程，我需要完成：')],['✧','寻找创作灵感','让好点子冒出来',()=>fill('帮我寻找创作灵感，主题是：')],['⌕','研究一个话题','有依据，也有新发现',()=>fill('深度调研这个话题，并注明来源：')]];let at=0;function render(){grid.replaceChildren(...[0,1].map(i=>{const [icon,title,desc,action]=choices[(at+i)%choices.length],b=el('button',undefined,'home-suggestion');b.type='button';b.append(el('span',icon,'home-task-icon'),el('b',title),el('small',desc));b.onclick=action;return b;}));}refresh.onclick=()=>{at=(at+2)%choices.length;render();};render();root.append(head,grid);
  const files=el('button',undefined,'home-files');files.type='button';files.append(el('span','▱  文件空间'),el('small','查看最近资料 ↗'));files.onclick=()=>openPanel('workspace');root.append(files);
  const composer=document.querySelector('#inputbar'),prompt=document.querySelector('#prompt'),oldPlaceholder=prompt?.placeholder;
  if(prompt)prompt.placeholder='有想法，或想聊聊，都可以…';
  const footer=el('p','未央陪你，把每一天过得更从容','home-footer');composer?.after(footer);
  let destroyed=false;const observer=new MutationObserver(()=>{if(!root.isConnected)destroy();});function destroy(){if(destroyed)return;destroyed=true;clearTimeout(timer);observer.disconnect();weatherUI.destroy();footer.remove();if(prompt&&prompt.placeholder==='有想法，或想聊聊，都可以…')prompt.placeholder=oldPlaceholder;}queueMicrotask(()=>{if(root.isConnected)observer.observe(root.parentNode,{childList:true});else destroy();});return{root,destroy};
}
