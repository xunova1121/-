/**
 * 设置 → 服务器模式：填网址和访问密码登录；开关；把本机的模型设置（含密钥）传到服务器。
 * 开关切换后重新加载页面：对话列表要换成服务器上的（或换回本机的）。
 */
import { loadServerSettings, saveServerSettings, createServerClient, normalizeUrl } from '../core/serverClient.js';
import { listLocal } from '../agent/sessions.js';

const $ = (s) => document.querySelector(s);

/**
 * @param {{ getLlmConfig: () => object, toast: (t: string) => void, reload?: () => void, onConfigSaved?: () => void, onImported?: () => void }} o
 */
export function initServerPanel({ getLlmConfig, toast, reload = () => location.reload(), onConfigSaved = () => {}, onImported = () => {} }) {
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
      onConfigSaved();
    } catch (e) { say(`上传失败：${e.message}`); }
  });
  // 把本机保存的对话一段段传上去（服务器上已有的跳过）；图片缩略图不传，省流量
  $('#btn-server-import').addEventListener('click', async () => {
    if (!loadServerSettings().token) { say('请先登录'); return; }
    const btn = $('#btn-server-import');
    btn.disabled = true;
    try {
      const all = (await listLocal()).filter((x) => x.messages?.length);
      if (!all.length) { say('本机没有保存的对话'); return; }
      let done = 0, skipped = 0, failed = 0;
      for (const [i, one] of all.entries()) {
        say(`正在上传第 ${i + 1} / ${all.length} 段对话…`);
        try {
          const r = await client().importSession({ ...one, messages: one.messages.map(({ thumbs, ...m }) => m) });
          if (r.skipped) skipped++; else done++;
        } catch { failed++; }
      }
      say(`传好了 ${done} 段${skipped ? `，${skipped} 段服务器上已经有了` : ''}${failed ? `，${failed} 段没传上去（可以再点一次）` : ''}`);
      onImported();
    } finally { btn.disabled = false; }
  });
  check();
}
