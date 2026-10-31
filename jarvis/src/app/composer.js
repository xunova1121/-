/**
 * 输入框：回车发送（手机上回车换行）、自动增高、提示语、常用指令；附件（上传、拍照、粘贴截图、拖进来）；
 * 每条消息下面的“引用 / 朗读”。
 */
import { MOBILE } from '../config.js';
import { initQuickPrompts } from '../ui/quickPrompts.js';
import { initCamera } from '../ui/composerMedia.js';
import { imageButton, previewWorkspaceImage } from '../ui/imagePreview.js';
import { setActionIcon } from '../ui/transcript.js';
import { noteAction } from '../mobile/renderDiagnostics.js';
import { SentenceChunker } from '../core/sentenceChunker.js';
import { toPlainText, toSpeech } from '../core/markdown.js';
import { prepareImage, isImageName } from '../agent/images.js';
import * as ws from '../agent/workspace.js';
import { $, toast } from './env.js';

export function createComposer(app) {
  /** 下一条消息要带的附件（已经存进工作区“上传/”） */
  const attachments = [];

  // —— 输入框：Enter 发送，Shift+Enter 换行；随内容自动增高
  const prompt = $('#prompt');
  function autosize() {
    prompt.style.height = 'auto';
    prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`;
    app.composer?.refresh();
  }
  $('#inputbar').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = prompt.value;
    prompt.value = '';
    autosize();
    app.send(v);
  });
  // 手机（触屏）键盘没有 Shift：回车就是换行，点发送按钮才发送；电脑上回车发送、Shift+回车换行
  const enterSends = () => !MOBILE && !globalThis.matchMedia?.('(pointer: coarse)').matches;
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && enterSends()) {
      e.preventDefault();
      $('#inputbar').requestSubmit();
    }
  });
  prompt.addEventListener('input', (e) => {
    autosize();
    if (e.target.value && app.speaker.speaking) app.speaker.cancel(); // 开始打字即打断朗读
    if (e.target.value && !app.active && app.machine.task !== 'listening') app.machine.beginUserTurn();
  });

  // —— 常用指令：把开头写好放进输入框，接着补充再发
  initQuickPrompts({
    button: $('#btn-quick'),
    onPick: (text) => {
      prompt.value = prompt.value.trim() ? `${text}${prompt.value}` : text;
      autosize();
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    }
  });

  // —— 附件：上传 / 拖入的文件放进工作区“上传/”目录，并附在下一条消息里
  async function addFiles(list) {
    for (const f of list) {
      try {
        const r = await ws.write(`上传/${f.name}`, f);
        // 图片同时作为“看图”输入发给模型
        const image = isImageName(f.name) ? await prepareImage(f).catch(() => null) : null;
        attachments.push({ path: r.path, image });
        app.panels.markFresh(r.path);
      } catch (e) {
        toast(`${f.name}：${e.message}`);
      }
    }
    renderAttachments();
    app.panels.refreshFiles();
    prompt.focus();
  }
  function renderAttachments() {
    queueMicrotask(() => app.composer?.refresh());
    const box = $('#attach-list');
    box.hidden = !attachments.length;
    box.replaceChildren(
      ...attachments.map((a, i) => {
        const x = Object.assign(document.createElement('button'), { type: 'button', textContent: '✕', title: '移除' });
        x.addEventListener('click', () => {
          attachments.splice(i, 1);
          renderAttachments();
        });
        const s = document.createElement('span');
        if (a.image) {
          s.className = 'has-thumb';
          s.append(imageButton(a.image.thumb, () => previewWorkspaceImage(a.path, a.image.thumb).catch((e) => toast(e.message))));
        }
        const label = Object.assign(document.createElement('span'), {
          className: 'attach-name',
          textContent: a.image ? '图片 · 已上传工作区' : a.path.split('/').pop(),
          title: a.path
        });
        s.append(label, x);
        return s;
      })
    );
  }
  // ＋菜单统一处理文件入口；原相机、文件上传处理器保留。
  initCamera({
    button: $('#btn-camera'),
    input: $('#camera-input'),
    native: MOBILE || /Android|iPhone|iPad/i.test(navigator.userAgent),
    onFiles: addFiles,
    onError: (e) => toast(e.message)
  });
  addEventListener('jarvis:open-upload', (e) => {
    app.showPanel('workspace');
    if (e.detail?.path) app.panels.openFile(e.detail.path);
  });
  // 服务器模式：准备打字时先唤醒连接，免得发消息时撞上已经断掉的旧连接白等
  const warm = () => app.server?.warm?.();
  $('#prompt').addEventListener('focus', warm);
  $('#prompt').addEventListener('input', warm);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) warm();
  });
  // 粘贴截图 / 图片
  $('#prompt').addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData?.items ?? [])]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!imgs.length) return;
    e.preventDefault();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    addFiles(imgs.map((f, i) => new File([f], `粘贴-${stamp}${i ? `-${i}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
  });
  $('#file-input').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      dragDepth++;
      $('#drop-overlay').hidden = false;
    }
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('#drop-overlay').hidden = true;
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });

  // 窄屏用短提示语，避免输入框被撑成好几行
  const narrowPrompt = matchMedia('(max-width: 860px)');
  const setPlaceholder = () => {
    $('#prompt').placeholder = narrowPrompt.matches ? '交给我一个任务……' : '交给我一个任务：写代码、做 PPT、分析文件、查资料……（Enter 发送，Shift+Enter 换行）';
  };
  narrowPrompt.addEventListener?.('change', setPlaceholder);
  setPlaceholder();

  // ---------------------------------------------------------------- 每条消息下面的“引用 / 朗读”（复制在 transcript.js 里直接做）
  let readingBtn = null;
  app.transcript.onAction = (kind, text, btn) => {
    if (kind === 'quote') {
      // 引用：把这条的开头放进输入框（“> ……”），接着打字问
      const plainText = toPlainText(text).replace(/\s+/g, ' ').trim();
      const excerpt = plainText.length > 100 ? `${plainText.slice(0, 100)}…` : plainText;
      prompt.value = `> ${excerpt}\n${prompt.value.replace(/^> .*\n/, '')}`;
      autosize();
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      return;
    }
    if (kind === 'edit' || kind === 'retry') {
      app.rewindAndResend(kind, text);
      return;
    }
    if (kind === 'speak') {
      // 朗读这一条：再点一下停；只念正文，代码和表格不念
      const again = readingBtn === btn && app.speaker.speaking;
      app.speaker.cancel();
      if (readingBtn) {
        setActionIcon(readingBtn, 'speak');
        readingBtn.removeAttribute('aria-pressed');
        readingBtn = null;
      }
      if (again) return;
      app.speaker.unlock();
      noteAction('朗读一条回答');
      const chunker = new SentenceChunker();
      for (const s of [...chunker.push(toSpeech(text)), ...chunker.flush()]) app.speaker.speak(s);
      readingBtn = btn;
      setActionIcon(btn, 'stop');
      btn.setAttribute('aria-pressed', 'true');
      const watch = setInterval(() => {
        if (readingBtn !== btn || (!app.speaker.speaking && !app.speaker.pending)) {
          clearInterval(watch);
          if (readingBtn === btn) {
            setActionIcon(btn, 'speak');
            btn.removeAttribute('aria-pressed');
            readingBtn = null;
          }
        }
      }, 600);
    }
  };

  return { prompt, autosize, attachments, addFiles, renderAttachments };
}
