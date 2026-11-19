/** 搜索线路按本机/服务器分开保存，测试只使用已保存的配置。 */
import './deepseekSearchPanel.css';
export function deepseekSearchPanel({ cfg, workspace, node, toast }) {
  const scope = workspace.scope;
  let controller = null;
  const enabled = node('input', { type: 'checkbox', checked: cfg.deepseekSearchEnabled === true, ariaLabel: '启用DeepSeek搜索' });
  const native = node('input', { type: 'checkbox', checked: cfg.deepseekNativeWeb === true });
  const suite = node('input', { type: 'checkbox', checked: cfg.deepseekSuite === true });
  const key = node('input', {
    type: 'password',
    autocomplete: 'off',
    ariaLabel: 'DeepSeek搜索Key',
    placeholder: cfg.deepseekSearchKey ? '已配置；留空保留' : '留空复用本位置的DeepSeek官方模型Key',
    maxLength: 512
  });
  const result = node('p', { className: 'ml-muted', role: 'status' });
  const action = (title, work) => {
    const button = node('button', { type: 'button', className: 'ml-button', textContent: title });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await work();
      } catch (error) {
        result.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    return button;
  };
  const save = action('保存搜索设置', async () => {
    await workspace.patch(
      (value) => ({ ...value, ...(suite.checked !== (cfg.deepseekSuite === true) && { deepseekSuite: suite.checked }), deepseekNativeWeb: native.checked, deepseekSearchEnabled: enabled.checked, ...(key.value.trim() && { deepseekSearchKey: key.value.trim() }) }),
      scope
    );
    key.value = '';
    result.textContent = '已保存到' + (scope === 'server' ? '云服务器' : '本机') + '，不改变聊天模型';
    toast(result.textContent);
  });
  const test = (kind) =>
    action('测试' + (kind === 'search' ? 'Search' : 'Fetch'), async () => {
      if (controller) return;
      controller = new AbortController();
      result.textContent = '正在测试已保存的配置…';
      try {
        const outcome = await workspace.testDeepseekSearch(kind, scope, controller.signal);
        result.textContent =
          kind +
          '：' +
          (outcome.ms / 1000).toFixed(2) +
          '秒，返回' +
          outcome.count +
          (kind === 'search' ? '条结果' : '字符') +
          '；请求' +
          outcome.requests +
          '次。接口可用不代表内容已核实。';
      } finally {
        controller = null;
      }
    });
  return node(
    'details',
    { className: 'ml-copy ml-search-settings' },
    node('summary', { textContent: '联网搜索 · DeepSeek Search/Fetch · ' + (scope === 'server' ? '云服务器' : '本机') }),
    node('p', {
      className: 'ml-muted',
      textContent: '模型内联网需选用官方 deepseek-flash。独立搜索可搭配其他聊天模型，使用下方单独的开关。'
    }),
    node('p', {
      className: 'ml-muted',
      textContent: '上传图片后说“找这张图的出处”可按图搜索。官方 Flash 对话内搜索按模型 Token 计费。独立 Search、Fetch 各 5 元／千次成功请求，下方测试按钮调用独立接口。'
    }),
    node('label', {}, native, '用官方 Flash 联网回答问题并附来源'),
    node('label', {}, suite, '启用 DeepSeek 官方文件问答、OCR 与对话增强'),
    node('p', { className: 'ml-muted', textContent: '文字识别会将原件发给 DeepSeek。文件问答会上传本轮选中的附件，用后请求删除，最迟一小时过期。官方 Flash 对话可生成标题、识别当前日期，审核完成后展示回答。语音识别和朗读可在声音设置中单独选择。各项按官方规则计费。' }),
    node('label', {}, enabled, '启用DeepSeek官方搜索与抓取'),
    node('label', {}, '独立官方API Key（可选）', key),
    node('p', {
      className: 'ml-muted',
      textContent: '留空时优先保留独立Key，否则复用本位置DeepSeek官方服务商的Key；不会使用第三方中转Key。保存后再测试。关闭后恢复原搜索，不自动复制到另一端。'
    }),
    save,
    test('search'),
    test('fetch'),
    action('停止测试', async () => controller?.abort()),
    result
  );
}
