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
    const input = node('input', {
      type: 'password',
      autocomplete: 'off',
      ariaLabel: label,
      maxLength: 512,
      placeholder: value ? `已配置（${mask(value)}）；留空保留` : '未配置'
    });
    return {
      input,
      row: node('label', { className: 'ml-field' }, node('span', { textContent: label }), input, node('small', { className: 'ml-muted', textContent: hint }))
    };
  };
  const fields = {
    qianfanSearchKey: field('百度千帆搜索 Key', cfg.qianfanSearchKey, '国内搜索，按次计费；只填在服务器设置里。保存后可测试真实返回，不改变聊天模型。'),
    // 用户 2026-11-02：不用博查。保留这一栏只为已填过的人能清空；留空就不会用到（搜索已由百度千帆和 DeepSeek 负责）
    bochaKey: field('博查搜索 Key', cfg.bochaKey, '已不推荐：搜索由百度千帆和 DeepSeek 负责，这一栏留空即停用；以前填过的清空保存即可。'),
    falKey: field(
      'fal.ai Key（唱歌）',
      cfg.falKey,
      '让未央把写好的歌唱出来，按次收费（约 0.03 美元一首）。fal 在海外，国内网络可能连不上。申请：fal.ai/dashboard/keys'
    ),
    tavilyKey: field('Tavily 搜索 Key', cfg.tavilyKey, '国外资料多时用（英文结果好）。申请：app.tavily.com'),
    qweatherKey: field(
      '和风天气 Key',
      cfg.qweatherKey,
      '填了以后天气用和风（国内快，有空气质量、逐小时、7 天、生活指数、预警）；不填用免费的 Open-Meteo。申请：console.qweather.com →“项目管理”创建项目和 API KEY'
    )
  };
  const topK = node('input', { type: 'number', min: 5, max: 20, value: String(cfg.qianfanSearchTopK || 10), ariaLabel: '百度搜索返回条数' });
  const topKRow = node('label', { className: 'ml-field' }, node('span', { textContent: '百度搜索返回条数（5～20，默认10）' }), topK);
  const qianfanTest = node('button', { type: 'button', className: 'ml-button', textContent: '测试百度搜索' });
  qianfanTest.addEventListener('click', async () => {
    if (fields.qianfanSearchKey.input.value.trim()) { result.textContent = '请先保存新的百度搜索Key，再测试已保存的配置。'; return; }
    qianfanTest.disabled = true;
    result.textContent = '正在请求百度官方搜索，不使用缓存…';
    try {
      const outcome = await workspace.testQianfanSearch(workspace.scope);
      result.textContent = `百度千帆搜索：${(outcome.ms / 1000).toFixed(2)}秒，${outcome.count}条；` + (outcome.sample || []).map(row => `${row.title}｜${row.publishedAt || '日期未知'}｜${row.domain}`).join('；') + '。搜索摘要未读原文，不代表事实已核实。';
    } catch (error) { result.textContent = error.message; }
    finally { qianfanTest.disabled = false; }
  });
  if (workspace.scope === 'server') {
    for (const name of ['pexels', 'pixabay', 'unsplash'])
      fields[name + 'Key'] = field(name + ' 图库 Key', cfg[name + 'Key'], '仅保存在服务器；保存后需通过国内连接检测才启用，图片按来源许可署名。');
  }
  const stockControls = [];
  const stockStates = new Map();
  const stockConfigured = new Set(['pexels', 'pixabay', 'unsplash'].filter((provider) => !!cfg[provider + 'Key']));
  const needsProbe = (provider) => {
    const providerStatus = stockStates.get(provider);
    if (providerStatus) providerStatus.textContent = 'Key已保存，尚未检测通过';
  };
  if (workspace.scope === 'server') {
    const confirmed = node('input', { type: 'checkbox', ariaLabel: '服务器位于国内网络' });
    stockControls.push(node('label', {}, confirmed, node('span', { textContent: '确认服务器位于国内网络（用于图库实测）' })));
    for (const provider of ['pexels', 'pixabay', 'unsplash', 'openverse']) {
      const button = node('button', { type: 'button', className: 'ml-button', textContent: '检测 ' + provider });
      const providerStatus = node('small', {
        className: 'ml-muted',
        textContent:
          provider !== 'openverse' && !stockConfigured.has(provider)
            ? '尚未配置Key'
            : cfg.stockVerified?.[provider]?.ok
              ? '连接检测已通过，已启用'
              : '尚未检测通过'
      });
      stockStates.set(provider, providerStatus);
      button.addEventListener('click', async () => {
        if (!confirmed.checked) {
          result.textContent = '请先确认服务器网络地区';
          return;
        }
        button.disabled = true;
        try {
          const input = fields[provider + 'Key']?.input,
            key = input?.value.trim();
          // 填完直接点检测时先保存本库Key，不能拿服务器上旧Key检测；不碰其他服务字段。
          if (key) {
            await workspace.patch((value) => ({ ...value, [provider + 'Key']: key }));
            input.value = '';
            stockConfigured.add(provider);
            needsProbe(provider);
          }
          const checked = await workspace.probeStockImages(provider);
          providerStatus.textContent = '连接检测已通过，已启用';
          result.textContent = `${provider} API与图片下载通过：${checked.width}×${checked.height}；已启用`;
        } catch (error) {
          providerStatus.textContent = '本次检测未通过';
          result.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
      stockControls.push(node('div', {}, button, providerStatus));
    }
  }
  // API Host 不是密钥：明文显示，方便核对
  const hostInput = node('input', {
    type: 'text',
    autocomplete: 'off',
    ariaLabel: '和风天气 API Host',
    maxLength: 120,
    placeholder: '如 abc123xyz.re.qweatherapi.com',
    value: cfg.qweatherHost || ''
  });
  const hostRow = node(
    'label',
    { className: 'ml-field' },
    node('span', { textContent: '和风天气 API Host' }),
    hostInput,
    node('small', { className: 'ml-muted', textContent: '控制台“设置”页里的 API Host，每个账号不一样' })
  );
  const result = node('p', { className: 'ml-muted', role: 'status' });
  const save = node('button', { type: 'button', className: 'ml-button', textContent: `保存到${where}` });
  save.addEventListener('click', async () => {
    const next = Object.fromEntries(
      Object.entries(fields)
        .map(([key, f]) => [key, f.input.value.trim()])
        .filter(([, value]) => value)
    );
    const count = Number(topK.value);
    if (!Number.isInteger(count) || count < 5 || count > 20) { result.textContent = '百度搜索条数应为5至20。'; return; }
    if (count !== (cfg.qianfanSearchTopK || 10)) next.qianfanSearchTopK = count;
    const host = hostInput.value
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '');
    if (host !== (cfg.qweatherHost || '')) next.qweatherHost = host;
    if (!Object.keys(next).length) {
      result.textContent = '没有填新的 Key，原来的保持不变';
      return;
    }
    save.disabled = true;
    try {
      await workspace.patch((value) => ({ ...value, ...next }));
      if (next.qianfanSearchKey) fields.qianfanSearchKey.input.value = '';
      if (next.qweatherKey || 'qweatherHost' in next) globalThis.dispatchEvent(new Event('jarvis:weather-config-changed'));
      for (const provider of ['pexels', 'pixabay', 'unsplash'])
        if (next[provider + 'Key']) {
          stockConfigured.add(provider);
          fields[provider + 'Key'].input.value = '';
          needsProbe(provider);
        }
      result.textContent =
        `已保存到${where}` + (Object.keys(next).some((key) => /^(pexels|pixabay|unsplash)Key$/.test(key)) ? '；图库Key需检测通过后启用' : '');
    } catch (error) {
      result.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });
  return node(
    'details',
    { className: 'ml-copy ml-service-keys' },
    node('summary', { textContent: `其他服务的 Key：搜索、唱歌、天气 · ${where}` }),
    ...Object.values(fields).map((f) => f.row),
    topKRow,
    hostRow,
    save,
    qianfanTest,
    ...stockControls,
    result
  );
}
