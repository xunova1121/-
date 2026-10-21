/** 搜索线路按本机/服务器分开保存，测试只使用已保存的配置。 */
import './deepseekSearchPanel.css';
export function deepseekSearchPanel({ cfg, workspace, node, toast }) {
  const scope = workspace.scope;
  let controller = null;
  const enabled = node('input', { type: 'checkbox', checked: cfg.deepseekSearchEnabled === true, ariaLabel: '启用DeepSeek搜索' });
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
      (value) => ({ ...value, deepseekSearchEnabled: enabled.checked, ...(key.value.trim() && { deepseekSearchKey: key.value.trim() }) }),
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
      textContent: '可与任意聊天模型搭配。默认关闭；启用后优先官方Search/Fetch，失败回原搜索/读取线路。此设置只影响当前配置位置。'
    }),
    node('p', {
      className: 'ml-muted',
      textContent: '按官方文档：Search、Fetch各每1000次成功请求5元，普通直接API调用不属于11月前指定工具免费场景。测试每个按钮最多请求2次，也可能计费。'
    }),
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
