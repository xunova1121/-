/**
 * 其他服务的 Key：博查搜索、fal.ai（唱歌）、Tavily 搜索、和风天气，跟着模型页当前位置（本机 / 云服务器）存。
 * 首页与对话天气都使用当前运行位置：云端Key仅留服务器，不再复制到手机本机。
 * 以前本机的在“联网搜索”“按次收费”两块里、服务器的单独一块，现在都在这里。
 * 只显示末四位；留空保存就保留原值（服务器本来就只回掩码）。
 */
const mask = (value) => (!value ? '' : String(value).startsWith('••••') ? value : `••••${String(value).slice(-4)}`);

export function serverKeysPanel({ cfg, workspace, node }) {
  const where = workspace.scope === 'server' ? '云服务器' : '本机';
  const field = (label, value, hint) => {
    const input = node('input', { type: 'password', autocomplete: 'off', ariaLabel: label, maxLength: 512, placeholder: value ? `已配置（${mask(value)}）；留空保留` : '未配置' });
    return { input, row: node('label', { className: 'ml-field' }, node('span', { textContent: label }), input, node('small', { className: 'ml-muted', textContent: hint })) };
  };
  const fields = {
    bochaKey: field('博查搜索 Key', cfg.bochaKey, 'DeepSeek 搜索没开或失败时的备用（国内，中文结果好）；不填就退回免费的必应、百度。申请：open.bochaai.com'),
    falKey: field('fal.ai Key（唱歌）', cfg.falKey, '让未央把写好的歌唱出来，按次收费（约 0.03 美元一首）。fal 在海外，国内网络可能连不上。申请：fal.ai/dashboard/keys'),
    tavilyKey: field('Tavily 搜索 Key', cfg.tavilyKey, '国外资料多时用（英文结果好）。申请：app.tavily.com'),
    qweatherKey: field('和风天气 Key', cfg.qweatherKey, '填了以后天气用和风（国内快，有空气质量、逐小时、7 天、生活指数、预警）；不填用免费的 Open-Meteo。申请：console.qweather.com →“项目管理”创建项目和 API KEY')
  };
  // API Host 不是密钥：明文显示，方便核对
  const hostInput = node('input', { type: 'text', autocomplete: 'off', ariaLabel: '和风天气 API Host', maxLength: 120, placeholder: '如 abc123xyz.re.qweatherapi.com', value: cfg.qweatherHost || '' });
  const hostRow = node('label', { className: 'ml-field' }, node('span', { textContent: '和风天气 API Host' }), hostInput, node('small', { className: 'ml-muted', textContent: '控制台“设置”页里的 API Host，每个账号不一样' }));
  const result = node('p', { className: 'ml-muted', role: 'status' });
  const save = node('button', { type: 'button', className: 'ml-button', textContent: `保存到${where}` });
  save.addEventListener('click', async () => {
    const next = Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.input.value.trim()]).filter(([, value]) => value));
    const host = hostInput.value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (host !== (cfg.qweatherHost || '')) next.qweatherHost = host;
    if (!Object.keys(next).length) {
      result.textContent = '没有填新的 Key，原来的保持不变';
      return;
    }
    save.disabled = true;
    try {
      await workspace.patch((value) => ({ ...value, ...next }));
      if (next.qweatherKey || 'qweatherHost' in next) globalThis.dispatchEvent(new Event('jarvis:weather-config-changed'));
      result.textContent = `已保存到${where}`;
    } catch (error) {
      result.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });
  return node('details', { className: 'ml-copy ml-service-keys' }, node('summary', { textContent: `其他服务的 Key：搜索、唱歌、天气 · ${where}` }), ...Object.values(fields).map((f) => f.row), hostRow, save, result);
}
