import './workbench.css';
import * as sessions from '../agent/sessions.js';
import { initWorkspaceNavigation } from './workbenchNavigation.js';
import { toolLabel } from './transcript.js';
import { initWeiyangShell } from './weiyangShell.js';
import { createMascot } from './mascot.js';

const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
export function initWorkbench({showPanel,newSession,openSession,getSession,getRunning,openFile}){
 document.body.classList.add('workbench','side-closed');document.body.classList.remove('side-open');
 const rail=document.querySelector('.rail'),main=document.querySelector('.main'),top=document.querySelector('.topbar');
 const home=node('div',null,'wb-brand');const mark=node('span',null,'wb-mark');mark.append(createMascot());home.append(mark,node('b','未央'),node('small','WEIYANG AI · 私人智能工作台'));rail.prepend(home);
 const original=[...rail.querySelectorAll('.rail-btn')];original.forEach(b=>b.hidden=true);
 const nav=node('div',null,'wb-nav');home.after(nav);
 const closePanel=()=>{document.body.classList.add('side-closed');document.body.classList.remove('side-open');};
 function button(label,icon,fn,parent=nav){const b=node('button');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.append(node('span',icon,'wb-nav-icon'),node('span',label));b.onclick=fn;parent.append(b);return b;}
 const fresh=button('新建对话','＋',()=>{newSession();setView(false);closePanel();});fresh.className='wb-new';
 const primaryLinks=[['文件空间','▱','workspace'],['专家与技能','◇','skills'],['定时任务','◷','system']];
 const secondaryLinks=[['连接应用','⌘','skills'],['记忆空间','♧','mind'],['知识库','▤','knowledge'],['实验室','⚗','settings']];
 function link([label,icon,panel],parent){const b=button(label,icon,()=>{showPanel(panel);document.body.classList.toggle('wb-connections',label==='连接应用');},parent);b.dataset.destination=label==='连接应用'?'connections':panel;}
 primaryLinks.forEach(item=>link(item,nav));
 const secondary=node('div',null,'wb-nav-secondary');secondary.setAttribute('aria-label','资料与工具');nav.append(secondary);secondaryLinks.forEach(item=>link(item,secondary));
 const recent=node('section',null,'wb-recent'),recentHead=node('div',null,'wb-recent-head'),search=node('button','⌕');search.title='搜索全部对话';search.onclick=()=>showPanel('sessions');recentHead.append(node('span','最近对话'),search);const history=node('div',null,'wb-history-list');history.tabIndex=0;history.setAttribute('aria-label','最近对话列表');recent.append(recentHead,history);rail.append(recent);
 const bottom=node('button','⚙  设置与模型','wb-bottom');bottom.onclick=()=>showPanel('models');rail.append(bottom);
 const tabs=node('nav',null,'wb-tabs'),chat=node('button','对话'),studio=node('button','工作室');tabs.setAttribute('aria-label','工作视图');tabs.append(chat,studio);top.append(tabs);chat.onclick=()=>setView(false);studio.onclick=()=>setView(true);
 function setView(on){closePanel();document.body.classList.toggle('wb-studio',on);if(on)document.body.classList.remove('stage-mini');chat.classList.toggle('selected',!on);studio.classList.toggle('selected',on);chat.setAttribute('aria-pressed',String(!on));studio.setAttribute('aria-pressed',String(on));window.dispatchEvent(new Event('resize'));}setView(false);
 const landing=node('section',null,'wb-landing'),intro=node('div',null,'wb-intro');const hero=node('span',null,'wb-hero-mark');hero.append(createMascot('wave'));intro.append(hero,node('h1','你好，我是未央'),node('p','从一个想法开始，把事情交给我。'));const cards=node('div',null,'wb-cards');
 const suggestions=[['整理工作，轻松开始','拆解目标，安排今天的计划','plan','请帮我梳理今天的工作计划，先问我当前的目标和时间安排。','✓'],['你的专属专家','办公、编程、研究，按需协作','expert','请列出已经安装的技能，并说明哪些适合我现在的工作。','✦'],['文件处理','读文档、写方案、制作演示稿','document','我需要整理一份文档，请先让我提供文件和具体要求。','▤'],['数据分析','读懂表格，发现数据里的线索','data','我想分析一份表格，请先确认文件、分析目标和数据口径。','▥']];
 for(const [title,sub,cls,prompt,art]of suggestions){const b=node('button',null,'wb-card '+cls),copy=node('span');copy.append(node('b',title),node('small',sub));b.append(copy,node('i',art,'wb-card-art'));b.onclick=()=>{const input=document.querySelector('#prompt');input.value=prompt;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();};cards.append(b);}landing.append(intro,cards);main.prepend(landing);
 const transcript=document.querySelector('#transcript');function update(){landing.hidden=!!transcript.querySelector('.msg');}
 new MutationObserver(update).observe(transcript,{childList:true,subtree:true});update();
 document.querySelector('#prompt').placeholder='可以描述任务，或提出任何问题';
 const info=node('aside',null,'wb-info');info.id='wb-conversation-info';info.setAttribute('aria-label','当前对话信息');
 const infoHead=node('div',null,'wb-info-head'),infoTabs=node('div',null,'wb-info-tabs'),conversationTab=node('button','对话信息'),expertTab=node('button','能力信息'),hideInfo=node('button','×','wb-info-close');
 hideInfo.setAttribute('aria-label','收起右侧信息栏');infoTabs.append(conversationTab,expertTab);infoHead.append(infoTabs,hideInfo);
 const infoContent=node('div',null,'wb-info-content');info.append(infoHead,infoContent);document.querySelector('.app').append(info);
 const toggleInfo=node('button','◧','wb-info-toggle');toggleInfo.type='button';toggleInfo.setAttribute('aria-controls',info.id);top.append(toggleInfo);
 let infoOpen=false,infoTab='conversation',infoSignature='';
 function setInfoOpen(open){infoOpen=open;document.body.classList.toggle('wb-info-open',open);info.hidden=!open;toggleInfo.setAttribute('aria-expanded',String(open));toggleInfo.setAttribute('aria-label',open?'收起右侧信息栏':'展开右侧信息栏');toggleInfo.title=open?'收起对话信息':'展开对话信息';try{localStorage.setItem('jarvis.workbench.infoOpen',String(open));}catch{}if(!open&&info.contains(document.activeElement))toggleInfo.focus();window.dispatchEvent(new Event('resize'));}
 toggleInfo.onclick=()=>setInfoOpen(!infoOpen);hideInfo.onclick=()=>setInfoOpen(false);
 function selectInfoTab(tab){infoTab=tab;conversationTab.classList.toggle('selected',tab==='conversation');expertTab.classList.toggle('selected',tab==='expert');conversationTab.setAttribute('aria-pressed',String(tab==='conversation'));expertTab.setAttribute('aria-pressed',String(tab==='expert'));infoSignature='';refreshInfo();}
 conversationTab.onclick=()=>selectInfoTab('conversation');expertTab.onclick=()=>selectInfoTab('expert');
 function section(title){const s=node('section',null,'wb-info-section');s.append(node('h3',title));infoContent.append(s);return s;}
 function refreshInfo(){const current=getSession?.()||{},messages=current.messages||[],files=[...new Set(messages.flatMap(m=>m.files||[]))],usedTools=[...new Set(messages.flatMap(m=>m.tools||[]))],reply=[...messages].reverse().find(m=>m.role==='assistant'&&typeof m.content==='string'),model=document.querySelector('#model-chip')?.textContent?.trim()||'尚未配置';const signature=JSON.stringify([current.id,reply?.content,files,usedTools,model,infoTab]);if(signature===infoSignature)return;infoSignature=signature;const scroll=infoContent.scrollTop;infoContent.replaceChildren();
  if(infoTab==='conversation'){
   const summary=section('最近回复摘要');summary.append(node('p',reply?reply.content.slice(0,320)+(reply.content.length>320?'…':''):'开始对话后，在这里查看最近回复。','wb-info-note'));if(reply)summary.append(node('small','摘自当前会话最近一次回复'));
   const list=section('相关文件'+(files.length?'（'+files.length+'）':''));if(!files.length)list.append(node('p','本次对话还没有生成文件。','wb-info-note'));for(const path of files){if(typeof path!=='string')continue;const b=node('button',null,'wb-info-file');b.type='button';b.title=path;const ext=path.split('.').pop().toLowerCase(),types={docx:['文档','#4376c4'],xlsx:['表格','#408a6f'],csv:['表格','#408a6f'],pptx:['演示','#cb8058'],pdf:['PDF','#c76070'],md:['文本','#9276b5'],py:['代码','#6a7a93'],js:['代码','#6a7a93']},[label,color]=types[ext]||['文件','#9276b5'],badge=node('span',label,'weiyang-file-badge');badge.style.background=color;b.append(badge,node('span',path.split(/[\\/]/).pop()));b.onclick=()=>openFile?.(path);list.append(b);}
  }else{
   section('当前模型').append(node('p',model,'wb-info-note'));
   const toolsSection=section('本次对话使用的工具');if(!usedTools.length)toolsSection.append(node('p','尚未调用工具。','wb-info-note'));for(const tool of usedTools){const label=node('span',toolLabel(tool),'wb-info-tool');label.title=tool;toolsSection.append(label);}
   const skillsButton=node('button','查看与管理全部技能','wb-info-link');skillsButton.onclick=()=>showPanel('skills');infoContent.append(skillsButton);
   const memoryButton=node('button','查看与核实记忆','wb-info-link');memoryButton.onclick=()=>showPanel('mind');infoContent.append(memoryButton);
  }infoContent.scrollTop=scroll;
 }
 selectInfoTab('conversation');let savedOpen=false;try{savedOpen=localStorage.getItem('jarvis.workbench.infoOpen')==='true';}catch{}setInfoOpen(savedOpen);
 const infoTimer=setInterval(()=>{if(!document.hidden)refreshInfo();},700);window.addEventListener('pagehide',()=>clearInterval(infoTimer));
 const panel=document.querySelector('#panel'),panelClose=node('button','×','wb-panel-close');panelClose.title='返回对话';panelClose.setAttribute('aria-label','关闭功能面板');panelClose.onclick=closePanel;panel.prepend(panelClose);
 document.addEventListener('keydown',e=>{if(e.key==='Escape')closePanel();});
 initWorkspaceNavigation({showPanel,closePanel});
 initWeiyangShell({closePanel});
 // 正在回答的对话在“最近对话”里转圈
 let running='';function paint(){const cur=getSession?.()?.id;for(const b of history.querySelectorAll('.wb-chat')){b.classList.toggle('current',b.dataset.id===cur);const on=!!running&&b.dataset.id===running;b.classList.toggle('running',on);if(on)b.setAttribute('aria-busy','true');else b.removeAttribute('aria-busy');}}
 let shown='';function markRunning(){const id=getRunning?.()||'',cur=getSession?.()?.id||'';if(cur!==shown){shown=cur;paint();}if(id===running)return;running=id;paint();if(id&&![...history.querySelectorAll('.wb-chat')].some(b=>b.dataset.id===id)){last='';refresh().catch(()=>{});}}// 新对话还没出现在列表里：重新读一次列表
 let last='';async function refresh(){if(document.hidden)return;const rows=await sessions.list();const signature=JSON.stringify(rows.map(s=>[s.id,s.title,s.updatedAt]));if(signature===last)return;last=signature;history.replaceChildren();for(const s of rows.slice(0,12)){const b=node('button',null,'wb-chat');b.dataset.id=s.id;b.append(node('i',null,'wb-run'),node('span',s.title||'未命名对话'));b.title=s.title;b.onclick=()=>{openSession(s.id);closePanel();setView(false);};history.append(b);}if(!rows.length)history.append(node('p','开始对话后，记录会保存在这里。'));paint();}refresh();const timer=setInterval(()=>refresh().catch(()=>{}),3000);window.addEventListener('pagehide',()=>clearInterval(timer));
 const runTimer=setInterval(markRunning,400);window.addEventListener('pagehide',()=>clearInterval(runTimer));
}
