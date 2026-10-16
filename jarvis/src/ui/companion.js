import { createMascot, setMascotState } from './mascot.js';

export const ACTIONS = [
  ['wave', '挥挥手', '嗨，我在这里呀。'], ['wink', '眨眼睛', '收到，给你一个小眨眼。'],
  ['rub', '搓搓手', '准备好啦，交给我吧。'], ['spin', '转个圈', '转一圈，好心情也转过来啦。'],
  ['run', '跑起来', '冲呀，和你一起向前跑！'], ['happy', '开心', '见到你就很开心。'],
  ['sleep', '睡一会', '让我眯一小会，有事就叫我。'], ['shy', '害羞', '被你发现我害羞啦。'],
  ['love', '比个心', '送你一颗小小的心。'], ['dance', '跳个舞', '来，一起轻轻摇摆。'],
  ['pet', '摸摸头', '摸摸头，收到你的温柔啦。']
];
export function actionFromText(text) {
  const t = String(text || '').trim().replace(/[，。！!？?～~\s]/g, '').replace(/^(?:未央|请|你|给我|帮我|可以|能不能|来|再)+/, '');
  const patterns = [
    /^(?:挥挥?手|挥一下手|招手|打个招呼)(?:一下|吧)?$/, /^(?:眨.*眼(?:睛)?|wink)(?:一下|吧)?$/i,
    /^(?:搓.*手)(?:一下|吧)?$/, /^(?:转(?:个|一|一下)?圈(?:圈)?|spin)(?:吧)?$/i,
    /^(?:跑起来|狂奔|奔跑|跑一下)(?:吧)?$/, /^(?:开心|高兴|笑一笑|笑一个)(?:吧)?$/,
    /^(?:睡觉|睡一会|睡个觉|休息一下)(?:吧)?$/, /^(?:害羞|羞一下)(?:吧)?$/,
    /^(?:比(?:个|一颗)?心|爱心)(?:吧)?$/, /^(?:跳(?:个|一支)?舞|dance)(?:吧)?$/i, /^(?:摸摸头|摸一下头|摸个头|摸头)(?:吧)?$/
  ];
  // 只处理单独的动作句；带任务内容的长句继续交给模型。
  return t.length <= 14 ? ACTIONS[patterns.findIndex(p => p.test(t))] || null : null;
}

export function initCompanion({ send, startVoice, stopVoice, speak }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'wy-companion'; dialog.setAttribute('aria-labelledby','wy-companion-title');
  const mic = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';
  dialog.innerHTML = `<div class="wy-companion-head"><span>陪伴模式</span><button type="button" class="wy-close" aria-label="关闭未央">×</button></div><div class="wy-companion-stage" role="button" tabindex="0" aria-label="摸摸未央的头"></div><h2 class="wy-companion-title" id="wy-companion-title">你一叫，我就在呀</h2><p class="wy-companion-say" role="status">点一个动作，或直接和我说话。</p><div class="wy-actions wy-primary-actions"></div><details class="wy-actions-more"><summary>更多表情</summary><div class="wy-actions wy-extra-actions"></div></details><p class="wy-companion-tip">说一句，也可以指挥我做动作</p><form class="wy-companion-form" hidden><input aria-label="对未央说" placeholder="比如：转个圈，或帮我查天气" maxlength="2000"><button type="submit">发送</button></form><div class="wy-companion-controls"><button type="button" class="wy-companion-keyboard" aria-label="切换文字输入" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10"/></svg></button><button type="button" class="wy-companion-voice" aria-label="开始语音对话" aria-pressed="false">${mic}</button><button type="button" class="wy-companion-end" aria-label="结束对话并关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 14c4-6 14-6 18 0l-2 4-4-2v-3H9v3l-4 2z"/></svg></button></div>`;
  const stage = dialog.querySelector('.wy-companion-stage'), mascot = createMascot('wave'); stage.append(mascot);
  const say = dialog.querySelector('.wy-companion-say'), form = dialog.querySelector('form'), input = form.querySelector('input');
  const voiceButton = dialog.querySelector('.wy-companion-voice');
  let timer, previousFocus, ownsVoice = false, voiceStarting = false, generation = 0, poseUntil = 0, lastText = '';
  const reply = () => document.querySelector('#transcript .msg.agent:last-child');
  const replyText = () => [...(reply()?.querySelectorAll('.body') || [])].map(b=>b.textContent).join('\n').slice(-600);
  const voiceState = () => document.body.classList.contains('generating') ? 'think' : document.body.classList.contains('speaking') ? 'happy' : 'listen';
  const renderVoice = () => { voiceButton.setAttribute('aria-pressed',String(ownsVoice)); voiceButton.setAttribute('aria-label',ownsVoice?'结束语音对话':'开始语音对话'); say.classList.toggle('voice-active',ownsVoice); };
  const observer = new MutationObserver(() => {
    const text = replyText();
    if (text && text !== lastText) { lastText = text; say.textContent = text; poseUntil = 0; clearTimeout(timer); if (!ownsVoice) setMascotState(mascot,reply()?.classList.contains('streaming')?'think':'happy'); }
    if (ownsVoice && Date.now() >= poseUntil) { setMascotState(mascot,voiceState()); const status=document.querySelector('#voice-call-status')?.textContent; if (status) say.textContent=status; }
  });
  function pose(state, caption) {
    clearTimeout(timer); setMascotState(mascot,state); if (caption) say.textContent=caption;
    const duration=state==='sleep'?18000:7000; poseUntil=Date.now()+duration;
    timer=setTimeout(()=>{poseUntil=0;setMascotState(mascot,ownsVoice?voiceState():'idle');},duration);
  }
  function open() {
    if (dialog.open) return;
    previousFocus=document.activeElement; lastText=replyText(); dialog.showModal(); pose('wave','我在呢。你想和我说什么？');
    observer.observe(document.querySelector('#transcript'),{childList:true,characterData:true,subtree:true});
    observer.observe(document.body,{attributes:true,attributeFilter:['class']});
    const status=document.querySelector('#voice-call-status'); if(status)observer.observe(status,{childList:true,characterData:true,subtree:true});
  }
  function perform(text) {
    const action=actionFromText(text); if(!action)return false;
    if(!dialog.open)open();pose(action[0],action[2]);speak?.(action[2]);return true;
  }
  const primary=['wink','spin','rub','love','pet','dance'], symbols={wink:'◉',spin:'⟳',rub:'✦',love:'♡',pet:'✧',dance:'♫',wave:'⌁',run:'»',happy:'☺',sleep:'☾',shy:'❀'};
  const addAction=action=>{
    const [state,label,caption]=action, button=Object.assign(document.createElement('button'),{type:'button'});
    const symbol=Object.assign(document.createElement('span'),{className:'wy-action-symbol',textContent:symbols[state]||'✦'});symbol.setAttribute('aria-hidden','true');
    button.append(symbol,document.createTextNode(label));button.dataset.action=state;
    button.addEventListener('click',()=>{pose(state,caption);speak?.(caption);});
    dialog.querySelector(primary.includes(state)?'.wy-primary-actions':'.wy-extra-actions').append(button);
  };
  primary.forEach(id=>addAction(ACTIONS.find(a=>a[0]===id)));ACTIONS.filter(a=>!primary.includes(a[0])).forEach(addAction);
  const pet=()=>{pose('pet','摸摸头，收到你的温柔啦。');speak?.('收到你的温柔啦。');};
  stage.addEventListener('click',pet);stage.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();pet();}});
  dialog.querySelector('.wy-close').addEventListener('click',()=>dialog.close());
  dialog.querySelector('.wy-companion-end').addEventListener('click',()=>{stopVoice();ownsVoice=false;renderVoice();dialog.close();});
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  dialog.addEventListener('close',()=>{clearTimeout(timer);observer.disconnect();generation++;if(ownsVoice||voiceStarting)stopVoice();ownsVoice=false;renderVoice();previousFocus?.focus();});
  const keyboard=dialog.querySelector('.wy-companion-keyboard');
  keyboard.addEventListener('click',()=>{form.hidden=!form.hidden;keyboard.setAttribute('aria-expanded',String(!form.hidden));if(!form.hidden)input.focus();});
  form.addEventListener('submit',e=>{e.preventDefault();const text=input.value.trim();if(!text)return;input.value='';if(!perform(text)){pose('think','我在想，稍等一下哦…');Promise.resolve(send(text)).catch(error=>{say.textContent=`这次没有完成：${error.message}`;setMascotState(mascot,'think');});}});
  voiceButton.addEventListener('click',async()=>{
    voiceButton.disabled=true;const gen=generation;
    try {
      if(ownsVoice){await stopVoice();ownsVoice=false;say.textContent='语音已结束，也可以继续打字。';}
      else{say.textContent='正在打开麦克风…';voiceStarting=true;ownsVoice=await startVoice();if(gen!==generation||!dialog.open){await stopVoice();ownsVoice=false;return;}if(ownsVoice){poseUntil=0;setMascotState(mascot,'listen');say.textContent='直接说话吧，我在听。';}else say.textContent='语音未能开启，可以检测语音或先打字和我说。';}
    } catch(error){say.textContent=`语音无法开启：${error.message||error}`;ownsVoice=false;}
    finally{voiceStarting=false;voiceButton.disabled=false;renderVoice();}
  });
  document.body.append(dialog);
  for(const mark of document.querySelectorAll('.wb-mark,.wb-hero-mark')){mark.setAttribute('role','button');mark.tabIndex=0;mark.setAttribute('aria-label','打开未央，和我说话');}
  const activate=e=>{const mark=e.target.closest('.brand-mark,.wb-mark,.welcome-hero .cloud,.wb-hero-mark');if(!mark||(e.type==='keydown'&&!['Enter',' '].includes(e.key)))return;e.preventDefault();open();};
  document.addEventListener('click',activate);document.addEventListener('keydown',activate);
  return{perform,open,close:()=>dialog.close()};
}
