/**
 * “模型”面板里的声音设置：语音引擎、声音、声线效果、提示音、试听。
 */
import { MOBILE } from '../config.js';
import { TTS_ENGINES, ttsEngineById } from '../perception/tts.js';
import { FX_PRESETS } from '../perception/voiceFx.js';
import { resolveVoice } from '../llm/config.js';
import { STT_ENGINES, sttEngineById, resolveStt } from '../perception/stt.js';
import { speechRecognitionSupported } from '../perception/voiceInput.js';

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

  $('#tts-azure-region').addEventListener('change', e => patchVoice({ azureRegion:e.target.value.trim() }));
  const fxSeg = $('#tts-fx');
  fxSeg.replaceChildren(...Object.entries(FX_PRESETS).map(([id, p]) => Object.assign(document.createElement('button'), { type: 'button', role: 'radio', textContent: p.name.replace(/ · .*/, ''), title: p.desc, value: id })));

  function render() {
    const cfg = panels.config;
    const v = vc();
    const gateway = getGateway();
    const effective = resolveVoice(cfg, gateway);
    const e = ttsEngineById(effective.engine);
    engineSel.value = v.engine;
    $('#row-tts-azure-region').hidden = e.id !== 'azure'; $('#tts-azure-region').value = v.azureRegion || '';

    // 引擎说明
    const notes = [];
    if (v.engine === 'auto') notes.push(`当前使用：${e.name}`);
    if (e.id === 'browser') {
      notes.push('默认优先选择中文童声，其次是温柔中文声音。手机实际音色取决于已安装的系统朗读引擎；没有童声时会轻微调高音调，不能保证与云端音色相同。');
    } else if (!e.browser && !gateway && !(e.id === 'edge' && globalThis.__jarvisEdgeSpeech)) {
      notes.push(`${e.name} 不允许浏览器直接调用，需要用完整版（本机网关）。`);
    }
    if (e.note) notes.push(e.note);
    if (v.profile === 'gentle-child' && !['azure','browser'].includes(e.id)) notes.push('当前为年轻女声；固定女童声请选择 Azure 晓双并填写密钥与区域。');
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
    keyRow.hidden = e.id === 'browser' || Boolean(e.free) || e.fromProvider;
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
  $('#btn-tts-preview').addEventListener('click', async () => {
    $('#tts-status').textContent = '正在检测实际音色服务…';
    try { const r = await speaker.test(); $('#tts-status').textContent = `已试听：${r.engine} · ${r.voice || '默认音色'}`; }
    catch (e) { $('#tts-status').textContent = `试听失败：${e.message}。没有将系统声音当作所选音色。`; }
  });

  // ------------------------------------------------------------ 语音识别
  const browserSR = speechRecognitionSupported && !window.jarvisDesktop && !MOBILE;
  const sttSel = $('#stt-engine');
  sttSel.replaceChildren(opt('auto', '自动'), ...STT_ENGINES.filter((e) => e.id !== 'browser' || browserSR).map((e) => opt(e.id, e.name)));
  function renderStt() {
    const cfg = panels.config;
    const gateway = getGateway();
    sttSel.value = cfg.stt.engine;
    const id = resolveStt(cfg, { gateway, browserSupported: browserSR });
    const e = sttEngineById(id);
    const notes = [];
    if (cfg.stt.engine === 'auto') notes.push(`当前使用：${e ? e.name : '无'}`);
    if (id === 'none') notes.push(window.jarvisDesktop ? '桌面版没有浏览器自带的语音识别。请在“模型”里填写硅基流动或 OpenAI 的密钥（会自动用于语音识别），或选择自定义识别服务。' : '没有可用的语音识别：请填写硅基流动或 OpenAI 的密钥。');
    else if (e && e.browser === false && !gateway) notes.push(`${e.name} 需要通过本机网关调用（桌面版或完整版）。`);
    if (e && e.id !== 'browser') notes.push('说话的声音由本机检测、按句切分后上传识别，不会持续录音。');
    $('#stt-note').hidden = !notes.length;
    $('#stt-note').textContent = notes.join(' ');
    const custom = id === 'custom' || cfg.stt.engine === 'custom';
    $('#row-stt-url').hidden = $('#row-stt-model').hidden = !custom;
    $('#stt-url').value = cfg.stt.customURL || '';
    $('#stt-model').value = cfg.stt.customModel || '';
  }
  const patchStt = (patch) => panels.patchConfig((c) => ({ ...c, stt: { ...c.stt, ...patch } }));
  sttSel.addEventListener('change', () => { patchStt({ engine: sttSel.value }); renderStt(); });
  $('#stt-url').addEventListener('change', (ev) => patchStt({ customURL: ev.target.value.trim() }));
  $('#stt-model').addEventListener('change', (ev) => patchStt({ customModel: ev.target.value.trim() }));

  speaker.onVoicesChanged = () => render();

  render();
  renderStt();
  return { render: () => { render(); renderStt(); } };
}
