/**
 * 大模型服务商目录（浏览器与网关共用；网关据此决定允许代理哪些地址）。
 *
 * kind:
 *   anthropic  Anthropic Messages API（官方 SDK）
 *   openai     OpenAI 兼容的 /chat/completions 接口（绝大多数厂商都提供）
 *   mock       内置离线演示模型
 * models 只是常用型号的建议，界面里可以直接改成任何型号名（厂商会不断上新）。
 * browser: 浏览器能否直接调用（对方是否允许跨域）。不能直连的，在单文件版里会提示改用完整版网关。
 */
export const PROVIDERS = [
  { id: 'mock', name: '内置演示（离线）', kind: 'mock', baseURL: '', models: ['jarvis-demo'], needsKey: false, browser: true },
  { id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', baseURL: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'], keyUrl: 'https://console.anthropic.com/', browser: true, webSearch: true },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseURL: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'], keyUrl: 'https://platform.openai.com/api-keys', browser: true },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], keyUrl: 'https://aistudio.google.com/apikey', browser: true },
  { id: 'deepseek', name: 'DeepSeek 深度求索', kind: 'openai', baseURL: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], keyUrl: 'https://platform.deepseek.com/api_keys', browser: false },
  { id: 'qwen', name: '通义千问（阿里云百炼）', kind: 'openai', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'], keyUrl: 'https://bailian.console.aliyun.com/', browser: false },
  { id: 'moonshot', name: 'Kimi（月之暗面）', kind: 'openai', baseURL: 'https://api.moonshot.cn/v1', models: ['kimi-latest', 'moonshot-v1-32k'], keyUrl: 'https://platform.moonshot.cn/console/api-keys', browser: false },
  { id: 'zhipu', name: '智谱 GLM', kind: 'openai', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5', 'glm-4-flash'], keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', browser: false },
  { id: 'doubao', name: '豆包（火山方舟）', kind: 'openai', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-1-6-250615'], keyUrl: 'https://console.volcengine.com/ark', browser: false, note: '型号处可填写方舟控制台里的“推理接入点 ID”' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', kind: 'openai', baseURL: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'], keyUrl: 'https://cloud.siliconflow.cn/account/ak', browser: false },
  { id: 'openrouter', name: 'OpenRouter（聚合）', kind: 'openai', baseURL: 'https://openrouter.ai/api/v1', models: ['openai/gpt-5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'], keyUrl: 'https://openrouter.ai/keys', browser: true },
  { id: 'ollama', name: 'Ollama（本机模型）', kind: 'openai', baseURL: 'http://localhost:11434/v1', models: ['qwen2.5:7b', 'llama3.1:8b'], needsKey: false, browser: true, note: '浏览器直连需以 OLLAMA_ORIGINS=* 启动 Ollama；用完整版网关则不需要' },
  { id: 'custom', name: '自定义（OpenAI 兼容）', kind: 'openai', baseURL: '', models: [''], browser: true, custom: true }
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id);

/** 网关允许代理的上游地址（自定义地址默认不代理，避免网关被当成开放代理） */
export function upstreamFor(id) {
  const p = providerById(id);
  return p && p.kind !== 'mock' && !p.custom ? p.baseURL : null;
}

/** 网关可从环境变量注入的密钥（浏览器没填时使用） */
export const ENV_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY', moonshot: 'MOONSHOT_API_KEY', zhipu: 'ZHIPU_API_KEY', doubao: 'ARK_API_KEY',
  siliconflow: 'SILICONFLOW_API_KEY', openrouter: 'OPENROUTER_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY'
};
