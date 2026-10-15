import { createMascot, setMascotState } from './mascot.js';

export const ACTIONS = [
  ['wave', '挥挥手', '嗨，我在这里呀。'], ['wink', '眨眼睛', '收到，给你一个小眨眼。'],
  ['rub', '搓搓手', '准备好啦，交给我吧。'], ['spin', '转个圈', '转一圈，好心情也转过来啦。'],
  ['run', '跑起来', '冲呀，和你一起向前跑！'], ['happy', '开心', '见到你就很开心。'],
  ['sleep', '睡一会', '让我眯一小会，有事就叫我。'], ['shy', '害羞', '被你发现我害羞啦。'],
  ['love', '比个心', '送你一颗小小的心。'], ['dance', '跳个舞', '来，一起轻轻摇摆。']
];
export function actionFromText(text) {
  const t = String(text || '').trim().replace(/[，。！!？?～~\s]/g, '').replace(/^(?:未央|请|你|给我|帮我|可以|能不能|来|再)+/, '');
  const patterns = [
    /^(?:挥挥?手|挥一下手|招手|打个招呼)(?:一下|吧)?$/, /^(?:眨.*眼(?:睛)?|wink)(?:一下|吧)?$/i,
    /^(?:搓.*手)(?:一下|吧)?$/, /^(?:转(?:个|一|一下)?圈(?:圈)?|spin)(?:吧)?$/i,
    /^(?:跑起来|狂奔|奔跑|跑一下)(?:吧)?$/, /^(?:开心|高兴|笑一笑|笑一个)(?:吧)?$/,
    /^(?:睡觉|睡一会|睡个觉|休息一下)(?:吧)?$/, /^(?:害羞|羞一下)(?:吧)?$/,
    /^(?:比(?:个|一颗)?心|爱心)(?:吧)?$/, /^(?:跳(?:个|一支)?舞|dance)(?:吧)?$/i
  ];
  // 只处理单独的动作句；带任务内容的长句继续交给模型。
  return t.length <= 14 ? ACTIONS[patterns.findIndex(p => p.test(t))] || null : null;
}

export function initCompanion({ send, startVoice, stopVoice, speak }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'wy-companion';
  dialog.innerHTML = `<div class="wy-companion-head"><strong>未央在这里</strong><button type="button" class="wy-close" aria-label="关闭未央">×</button></div><div class="wy-companion-stage"></div><p class="wy-companion-say" role="status">点一个动作，或直接和我说话。</p><div class="wy-actions"></div><form class="wy-companion-form"><input aria-label="对未央说" placeholder="比如：转个圈，或帮我查天气" maxlength="2000"><button type="submit">发送</button></form><button type="button" class="wy-companion-voice">开始语音对话</button>`;
  const mascot = createMascot('wave');
  dialog.querySelector('.wy-companion-stage').append(mascot);
  const say = dialog.querySelector('.wy-companion-say');
  let timer, previousFocus, ownsVoice = false, voiceStarting = false, generation = 0;
  const observer = new MutationObserver(() => {
    const replies = document.querySelectorAll('#transcript .msg.agent');
    const last = replies[replies.length - 1];
    if (last) say.textContent = (last.querySelector('.msg-text') || last).textContent.slice(-600);
  });
  function pose(state, caption) {
    clearTimeout(timer); setMascotState(mascot, state); if (caption) say.textContent = caption;
    timer = setTimeout(() => setMascotState(mascot, 'idle'), state === 'sleep' ? 18000 : 7000);
  }
  function open() {
    if (dialog.open) return;
    previousFocus = document.activeElement;
    dialog.showModal(); pose('wave', '我在呢。你想和我说什么？');
    observer.observe(document.querySelector('#transcript'), { childList: true, characterData: true, subtree: true });
  }
  function perform(text) {
    const a = actionFromText(text); if (!a) return false;
    if (!dialog.open) open(); pose(a[0], a[2]); speak?.(a[2]); return true;
  }
  for (const [state, label, caption] of ACTIONS) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
    b.addEventListener('click', () => { pose(state, caption); speak?.(caption); }); dialog.querySelector('.wy-actions').append(b);
  }
  dialog.querySelector('.wy-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => { clearTimeout(timer); observer.disconnect(); generation++; if (ownsVoice || voiceStarting) stopVoice(); ownsVoice = false; dialog.querySelector('.wy-companion-voice').textContent = '开始语音对话'; previousFocus?.focus(); });
  dialog.querySelector('form').addEventListener('submit', e => {
    e.preventDefault(); const input = dialog.querySelector('input'); const text = input.value.trim(); if (!text) return; input.value = '';
    if (!perform(text)) { pose('think', '我在想，稍等一下哦…'); send(text); }
  });
  dialog.querySelector('.wy-companion-voice').addEventListener('click', async () => {
    const button = dialog.querySelector('.wy-companion-voice'); button.disabled = true; const gen = generation;
    try {
      if (ownsVoice) { await stopVoice(); ownsVoice = false; }
      else { say.textContent = '正在打开麦克风…'; voiceStarting = true; ownsVoice = await startVoice(); if (gen !== generation || !dialog.open) { await stopVoice(); ownsVoice = false; return; } if (ownsVoice) pose('listen', '直接说话吧，我在听。'); else say.textContent = '语音未能开启，请查看下方提示，或先打字和我说。'; }
      button.textContent = ownsVoice ? '结束语音对话' : '开始语音对话';
    } finally { voiceStarting = false; button.disabled = false; }
  });
  document.body.append(dialog);
  for (const mark of document.querySelectorAll('.wb-mark, .wb-hero-mark')) { mark.setAttribute('role', 'button'); mark.tabIndex = 0; mark.setAttribute('aria-label', '打开未央，和我说话'); }
  const activate = e => {
    const mark = e.target.closest('.brand-mark, .wb-mark, .welcome-hero .cloud, .wb-hero-mark');
    if (!mark || (e.type === 'keydown' && !['Enter', ' '].includes(e.key))) return;
    e.preventDefault(); open();
  };
  document.addEventListener('click', activate); document.addEventListener('keydown', activate);
  return { perform, open, close: () => dialog.close() };
}
