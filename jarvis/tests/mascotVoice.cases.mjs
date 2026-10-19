import assert from 'node:assert/strict';
import { poseForEmotion, poseForTask, createMascot, setMascotState } from '../src/ui/mascot.js';
import { initCamera } from '../src/ui/composerMedia.js';
import { installSpeechShim } from '../src/mobile/speechShim.js';
import { rankBrowserVoices, synthesize, DIRECTION } from '../src/perception/tts.js';
import { browserDelivery } from '../src/perception/voiceProfile.js';

class Element {
  constructor(tag = '') { this.tagName = tag; this.dataset = {}; this.attrs = {}; this.events = {}; this.children = []; this.files = []; this.videoWidth = 3200; this.videoHeight = 2400; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.events[k] = fn; }
  click() { this.clicked = true; return (this.events.click || this.onclick)?.({ preventDefault() {} }); }
  append(...els) { this.children.push(...els); }
  remove() { this.removed = true; }
  showModal() { this.open = true; }
  focus() {}
  getContext() { return { drawImage() {} }; }
  toBlob(fn) { fn(new Blob(['photo'], { type: 'image/jpeg' })); }
}
async function globals(values, fn) {
  const before = Object.fromEntries(Object.keys(values).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(values)) Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  try { await fn(); } finally { for (const k of Object.keys(values)) { if (before[k]) Object.defineProperty(globalThis, k, before[k]); else delete globalThis[k]; } }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

export const cases = [
  ['现有七种情绪映射到小精灵，不再依赖 emoji', () => {
    assert.deepEqual(['平静','专注','聆听','亲和','安抚','愉悦','警觉'].map(poseForEmotion), ['idle','think','listen','wink','wink','happy','think']);
    assert.equal(poseForTask('processing', '搜索资料'), 'run');
    assert.equal(poseForTask('processing', '规划方案'), 'rub');
    assert.equal(poseForTask('done'), 'happy');
  }],
  ['未知状态安全回退，并提供可读的状态名称', async () => {
    await globals({ document: { createElement: () => new Element() } }, () => {
      const mascot = createMascot('sleep');
      assert.equal(mascot.attrs['aria-label'], '未央：睡觉');
      setMascotState(mascot, 'unexpected');
      assert.equal(mascot.dataset.state, 'idle');
    });
  }],
  ['手机拍照交给系统，取消不增加附件，可重复选同一张照片', async () => {
    const button = new Element(), input = new Element(), calls = [];
    await globals({ navigator: {} }, async () => {
      initCamera({ button, input, native: true, onFiles: f => calls.push(f), onError: e => { throw e; } });
      await button.click(); assert.equal(input.clicked, true);
      input.events.change(); assert.equal(calls.length, 0);
      const photo = new File(['photo'], 'camera.jpg', { type: 'image/jpeg' });
      input.files = [photo]; input.value = 'camera.jpg';
      input.events.change(); input.events.change();
      assert.equal(calls.length, 2); assert.equal(calls[0][0], photo); assert.equal(input.value, '');
    });
  }],
  ['摄像头拒绝权限时清楚提示，不留下预览窗口', async () => {
    const button = new Element(), input = new Element(), errors = [];
    await globals({ navigator: { mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } } } }, async () => {
      initCamera({ button, input, onFiles: () => { throw new Error('不应添加照片'); }, onError: e => errors.push(e.message) });
      await button.click(); assert.match(errors[0], /相机权限被拒绝/);
    });
  }],
  ['电脑拍照限制像素，作为附件加入并释放摄像头', async () => {
    const button = new Element(), input = new Element(), body = new Element(), made = [], files = [];
    let stopped = 0;
    await globals({ navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) } }, document: { body, createElement: tag => { const e = new Element(tag); made.push(e); return e; } } }, async () => {
      initCamera({ button, input, onFiles: f => files.push(...f), onError: e => { throw e; } });
      await button.click();
      assert.equal(files.length, 0);
      await made.find(e => e.textContent === '拍照并添加').click();
      assert.equal(files[0].type, 'image/jpeg');
      assert.equal(made.find(e => e.tagName === 'canvas').width, 2048);
      assert.equal(stopped, 1);
      assert.equal(made.find(e => e.tagName === 'dialog').removed, true);
    });
  }],
  ['中文童声优先；没有童声时温柔中文声优先于英文童声', () => {
    const zh = { name: 'Xiaoxiao Natural', lang: 'zh-CN' }, child = { name: 'Xiaoshuang Neural', lang: 'zh-CN' }, en = { name: 'Child Natural', lang: 'en-US' };
    assert.deepEqual(rankBrowserVoices([en, zh, child]), [child, zh, en]);
  }],
  ['真实童声只轻微调音，显式非童声风格保留原音调', () => {
    assert.ok(browserDelivery({ name: 'Yunxia' }).pitch < browserDelivery({ name: 'system' }).pitch);
    assert.equal(browserDelivery(null, { profile: 'original', pitch: .9 }).pitch, .9);
    assert.match(DIRECTION, /gentle/);
  }],
  ['Edge 默认请求使用轻柔女孩音色，显式选择仍然有效', async () => {
    const calls = [];
    const fetchImpl = async (_url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; };
    await synthesize({ engine: 'edge', voices: {} }, {}, '你好呀', { gateway: { origin: 'http://localhost' }, fetchImpl });
    await synthesize({ engine: 'edge', voices: { edge: 'zh-CN-YunxiNeural' } }, {}, '你好', { gateway: { origin: 'http://localhost' }, fetchImpl });
    assert.equal(calls[0].voice, 'zh-CN-XiaoyiNeural');
    assert.equal(calls[1].voice, 'zh-CN-YunxiNeural');
  }],
  ['安卓系统音色列表异步刷新，并把选中的真实索引交给插件', async () => {
    const spoken = [], g = {};
    installSpeechShim({ getSupportedVoices: async () => ({ voices: [{ name: 'English', lang: 'en-US' }, { name: '中文童声', lang: 'zh-CN' }] }), speak: async o => spoken.push(o), stop: async () => {} }, g);
    let changed = 0;
    g.speechSynthesis.addEventListener('voiceschanged', () => changed++);
    await tick();
    assert.equal(changed, 1);
    const u = new g.SpeechSynthesisUtterance('你好');
    u.voice = g.speechSynthesis.getVoices()[1];
    g.speechSynthesis.speak(u); await u.__done;
    assert.equal(spoken[0].voice, 1);
  }]
];
