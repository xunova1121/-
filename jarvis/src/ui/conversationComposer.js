import './conversationComposer.css';
import { composerState } from './composerState.js';

/** 三端共用的输入栏。相机、文件和常用指令移入＋菜单，保留原处理器。 */
export function initConversationComposer() {
  const form = document.querySelector('#inputbar'), row = form.querySelector('.composer-row');
  const prompt = form.querySelector('#prompt'), plus = form.querySelector('#btn-attach');
  const model = form.querySelector('#model-chip'), mic = form.querySelector('#btn-mic');
  const call = form.querySelector('#btn-call'), send = form.querySelector('#btn-send'), stop = form.querySelector('#btn-stop');
  const menu = document.createElement('div'); menu.className = 'composer-more'; menu.hidden = true;
  menu.id = 'composer-more'; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', '添加到对话');
  const file = document.createElement('button'); file.type = 'button'; file.textContent = '上传文件'; file.id = 'btn-composer-file';
  file.onclick = () => { close(); form.querySelector('#file-input').click(); };
  const album = document.createElement('button'); album.type = 'button'; album.textContent = '相册';
  const albumInput = document.createElement('input'); albumInput.type = 'file'; albumInput.accept = 'image/*'; albumInput.multiple = true; albumInput.hidden = true;
  albumInput.onchange = () => {
    const target = form.querySelector('#file-input');
    const transfer = new DataTransfer(); for (const f of albumInput.files || []) transfer.items.add(f);
    target.files = transfer.files; target.dispatchEvent(new Event('change', { bubbles:true })); albumInput.value = ''; close();
  };
  album.onclick = () => { close(); albumInput.click(); };
  const camera = form.querySelector('#btn-camera'), quick = form.querySelector('#btn-quick');
  menu.append(camera, album, file, quick, albumInput); form.append(menu);
  for (const extra of row.querySelectorAll('.wb-composer-connect')) menu.append(extra);
  camera.title = '拍照'; camera.setAttribute('aria-label', '拍照添加图片'); camera.append(document.createTextNode('拍照'));
  quick.append(document.createTextNode('常用指令'));
  camera.addEventListener('click', close); quick.addEventListener('click', close);
  plus.title = '添加到对话'; plus.setAttribute('aria-label','添加到对话'); plus.setAttribute('aria-expanded','false'); plus.setAttribute('aria-controls',menu.id);
  plus.querySelector('svg').replaceChildren();
  const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d','M12 5v14M5 12h14'); plus.querySelector('svg').append(path);
  plus.onclick = () => { menu.hidden = !menu.hidden; plus.setAttribute('aria-expanded',String(!menu.hidden)); };
  function close() { menu.hidden = true; plus.setAttribute('aria-expanded','false'); }
  document.addEventListener('pointerdown', e => { if (!form.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { close(); plus.focus(); } });
  row.append(plus, model, stop, mic, call, send); // DOM 顺序与键盘阅读顺序相同
  form.classList.add('conversation-composer');
  function refresh() {
    const state = composerState({text:prompt.value,attachments:form.querySelector('#attach-list')?.children.length,generating:document.body.classList.contains('generating')});
    form.classList.toggle('has-draft',state.hasDraft); form.classList.toggle('is-working',state.stop);
    send.hidden = !state.send; send.disabled = !state.send;
    // 无识别能力时原有 hidden 标志仍然生效，不伪造可用的麦克风。
    mic.style.display = state.voice ? '' : 'none'; call.hidden = !state.voice;
    stop.hidden = !state.stop;
  }
  prompt.addEventListener('input',refresh); form.addEventListener('submit',()=>queueMicrotask(refresh));
  new MutationObserver(refresh).observe(document.body,{attributes:true,attributeFilter:['class']});
  new MutationObserver(refresh).observe(form.querySelector('#attach-list'),{childList:true});
  // 部分旧入口直接写 value 不发 input；在聚焦和返回页面时同步，不轮询。
  prompt.addEventListener('focus',refresh); document.addEventListener('visibilitychange',refresh);
  refresh(); return { refresh, close };
}
