import { collection } from '../agent/store.js';
import { workshopChannelScope } from './workshopMediaChannels.js';
import './nestPhoto.css';

const PREFIX = 'jarvis.nest.wallPhoto.v1:';
const changedKey = PREFIX + 'changed';
const MAX_BYTES = 12 * 1024 * 1024;
const THUMB_EDGE = 1100;
const records = collection('kv');

export function acceptsFramePhoto(file) {
  if (!file?.size || file.size > MAX_BYTES) return false;
  return file.type ? /^image\/(?:jpeg|png|webp)$/i.test(file.type) : /\.(?:jpe?g|png|webp)$/i.test(file.name);
}

async function framePreview(file) {
  const src = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = src;
    });
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, THUMB_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#f4eddd';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // 墙上只展示本机缩略图。重新编码后不保留原始照片的相机、定位元数据。
    return await new Promise((resolve, reject) =>
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('encode')), 'image/jpeg', .85));
  } finally { URL.revokeObjectURL(src); }
}

export function createNestPhoto({ world, panel }) {
  const wall = document.createElement('img');
  wall.className = 'nest-wall-photo';
  wall.alt = '挂在小窝墙上的自选照片';
  wall.hidden = true;
  world.append(wall);

  const controls = document.createElement('div');
  controls.className = 'nest-photo-controls';
  const preview = document.createElement('img');
  preview.className = 'nest-photo-preview';
  preview.alt = '当前照片';
  preview.hidden = true;
  const hint = document.createElement('p');
  hint.textContent = '照片保存在本机。可选 12 MB 以内的 JPG、PNG 或 WebP。';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.dataset.nestPhoto = 'file';
  fileInput.accept = 'image/jpeg,image/png,image/webp';
  fileInput.hidden = true;
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.dataset.nestPhoto = 'choose';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.dataset.nestPhoto = 'remove';
  restore.textContent = '恢复原画';
  const feedback = document.createElement('p');
  feedback.setAttribute('role', 'status');
  controls.append(hint, preview, fileInput, choose, restore, feedback);

  let visible = false;
  let key = '';
  let generation = 0;
  let url = '';
  let busy = false;
  let pickScope = '';
  const scopedKey = () => PREFIX + workshopChannelScope();

  function draw(blob) {
    const old = url;
    url = blob instanceof Blob ? URL.createObjectURL(blob) : '';
    for (const img of [wall, preview]) {
      img.hidden = !url;
      if (url) img.src = url;
      else img.removeAttribute('src');
    }
    if (old) URL.revokeObjectURL(old);
    choose.textContent = url ? '更换照片' : '选择照片';
    restore.disabled = !url;
  }

  async function load(force = false) {
    const currentKey = scopedKey();
    if (!force && currentKey === key) return;
    if (currentKey !== key) {
      key = currentKey;
      busy = false;
      draw(null);
      feedback.textContent = '';
    } else if (busy) return;
    const ticket = ++generation;
    try {
      const record = await records.get(currentKey);
      if (visible && ticket === generation && key === scopedKey()) draw(record?.blob);
    } catch {
      if (ticket === generation) feedback.textContent = '暂时无法读取本机相框。';
    }
  }

  async function change(file) {
    if (file && !acceptsFramePhoto(file)) {
      feedback.textContent = '请选择 12 MB 以内的 JPG、PNG 或 WebP 图片。';
      return;
    }
    const target = key;
    if (!target || target !== scopedKey()) return;
    const ticket = ++generation;
    busy = true;
    feedback.textContent = file ? '正在处理照片…' : '';
    let blob;
    try {
      blob = file ? await framePreview(file) : null;
    } catch {
      if (ticket === generation) {
        busy = false;
        feedback.textContent = '这张照片无法打开，请重新选择。';
      }
      return;
    }
    if (ticket !== generation || target !== scopedKey()) return;
    try {
      if (blob) await records.put({ id: target, blob });
      else await records.delete(target);
      // storage 事件只传作用域标记，照片本身只占 IndexedDB 的一个位置。
      try { localStorage.setItem(changedKey, JSON.stringify([target, Date.now(), Math.random()])); } catch { /* 重新进入时会读盘。 */ }
      if (ticket === generation && target === scopedKey() && visible) {
        draw(blob);
        feedback.textContent = blob ? '照片已经挂好。' : '相框已恢复原画。';
      }
    } catch {
      if (ticket === generation) feedback.textContent = '本机未能保存更改，请重试。';
    } finally {
      if (ticket === generation) busy = false;
    }
  }

  function syncTab(event) {
    if (event.key === changedKey || event.key === null) void load(true);
  }
  choose.onclick = () => { pickScope = scopedKey(); fileInput.click(); };
  restore.onclick = () => { void change(null); };
  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file && (!pickScope || pickScope === scopedKey())) void change(file);
    pickScope = '';
  };

  function setVisible(on) {
    if (on === visible) return;
    visible = on;
    if (on) {
      window.addEventListener('storage', syncTab);
      void load(true);
    } else {
      window.removeEventListener('storage', syncTab);
      draw(null);
    }
  }

  return {
    open(trigger) {
      void load();
      feedback.textContent = '';
      panel.open({ title: '墙上相框', kind: 'photo', content: controls, trigger });
    },
    render({ lampOn }) {
      if (visible) void load();
      wall.classList.toggle('nest-photo-dark', !lampOn);
    },
    setVisible,
    dispose() { setVisible(false); generation++; wall.remove(); }
  };
}
