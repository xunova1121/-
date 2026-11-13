import { QWEN_VOICES, registerQwenVoices } from '../../shared/qwenRealtime.js';
import { fetchQwenCatalog, savedQwenCatalog } from '../perception/qwenCatalog.js';

/** 音色是有界目录元数据；不保存试听音频，选择变化沿用原voice配置。 */
export function initQwenVoicePicker({ getConfig, patchVoice, getGateway, onChanged }) {
  const initial = savedQwenCatalog(getConfig().voice?.qwenCatalog);
  if (initial) registerQwenVoices(initial.voices);
  const box = document.querySelector('#qwen-voice-tools');
  const input = document.querySelector('#qwen-voice-search');
  const button = document.querySelector('#btn-qwen-voices');
  const info = document.querySelector('#qwen-voice-info');
  let controller = null;
  let note = '';
  input.addEventListener('input', () => onChanged());
  button.addEventListener('click', async () => {
    if (controller) { controller.abort(); return; }
    const current = controller = new AbortController();
    const timer = setTimeout(() => current.abort(), 12000);
    button.textContent = '取消刷新';
    note = '正在读取官方实时音色目录…';
    onChanged();
    try {
      const catalog = await fetchQwenCatalog({ gateway: getGateway(), signal: current.signal });
      if (current.signal.aborted) return;
      registerQwenVoices(catalog.voices);
      patchVoice({ qwenCatalog: catalog });
      note = `已更新官方目录，共${catalog.voices.length}种声音。`;
    } catch (error) {
      note = current.signal.aborted ? '刷新已取消或超时，保留已有声音。' : '刷新未完成，保留已有声音；请检查服务器版本或网络。';
    } finally {
      clearTimeout(timer);
      if (controller === current) controller = null;
      button.textContent = '刷新官方音色';
      onChanged();
    }
  });
  return {
    render(engineId, selected, select) {
      box.hidden = engineId !== 'qwen-realtime';
      if (box.hidden) return;
      const cached = savedQwenCatalog(getConfig().voice?.qwenCatalog);
      const voices = registerQwenVoices(cached?.voices || QWEN_VOICES);
      const query = input.value.trim().toLowerCase();
      const matching = voices.filter(([id, label]) => (id + ' ' + label).toLowerCase().includes(query));
      const visible = [...matching];
      const chosen = voices.find(([id]) => id === selected);
      if (chosen && !visible.some(([id]) => id === selected)) visible.unshift(chosen);
      if (!chosen && selected) visible.unshift([selected, selected + '（请刷新目录确认支持）']);
      select.replaceChildren(...visible.map(([id, label]) => Object.assign(document.createElement('option'), { value: id, textContent: label + ' · ' + id })));
      select.value = selected;
      info.textContent = (note || `${cached ? '上次官方目录' : '内置官方目录'}：${voices.length}种声音。`) + (query ? ` 匹配${matching.length}种，保留当前选择。` : ' 可搜索名字、英文ID或男女声；选择后点击试听。');
    }
  };
}
