/**
 * 设置 → 服务器模式：填网址和访问密码登录；开关；把本机的模型设置（含密钥）传到服务器。
 * 开关切换后重新加载页面：对话列表要换成服务器上的（或换回本机的）。
 */
import { loadServerSettings, saveServerSettings, createServerClient, normalizeUrl } from '../core/serverClient.js';

const $ = (s) => document.querySelector(s);

/**
 * @param {{ getLlmConfig: () => object, toast: (t: string) => void, reload?: () => void }} o
 */
export function initServerPanel({ getLlmConfig, toast, reload = () => location.reload() }) {
  const on = $('#server-on');
  if (!on) return;
  const status = $('#server-status');
  const cfg = loadServerSettings();
  $('#server-url').value = cfg.url;
  on.checked = cfg.enabled;
  on.disabled = !cfg.token;
  const say = (t) => { status.textContent = t; };
  const client = () => createServerClient({ base: $('#server-url').value || cfg.url, token: loadServerSettings().token });

  async function check() {
    if (!cfg.enabled || !cfg.token) { say(cfg.token ? '已登录，未开启' : '还没登录'); return; }
    try {
      const s = await client().status();
      say(`已连接 ${normalizeUrl(cfg.url)} · ${s.tasks.length ? `正在做 ${s.tasks.length} 个任务` : '空闲'}`);
    } catch (e) { say(`连不上服务器：${e.message}`); }
  }

  $('#btn-server-login').addEventListener('click', async () => {
    const url = normalizeUrl($('#server-url').value);
    const pass = $('#server-pass').value;
    if (!url || !pass) { say('请填网址和访问密码'); return; }
    say('正在登录…');
    try {
      const token = await createServerClient({ base: url }).login(pass);
      saveServerSettings({ url, token, enabled: true });
      $('#server-pass').value = '';
      toast('已开启服务器模式，正在切换到服务器上的对话');
      reload();
    } catch (e) { say(e.status === 401 ? '密码不对' : `登录失败：${e.message}`); }
  });

  on.addEventListener('change', () => {
    saveServerSettings({ ...loadServerSettings(), enabled: on.checked });
    toast(on.checked ? '已开启服务器模式' : '已关闭服务器模式，任务回到本机做');
    reload();
  });

  $('#btn-server-config').addEventListener('click', async () => {
    if (!loadServerSettings().token) { say('请先登录'); return; }
    try {
      const { voice, stt, ...models } = getLlmConfig(); // 语音还在手机上，不用传
      await client().putConfig(models);
      say('已把模型设置传到服务器（密钥经 HTTPS 加密传输，只存在服务器上）');
    } catch (e) { say(`上传失败：${e.message}`); }
  });
  check();
}
