/** 独立联网搜索设置：按保存位置隔离，不借用聊天服务商的地址或密钥。 */
import './deepseekSearchPanel.css';
import './openaiSearchPanel.css';
import { openaiSearchEndpoint } from '../agent/openaiSearch.js';

export function openaiSearchPanel({ cfg, workspace, node, toast }) {
  const scope = workspace.scope;
  const where = scope === 'server' ? '云服务器' : '本机';
  let controller = null;
  let configuredKey = Boolean(cfg.openaiSearchKey);
  const enabled = node('input', { type: 'checkbox', checked: cfg.openaiSearchEnabled === true, ariaLabel: '启用自定义联网搜索' });
  const baseURL = node('input', {
    type: 'url', autocomplete: 'off', ariaLabel: '自定义搜索API地址', maxLength: 500,
    value: cfg.openaiSearchBaseURL || '', placeholder: '例如 https://api.example.com/v1'
  });
  const model = node('input', {
    type: 'text', autocomplete: 'off', ariaLabel: '自定义搜索模型ID', maxLength: 200,
    value: cfg.openaiSearchModel || '', placeholder: '填写服务商提供的联网搜索模型 ID'
  });
  const protocol = node('select', { ariaLabel: '自定义搜索接口格式' },
    node('option', { value: 'responses', textContent: 'Responses · 联网搜索工具' }),
    node('option', { value: 'chat-completions', textContent: 'Chat Completions · 搜索模型' })
  );
  protocol.value = cfg.openaiSearchProtocol || 'responses';
  const modelHelp = node('p', { className: 'ml-muted' });
  const explainModel = () => {
    modelHelp.textContent = protocol.value === 'responses'
      ? '这里填支持 Responses 联网工具的模型 ID（调用示例中的 model），不是 WebSearch 工具名称。服务商还必须支持 tools: [{type: "web_search"}]；仅兼容 OpenAI 聊天不代表支持此功能。'
      : '这里填服务商提供的联网搜索模型 ID（调用示例中的 model）。普通聊天型号不会自动获得搜索能力。';
  };
  protocol.addEventListener('change', explainModel);
  explainModel();
  const key = node('input', {
    type: 'password', autocomplete: 'off', ariaLabel: '自定义搜索API Key', maxLength: 512,
    placeholder: configuredKey ? '已配置；留空保留' : '填写此搜索服务的 API Key'
  });
  const result = node('p', { className: 'ml-muted', role: 'status' });
  const values = () => ({
    openaiSearchEnabled: enabled.checked,
    openaiSearchBaseURL: baseURL.value.trim().replace(/\/+$/, ''),
    openaiSearchModel: model.value.trim(),
    openaiSearchProtocol: protocol.value
  });
  let saved = JSON.stringify(values());
  const inputs = [enabled, baseURL, model, protocol, key];
  const action = (title, work) => {
    const button = node('button', { type: 'button', className: 'ml-button', textContent: title });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await work(); }
      catch (error) { result.textContent = error.name === 'AbortError' ? '已停止测试' : error.message; }
      finally { button.disabled = false; }
    });
    return button;
  };
  const save = action('保存自定义搜索', async () => {
    if (controller) { result.textContent = '请先停止测试，再保存配置。'; return; }
    const next = values();
    const newKey = key.value.trim();
    if (next.openaiSearchBaseURL) openaiSearchEndpoint(next.openaiSearchBaseURL, next.openaiSearchProtocol);
    if (next.openaiSearchEnabled && (!next.openaiSearchBaseURL || !next.openaiSearchModel || (!newKey && !configuredKey))) {
      result.textContent = '启用前请填写 API 地址、联网搜索模型 ID 和 API Key。';
      return;
    }
    inputs.forEach(input => { input.disabled = true; });
    try {
      await workspace.patch(value => ({ ...value, ...next, ...(newKey && { openaiSearchKey: newKey }) }), scope);
      if (newKey) configuredKey = true;
      key.value = '';
      key.placeholder = configuredKey ? '已配置；留空保留' : '填写此搜索服务的 API Key';
      saved = JSON.stringify(next);
      result.textContent = `已保存到${where}，不改变聊天模型`;
      toast?.(result.textContent);
    } finally { inputs.forEach(input => { input.disabled = false; }); }
  });
  const test = action('测试自定义搜索', async () => {
    if (controller) return;
    if (key.value.trim() || JSON.stringify(values()) !== saved) {
      result.textContent = '配置有未保存的修改，请先保存，再测试。';
      return;
    }
    if (inputs.some(input => input.disabled)) return;
    controller = new AbortController();
    result.textContent = '正在测试已保存的搜索配置…';
    try {
      const outcome = await workspace.testOpenaiSearch(scope, controller.signal);
      result.textContent = outcome.count > 0
        ? `搜索可用：${(outcome.ms / 1000).toFixed(2)}秒，返回${outcome.count}条网页来源；请求${outcome.requests}次。网页内容仍需读取核实。`
        : '接口有响应，但没有返回网页来源；请确认接口格式和模型支持联网搜索。';
    } finally { controller = null; }
  });
  const field = (label, input) => node('label', { className: 'ml-field' }, node('span', { textContent: label }), input);
  return node('details', { className: 'ml-copy ml-search-settings ml-openai-search' },
    node('summary', { textContent: `自定义联网搜索（OpenAI兼容） · ${where}` }),
    node('p', { className: 'ml-muted', textContent: '可搭配任意聊天模型。为搜索单独配置地址、密钥和模型，仅保存在当前选择的位置。' }),
    node('label', {}, enabled, '启用自定义联网搜索'),
    field('API 地址', baseURL), field('API Key', key), field('联网搜索模型 ID', model), field('接口格式', protocol), modelHelp,
    node('p', { className: 'ml-muted', textContent: 'API GET：官网列出的 WebSearch 是工具计费项，不是可填写的模型 ID。请从登录后的 WorkBuddy 配置或客服调用示例确认 model、tools 和接口路径；公开价格页不足以确认本面板可用，不要把 WebSearch 当型号填写。' }),
    node('p', { className: 'ml-muted', textContent: '按服务商说明选择接口格式。需要支持联网搜索并返回网页来源；普通聊天接口不会因此自动联网。Key 留空保存会保留原值，取消勾选即可停用。' }),
    node('p', { className: 'ml-muted', textContent: '保存后再测试。测试会调用一次该搜索接口，可能按服务商规则计费；不使用其他搜索服务代测。' }),
    save, test, action('停止搜索测试', async () => controller?.abort()), result
  );
}
