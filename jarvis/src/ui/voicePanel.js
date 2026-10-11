/**
 * “模型”面板里的声音设置：语音引擎、声音、声线效果、提示音、试听。
 */
import { TTS_ENGINES, ttsEngineById } from '../perception/tts.js';
import { FX_PRESETS } from '../perception/voiceFx.js';
import { resolveVoice } from '../llm/config.js';

const $ = (s) => document.querySelector(s);
const opt = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
const OTHER = '__other__';

/**
 * @param {{ panels: { config: object, patchConfig(fn): object }, speaker: import('../perception/speaker.js').Speaker, getGateway: () => object|null }} o
 */
export function initVoicePanel({ panels, speaker, getGateway }) {
  const vc = () => panels.config.voice;
  const patchVoice = (patch) => panels.patchConfig((c) => ({ ...c, voice: { ...c.voice, ...patch } }));

  const engineSel = $('#tts-engine');
  engineSel.replaceChildren(opt('auto', '自动（有密钥就用最自然的云端声音）'), ...TTS_ENGINES.map((e) => opt(e.id, e.name)));

  const fxSeg = $('#tts-fx');
  fxSeg.replaceChildren(...Object.entries(FX_PRESETS).map(([id, p]) => Object.assign(document.createElement('button'), { type: 'button', role: 'radio', textContent: p.name.replace(/ · .*/, ''), title: p.desc, value: id })));

  function render() {
    const cfg = panels.config;
    const v = vc();
    const gateway = getGateway();
    const effective = resolveVoice(cfg, gateway);
    const e = ttsEngineById(effective.engine);
    engineSel.value = v.engine;

    // 引擎说明
    const notes = [];
    if (v.engine === 'auto') notes.push(`当前使用：${e.name}`);
    if (e.id === 'browser') {
      notes.push('浏览器自带声音拿不到音频流，无法加声线效果；Edge 浏览器的“Yunjian / Yunxi (Natural)”是免费声音里最自然的。要电影感的声线，请选云端语音。');
    } else if (!e.browser && !gateway) {
      notes.push(`${e.name} 不允许浏览器直接调用，需要用完整版（本机网关）。`);
    }
    $('#tts-note').hidden = !notes.length;
    $('#tts-note').textContent = notes.join(' ');

    // 声音列表
    const voiceSel = $('#tts-voice');
    let showOtherId = false;
    if (e.id === 'browser') {
      const list = speaker.voices;
      voiceSel.replaceChildren(opt('', list.length ? `自动（${list[0].name}）` : '自动'), ...list.slice(0, 40).map((x) => opt(x.name, `${x.name}${/Natural|Neural|Online/i.test(x.name) ? ' ★' : ''}`)));
      voiceSel.value = v.browserVoice || '';
    } else if (e.custom) {
      voiceSel.replaceChildren();
    } else {
      const cur = v.voices[e.id] || e.voices[0][0];
      const known = e.voices.some(([id]) => id === cur);
      voiceSel.replaceChildren(...e.voices.map(([id, label]) => opt(id, label)), ...(e.id === 'elevenlabs' ? [opt(OTHER, '其他声音 ID…')] : []));
      voiceSel.value = known ? cur : OTHER;
      showOtherId = e.id === 'elevenlabs' && !known;
      $('#tts-voice-id').value = known ? '' : cur;
    }
    $('#row-tts-voice').hidden = Boolean(e.custom);
    $('#row-tts-voice-id').hidden = !showOtherId;
    $('#row-tts-url').hidden = $('#row-tts-model').hidden = !e.custom;
    $('#tts-url').value = v.customURL || '';
    $('#tts-model').value = v.customModel || '';

    // 密钥（与模型面板同一服务商共用）
    const keyRow = $('#row-tts-key');
    keyRow.hidden = e.id === 'browser';
    if (!keyRow.hidden) {
      $('#tts-key').value = cfg.keys[e.keyFrom] || '';
      $('#tts-key').placeholder = gateway?.keys?.includes(e.keyFrom) ? '已使用网关环境变量里的密钥' : e.custom ? '自建服务可留空' : '';
      $('#tts-key-hint').textContent = ['openai', 'siliconflow'].includes(e.id)
        ? `与“模型”里的 ${e.id === 'openai' ? 'OpenAI' : '硅基流动'} 密钥共用。${e.keyUrl ? `获取：${e.keyUrl}` : ''}`
        : e.keyUrl ? `获取：${e.keyUrl}` : '';
    } else {
      $('#tts-key-hint').textContent = '';
    }

    // 声线效果
    const fxOn = e.id !== 'browser';
    for (const b of fxSeg.children) {
      b.setAttribute('aria-checked', String(b.value === v.fx));
      b.disabled = !fxOn;
    }
    $('#tts-fx-desc').textContent = fxOn ? FX_PRESETS[v.fx]?.desc ?? '' : '声线效果只对云端语音生效。';
    $('#tts-cues').checked = v.cues !== false;
  }

  engineSel.addEventListener('change', () => { patchVoice({ engine: engineSel.value }); render(); });
  $('#tts-voice').addEventListener('change', (ev) => {
    const e = ttsEngineById(resolveVoice(panels.config, getGateway()).engine);
    if (e.id === 'browser') patchVoice({ browserVoice: ev.target.value });
    else if (ev.target.value === OTHER) { $('#row-tts-voice-id').hidden = false; $('#tts-voice-id').focus(); return; }
    else patchVoice({ voices: { ...vc().voices, [e.id]: ev.target.value } });
    render();
  });
  $('#tts-voice-id').addEventListener('change', (ev) => {
    const id = ev.target.value.trim();
    if (id) patchVoice({ voices: { ...vc().voices, elevenlabs: id } });
  });
  $('#tts-url').addEventListener('change', (ev) => patchVoice({ customURL: ev.target.value.trim() }));
  $('#tts-model').addEventListener('change', (ev) => patchVoice({ customModel: ev.target.value.trim() }));
  $('#tts-key').addEventListener('change', (ev) => {
    const e = ttsEngineById(resolveVoice(panels.config, getGateway()).engine);
    panels.patchConfig((c) => ({ ...c, keys: { ...c.keys, [e.keyFrom]: ev.target.value.trim() } }));
    render();
  });
  fxSeg.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || b.disabled) return;
    patchVoice({ fx: b.value });
    render();
    speaker.preview('声线已切换。');
  });
  $('#tts-cues').addEventListener('change', (ev) => patchVoice({ cues: ev.target.checked }));
  $('#btn-tts-preview').addEventListener('click', () => {
    const e = ttsEngineById(resolveVoice(panels.config, getGateway()).engine);
    $('#tts-status').textContent = `正在用「${e.name}」试听…`;
    speaker.preview();
    clearTimeout(render.t);
    render.t = setTimeout(() => { $('#tts-status').textContent = ''; }, 5000);
  });
  speaker.onVoicesChanged = () => render();

  render();
  return { render };
}
