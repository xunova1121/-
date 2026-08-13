/**
 * 第三方模型服务目录（声明式）。
 *
 * 这份目录同时喂给三处：联调台的服务商列表、请求模板下拉、Studio 流水线的选模型。
 * 加一家新服务商 = 在这里加一个对象，不用改 UI，也不用改路由。
 *
 * 端点和参数按各家公开文档整理，但各家改版很勤 —— 目录里的 templates 只是**起手式**，
 * 联调台里可以直接改 URL / Header / Body 再发，改完能存成自己的模板。
 * 这也正是"联调"两个字的意义：不指望预设永远对，指望的是改起来快。
 */

export const CAPABILITIES = {
  chat: '对话 / 剧本分析',
  vision: '图像理解（一致性校验用）',
  t2i: '文生图',
  i2i: '图生图 / 参考图生图',
  t2v: '文生视频',
  i2v: '图生视频',
  r2v: '参考图生视频',
  tts: '语音合成'
};

/**
 * OpenAI 兼容家族的工厂。
 *
 * 现在大半个中文大模型生态都对齐了 /v1/chat/completions 这套协议
 * （DeepSeek、智谱、月之暗面、硅基流动、火山方舟、各种中转 router 都是），
 * 所以这些只需要给个 baseUrl 和密钥名，剩下全复用。
 */
function openaiCompatible({
  id,
  name,
  baseUrl,
  secret,
  docs = '',
  models = [],
  optional = false,
  editableBaseUrl = true,
  capabilities = ['chat', 'vision'],
  hint = ''
}) {
  return {
    id,
    name,
    docs,
    baseUrl,
    family: 'openai',
    auth: { type: 'bearer', secret, optional },
    secrets: [{ name: secret, label: 'API Key', required: !optional, hint }],
    capabilities,
    editableBaseUrl,
    models,
    endpoints: {
      chat: '{{baseUrl}}/chat/completions',
      models: '{{baseUrl}}/models',
      images: '{{baseUrl}}/images/generations'
    },
    probe: { label: '连通性自检（列模型）', method: 'GET', url: '{{baseUrl}}/models' },
    templates: [
      {
        id: 'chat',
        label: '对话（流式）',
        capability: 'chat',
        method: 'POST',
        url: '{{baseUrl}}/chat/completions',
        stream: true,
        body: {
          model: models[0]?.id || 'gpt-4o-mini',
          stream: true,
          messages: [{ role: 'user', content: '用一句话介绍你自己' }]
        }
      },
      {
        id: 'vision',
        label: '图像理解（一致性校验同款请求）',
        capability: 'vision',
        method: 'POST',
        url: '{{baseUrl}}/chat/completions',
        body: {
          model: models.find((m) => m.capability === 'vision')?.id || models[0]?.id || 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '描述图中人物的发型、服装和配色' },
                { type: 'image_url', image_url: { url: 'https://example.com/ref.png' } }
              ]
            }
          ]
        }
      },
      {
        id: 'models',
        label: '列出可用模型',
        method: 'GET',
        url: '{{baseUrl}}/models'
      }
    ]
  };
}

export const PROVIDERS = [
  // ───────────────────────── OpenAI 标准接口 ─────────────────────────
  openaiCompatible({
    id: 'openai',
    name: 'OpenAI（标准接口）',
    docs: 'https://platform.openai.com/docs/api-reference',
    baseUrl: 'https://api.openai.com/v1',
    secret: 'OPENAI_API_KEY',
    capabilities: ['chat', 'vision', 't2i', 'i2i', 'tts'],
    hint: 'sk- 开头；用兼容网关时把 baseUrl 一并改掉',
    models: [
      { id: 'gpt-4o', capability: 'vision', label: 'GPT-4o（带视觉，做一致性复核）' },
      { id: 'gpt-4o-mini', capability: 'chat', label: 'GPT-4o mini（便宜，跑分镜够用）' },
      { id: 'gpt-4.1', capability: 'chat', label: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', capability: 'chat', label: 'GPT-4.1 mini' },
      { id: 'o4-mini', capability: 'chat', label: 'o4-mini（推理，拆复杂剧本）' },
      { id: 'gpt-image-1', capability: 't2i', label: 'GPT Image 1（文生图 / 图生图）' },
      { id: 'dall-e-3', capability: 't2i', label: 'DALL·E 3' },
      { id: 'gpt-4o-mini-tts', capability: 'tts', label: 'GPT-4o mini TTS（可指定语气）' },
      { id: 'tts-1-hd', capability: 'tts', label: 'TTS-1 HD（音质好）' },
      { id: 'tts-1', capability: 'tts', label: 'TTS-1（快）' }
    ]
  }),

  // ───────────────────────── 火山引擎方舟 ─────────────────────────
  {
    id: 'volcengine',
    name: '火山引擎 方舟 Ark（豆包 / Seedance / Seedream）',
    docs: 'https://www.volcengine.com/docs/82379',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    family: 'openai', // 对话侧完全兼容 OpenAI 协议
    auth: { type: 'bearer', secret: 'ARK_API_KEY' },
    secrets: [
      {
        name: 'ARK_API_KEY',
        label: 'API Key',
        required: true,
        hint:
          '方舟控制台 → API Key。⚠ 光有 Key 还不够：方舟的 model 字段必须填**你自己账号里**的推理接入点 ID' +
          '（ep- 开头，在「在线推理」页创建）或带版本号的完整模型名。像 doubao-pro-32k 这种短名早已下线，' +
          '填了会返回 404「模型不存在」。改的地方在「设置 → 能力路由」，选「自定义（手动填写）」。'
      }
    ],
    capabilities: ['chat', 'vision', 't2i', 'i2i', 't2v', 'i2v', 'r2v'],
    editableBaseUrl: true,
    endpoints: {
      chat: '{{baseUrl}}/chat/completions',
      images: '{{baseUrl}}/images/generations',
      videoTasks: '{{baseUrl}}/contents/generations/tasks'
    },
    // 方舟的视频是"提交任务 → 轮询"，任务详情走同一路径 + /{id}
    taskPoll: {
      url: '{{baseUrl}}/contents/generations/tasks/{taskId}',
      method: 'GET',
      idPath: 'id',
      statusPath: 'status',
      successStates: ['succeeded'],
      failureStates: ['failed', 'canceled']
    },
    /**
     * 待探测的候选模型 ID。
     *
     * 方舟支持直接填公开模型 ID（不必建 ep- 推理接入点），但前提是该模型
     * 在你账号下已开通；ID 还带版本日期后缀，随发布不断变化。
     * 这份清单是**候选**不是断言 —— 「设置 → 拉取可用模型」拿不到列表时，
     * 会用极小请求（max_tokens=1）把它们逐个点一遍，告诉你哪些真能用。
     * 只探对话类：出图/视频每探一次都要真出图，那是真金白银，交给体检去验。
     */
    candidates: [
      'doubao-seed-1-6-250615',
      'doubao-seed-1-6-flash-250615',
      'doubao-seed-1-6-thinking-250615',
      'doubao-1-5-pro-32k-250115',
      'doubao-1-5-pro-256k-250115',
      'doubao-1-5-lite-32k-250115',
      'doubao-1-5-vision-pro-32k-250115',
      'doubao-1-5-thinking-pro-250415',
      'doubao-pro-32k-241215',
      'doubao-pro-4k-240515',
      'doubao-lite-32k-240828',
      'deepseek-v3-241226',
      'deepseek-r1-250120',
      'kimi-k2-250711'
    ],
    // 展示用的默认清单；以探测结果 / 你控制台里看到的为准
    models: [
      { id: 'doubao-seed-1-6-250615', capability: 'vision', label: '豆包 Seed 1.6（多模态，一致性复核主力）' },
      { id: 'doubao-1-5-pro-32k-250115', capability: 'chat', label: '豆包 1.5 Pro 32K（剧本分析）' },
      { id: 'doubao-1-5-lite-32k-250115', capability: 'chat', label: '豆包 1.5 Lite 32K（便宜）' },
      { id: 'doubao-seed-1-6-flash-250615', capability: 'chat', label: '豆包 Seed 1.6 Flash（最快）' },
      { id: 'doubao-1-5-vision-pro-32k-250115', capability: 'vision', label: '豆包 1.5 Vision Pro' },
      { id: 'deepseek-v3-241226', capability: 'chat', label: 'DeepSeek V3（方舟托管）' },
      { id: 'deepseek-r1-250120', capability: 'chat', label: 'DeepSeek R1（方舟托管，推理强）' },
      { id: 'kimi-k2-250711', capability: 'chat', label: 'Kimi K2（方舟托管）' },
      { id: 'doubao-seedream-4-0-250828', capability: 't2i', label: 'Seedream 4.0 文生图（最新）' },
      { id: 'doubao-seedream-3-0-t2i-250415', capability: 't2i', label: 'Seedream 3.0 文生图' },
      { id: 'doubao-seededit-3-0-i2i-250628', capability: 'i2i', label: 'SeedEdit 3.0 图生图（保角色用这个）' },
      { id: 'doubao-seedance-1-0-pro-250528', capability: 'i2v', label: 'Seedance 1.0 Pro 图生视频', durations: [5, 10] },
      { id: 'doubao-seedance-1-0-lite-i2v-250428', capability: 'i2v', label: 'Seedance 1.0 Lite 图生视频', durations: [5, 10] },
      { id: 'doubao-seedance-1-0-lite-t2v-250428', capability: 't2v', label: 'Seedance 1.0 Lite 文生视频', durations: [5, 10] }
    ],
    probe: {
      label: '连通性自检（一次最小对话）',
      method: 'POST',
      url: '{{baseUrl}}/chat/completions',
      body: {
        model: 'doubao-1-5-pro-32k-250115',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4
      }
    },
    templates: [
      {
        id: 'chat',
        label: '对话（OpenAI 兼容 / 流式）',
        capability: 'chat',
        method: 'POST',
        url: '{{baseUrl}}/chat/completions',
        stream: true,
        body: {
          model: 'doubao-1-5-pro-32k-250115',
          stream: true,
          messages: [{ role: 'user', content: '把这段话拆成三个分镜：执法艇在太湖上巡航' }]
        }
      },
      {
        id: 't2i',
        label: '文生图 Seedream',
        capability: 't2i',
        method: 'POST',
        url: '{{baseUrl}}/images/generations',
        body: {
          model: 'doubao-seedream-3-0-t2i-250415',
          prompt: '国风水墨，太湖清晨，执法艇破雾而行',
          size: '1280x720',
          response_format: 'url',
          seed: 20260813
        }
      },
      {
        id: 'i2i',
        label: '图生图 SeedEdit（保角色一致性）',
        capability: 'i2i',
        method: 'POST',
        url: '{{baseUrl}}/images/generations',
        body: {
          model: 'doubao-seededit-3-0-i2i-250628',
          prompt: '保持人物外貌不变，换成侧身回望的姿态，背景改为码头',
          image: 'https://example.com/character-sheet.png',
          size: '1280x720',
          response_format: 'url'
        }
      },
      {
        id: 'i2v',
        label: '图生视频 Seedance（异步任务）',
        capability: 'i2v',
        method: 'POST',
        url: '{{baseUrl}}/contents/generations/tasks',
        async: true,
        body: {
          model: 'doubao-seedance-1-0-pro-250528',
          content: [
            { type: 'text', text: '镜头缓慢推进，水面波光流动 --resolution 720p --dur 5' },
            { type: 'image_url', image_url: { url: 'https://example.com/first-frame.png' } }
          ]
        }
      },
      {
        id: 'task',
        label: '查视频任务状态',
        method: 'GET',
        url: '{{baseUrl}}/contents/generations/tasks/PUT_TASK_ID_HERE'
      }
    ]
  },

  // ───────────────────────── FloatAI Router ─────────────────────────
  openaiCompatible({
    id: 'floatai',
    name: 'FloatAI Router（聚合中转）',
    docs: 'https://router.floatai.cn/dashboard',
    // 中转类网关基本都是 OneAPI/NewAPI 那套，入口在 /v1。
    // 若你的面板给的不是这个，在「服务商设置」里改一行即可，改完立刻生效。
    baseUrl: 'https://router.floatai.cn/v1',
    secret: 'FLOATAI_API_KEY',
    capabilities: ['chat', 'vision', 't2i', 'i2i', 'tts'],
    hint: '控制台 → 令牌，sk- 开头。中转网关能用哪些模型完全看你这张卡，务必先点「拉取可用模型」',
    models: [
      { id: 'gpt-4o', capability: 'vision', label: 'GPT-4o（转发）' },
      { id: 'gpt-4.1', capability: 'chat', label: 'GPT-4.1（转发）' },
      { id: 'claude-sonnet-4', capability: 'chat', label: 'Claude Sonnet 4（转发）' },
      { id: 'claude-opus-4', capability: 'chat', label: 'Claude Opus 4（转发）' },
      { id: 'gemini-2.5-pro', capability: 'vision', label: 'Gemini 2.5 Pro（转发）' },
      { id: 'gemini-2.5-flash', capability: 'vision', label: 'Gemini 2.5 Flash（转发）' },
      { id: 'deepseek-v3', capability: 'chat', label: 'DeepSeek V3（转发）' },
      { id: 'deepseek-r1', capability: 'chat', label: 'DeepSeek R1（转发）' },
      { id: 'qwen-max', capability: 'chat', label: 'Qwen Max（转发）' },
      { id: 'gpt-image-1', capability: 't2i', label: 'GPT Image 1（转发）' },
      { id: 'dall-e-3', capability: 't2i', label: 'DALL·E 3（转发）' },
      { id: 'flux-1.1-pro', capability: 't2i', label: 'FLUX 1.1 Pro（转发）' },
      { id: 'tts-1-hd', capability: 'tts', label: 'TTS-1 HD（转发）' }
    ]
  }),

  // ───────────────────────── 阿里云百炼 ─────────────────────────
  {
    id: 'dashscope',
    name: '阿里云百炼 DashScope（通义万相 / Qwen）',
    docs: 'https://help.aliyun.com/zh/model-studio/',
    baseUrl: 'https://dashscope.aliyuncs.com',
    family: 'dashscope',
    auth: { type: 'bearer', secret: 'DASHSCOPE_API_KEY' },
    secrets: [
      { name: 'DASHSCOPE_API_KEY', label: 'API Key', required: true, hint: '百炼控制台 → API-KEY，sk- 开头' }
    ],
    capabilities: ['chat', 'vision', 't2i', 'i2i', 't2v', 'i2v', 'r2v', 'tts'],
    endpoints: {
      chat: '{{baseUrl}}/compatible-mode/v1/chat/completions',
      t2i: '{{baseUrl}}/api/v1/services/aigc/text2image/image-synthesis',
      i2v: '{{baseUrl}}/api/v1/services/aigc/video-generation/video-synthesis',
      tts: '{{baseUrl}}/api/v1/services/aigc/multimodal-generation/generation'
    },
    taskPoll: {
      url: '{{baseUrl}}/api/v1/tasks/{taskId}',
      method: 'GET',
      idPath: 'output.task_id',
      statusPath: 'output.task_status',
      successStates: ['SUCCEEDED'],
      failureStates: ['FAILED', 'CANCELED', 'UNKNOWN']
    },
    models: [
      { id: 'qwen-max', capability: 'chat', label: 'Qwen Max（剧本分析质量最好）' },
      { id: 'qwen-plus', capability: 'chat', label: 'Qwen Plus（性价比高）' },
      { id: 'qwen-turbo', capability: 'chat', label: 'Qwen Turbo（最快最便宜）' },
      { id: 'qwen-long', capability: 'chat', label: 'Qwen Long（长篇小说改编用这个）' },
      { id: 'qwen-vl-max', capability: 'vision', label: 'Qwen-VL Max（一致性复核）' },
      { id: 'qwen-vl-plus', capability: 'vision', label: 'Qwen-VL Plus（便宜些）' },
      { id: 'wan2.2-t2i-plus', capability: 't2i', label: '通义万相 2.2 文生图 Plus' },
      { id: 'wan2.2-t2i-flash', capability: 't2i', label: '通义万相 2.2 文生图 Flash' },
      { id: 'wanx2.1-t2i-turbo', capability: 't2i', label: '通义万相 2.1 文生图 Turbo' },
      { id: 'wanx2.1-t2i-plus', capability: 't2i', label: '通义万相 2.1 文生图 Plus' },
      { id: 'wanx-v1', capability: 't2i', label: '通义万相 v1（老版，便宜）' },
      { id: 'wanx2.1-imageedit', capability: 'i2i', label: '通义万相 图像编辑（保角色）' },
      { id: 'wan2.2-i2v-flash', capability: 'i2v', label: '通义万相 2.2 图生视频 Flash', durations: [5] },
      { id: 'wan2.2-i2v-plus', capability: 'i2v', label: '通义万相 2.2 图生视频 Plus', durations: [5] },
      { id: 'wanx2.1-i2v-turbo', capability: 'i2v', label: '通义万相 2.1 图生视频 Turbo', durations: [3, 4, 5] },
      { id: 'wanx2.1-i2v-plus', capability: 'i2v', label: '通义万相 2.1 图生视频 Plus', durations: [3, 4, 5] },
      { id: 'wanx2.1-t2v-turbo', capability: 't2v', label: '通义万相 文生视频 Turbo', durations: [3, 4, 5] },
      { id: 'qwen3-tts-flash', capability: 'tts', label: 'Qwen3-TTS Flash（快）' },
      { id: 'qwen-tts', capability: 'tts', label: 'Qwen-TTS' },
      { id: 'cosyvoice-v2', capability: 'tts', label: 'CosyVoice v2（音色最多）' },
      { id: 'cosyvoice-v1', capability: 'tts', label: 'CosyVoice v1' },
      { id: 'sambert-zhichu-v1', capability: 'tts', label: 'Sambert 知厨（旁白感）' }
    ],
    probe: {
      label: '连通性自检（一次最小对话）',
      method: 'POST',
      url: '{{baseUrl}}/compatible-mode/v1/chat/completions',
      body: { model: 'qwen-turbo', messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }
    },
    templates: [
      {
        id: 'chat',
        label: '对话（OpenAI 兼容 / 流式）',
        capability: 'chat',
        method: 'POST',
        url: '{{baseUrl}}/compatible-mode/v1/chat/completions',
        stream: true,
        body: {
          model: 'qwen-plus',
          stream: true,
          messages: [{ role: 'user', content: '把这段话拆成三个分镜：执法艇在太湖上巡航' }]
        }
      },
      {
        id: 't2i',
        label: '文生图（异步任务）',
        capability: 't2i',
        method: 'POST',
        url: '{{baseUrl}}/api/v1/services/aigc/text2image/image-synthesis',
        headers: { 'X-DashScope-Async': 'enable' },
        async: true,
        body: {
          model: 'wan2.2-t2i-plus',
          input: { prompt: '国风水墨，太湖清晨，执法艇破雾而行，电影感构图' },
          parameters: { size: '1280*720', n: 1, seed: 20260813 }
        }
      },
      {
        id: 'i2v',
        label: '图生视频（异步任务）',
        capability: 'i2v',
        method: 'POST',
        url: '{{baseUrl}}/api/v1/services/aigc/video-generation/video-synthesis',
        headers: { 'X-DashScope-Async': 'enable' },
        async: true,
        body: {
          model: 'wanx2.1-i2v-turbo',
          input: { prompt: '镜头缓慢推进，水面泛起波光', img_url: 'https://example.com/first-frame.jpg' },
          parameters: { resolution: '720P', duration: 5 }
        }
      },
      {
        id: 'tts',
        label: '语音合成',
        capability: 'tts',
        method: 'POST',
        url: '{{baseUrl}}/api/v1/services/aigc/multimodal-generation/generation',
        body: {
          model: 'qwen3-tts-flash',
          input: { text: '执法闭环完成，本次处置共耗时四十二秒。', voice: 'Cherry' }
        }
      },
      { id: 'task', label: '查异步任务状态', method: 'GET', url: '{{baseUrl}}/api/v1/tasks/PUT_TASK_ID_HERE' }
    ]
  },

  // ───────────────────────── 其余 OpenAI 兼容家族 ─────────────────────────
  openaiCompatible({
    id: 'deepseek',
    name: 'DeepSeek',
    docs: 'https://api-docs.deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    secret: 'DEEPSEEK_API_KEY',
    capabilities: ['chat'],
    models: [
      { id: 'deepseek-chat', capability: 'chat', label: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', capability: 'chat', label: 'DeepSeek Reasoner（拆剧本更稳）' }
    ]
  }),
  openaiCompatible({
    id: 'zhipu',
    name: '智谱 GLM',
    docs: 'https://open.bigmodel.cn/dev/api',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    secret: 'ZHIPU_API_KEY',
    capabilities: ['chat', 'vision', 't2i'],
    models: [
      { id: 'glm-4-plus', capability: 'chat', label: 'GLM-4 Plus' },
      { id: 'glm-4-flash', capability: 'chat', label: 'GLM-4 Flash（免费额度多）' },
      { id: 'glm-4-long', capability: 'chat', label: 'GLM-4 Long（长篇改编）' },
      { id: 'glm-4v-plus', capability: 'vision', label: 'GLM-4V Plus（一致性复核）' },
      { id: 'cogview-4', capability: 't2i', label: 'CogView-4 文生图' },
      { id: 'cogview-3-flash', capability: 't2i', label: 'CogView-3 Flash（免费）' }
    ]
  }),
  openaiCompatible({
    id: 'moonshot',
    name: '月之暗面 Kimi',
    docs: 'https://platform.moonshot.cn/docs',
    baseUrl: 'https://api.moonshot.cn/v1',
    secret: 'MOONSHOT_API_KEY',
    capabilities: ['chat', 'vision'],
    models: [{ id: 'moonshot-v1-128k', capability: 'chat', label: 'Kimi 128K（长篇小说改编）' }]
  }),
  openaiCompatible({
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    docs: 'https://docs.siliconflow.cn',
    baseUrl: 'https://api.siliconflow.cn/v1',
    secret: 'SILICONFLOW_API_KEY',
    capabilities: ['chat', 'vision', 't2i', 'tts'],
    models: [
      { id: 'Qwen/Qwen2.5-72B-Instruct', capability: 'chat', label: 'Qwen2.5 72B' },
      { id: 'deepseek-ai/DeepSeek-V3', capability: 'chat', label: 'DeepSeek V3' },
      { id: 'deepseek-ai/DeepSeek-R1', capability: 'chat', label: 'DeepSeek R1' },
      { id: 'Qwen/Qwen2.5-VL-72B-Instruct', capability: 'vision', label: 'Qwen2.5-VL 72B（一致性复核）' },
      { id: 'Kwai-Kolors/Kolors', capability: 't2i', label: 'Kolors 文生图（中文提示词友好）' },
      { id: 'black-forest-labs/FLUX.1-dev', capability: 't2i', label: 'FLUX.1 dev' },
      { id: 'black-forest-labs/FLUX.1-schnell', capability: 't2i', label: 'FLUX.1 schnell（快）' },
      { id: 'stabilityai/stable-diffusion-3-5-large', capability: 't2i', label: 'SD 3.5 Large' },
      { id: 'FunAudioLLM/CosyVoice2-0.5B', capability: 'tts', label: 'CosyVoice2（配音）' },
      { id: 'fishaudio/fish-speech-1.5', capability: 'tts', label: 'Fish Speech 1.5' }
    ]
  }),
  openaiCompatible({
    id: 'ollama',
    name: '本地模型（Ollama / LM Studio）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    secret: 'LOCAL_API_KEY',
    optional: true,
    capabilities: ['chat', 'vision'],
    hint: '本地服务通常不校验密钥，留空即可',
    models: [{ id: 'qwen2.5:7b', capability: 'chat', label: 'Qwen2.5 7B（本地）' }]
  }),

  // ───────────────────────── MiniMax 海螺 ─────────────────────────
  {
    id: 'minimax',
    name: 'MiniMax 海螺（Hailuo 视频 / image-01）',
    docs: 'https://platform.minimaxi.com/document',
    // 国内站历史上是 api.minimax.chat，改版后是 api.minimaxi.com。
    // 两个都可能可用，连不上就在这里换一个 —— 改完先点自检。
    baseUrl: 'https://api.minimaxi.com/v1',
    family: 'minimax',
    auth: { type: 'bearer', secret: 'MINIMAX_API_KEY' },
    secrets: [
      { name: 'MINIMAX_API_KEY', label: 'API Key', required: true, hint: '控制台 → 账户管理 → 接口密钥' },
      {
        name: 'MINIMAX_GROUP_ID',
        label: 'Group ID（可选）',
        required: false,
        hint: '部分接口（如语音）要求带 GroupId 查询参数，视频和出图一般不需要'
      }
    ],
    capabilities: ['chat', 'vision', 't2i', 'i2v', 't2v', 'r2v'],
    editableBaseUrl: true,
    endpoints: {
      chat: '{{baseUrl}}/text/chatcompletion_v2',
      images: '{{baseUrl}}/image_generation',
      videoCreate: '{{baseUrl}}/video_generation',
      videoQuery: '{{baseUrl}}/query/video_generation',
      fileRetrieve: '{{baseUrl}}/files/retrieve'
    },
    /**
     * 海螺的视频是**三步**：
     *   ① POST /video_generation            → task_id
     *   ② GET  /query/video_generation      → status，成功后给 file_id（新版也可能直接给 url）
     *   ③ GET  /files/retrieve?file_id=…    → download_url
     * 比别家多一步，所以不走通用的 taskPoll，在 adapters 里单独实现。
     * 下载地址只活 9 小时，务必落盘 —— 这一点应用本来就在做。
     */
    videoFlow: { steps: 3, urlTtlHours: 9 },
    models: [
      // H3 是全模态：一次能收最多 9 张图 + 3 段视频 + 3 段音频，出 2K、原生立体声、最长 15 秒。
      // 请求结构和 Hailuo 系不同（content[] 多模态数组），适配器按模型名分流。
      { id: 'MiniMax-H3', capability: 'r2v', label: 'H3 全模态（9 张参考图，2K，最长 15 秒）', durations: [6, 10, 15], multimodal: true },
      { id: 'MiniMax-Hailuo-2.3', capability: 'i2v', label: '海螺 2.3 图生视频（最新）', durations: [6, 10] },
      { id: 'MiniMax-Hailuo-02', capability: 'i2v', label: '海螺 02 图生视频', durations: [6, 10] },
      { id: 'I2V-01-Director', capability: 'i2v', label: 'I2V-01 Director（可写运镜指令）', durations: [6] },
      { id: 'I2V-01-live', capability: 'i2v', label: 'I2V-01 live（二次元更好）', durations: [6] },
      { id: 'I2V-01', capability: 'i2v', label: 'I2V-01', durations: [6] },
      { id: 'T2V-01-Director', capability: 't2v', label: 'T2V-01 Director 文生视频', durations: [6] },
      { id: 'T2V-01', capability: 't2v', label: 'T2V-01 文生视频', durations: [6] },
      { id: 'S2V-01', capability: 'i2v', label: 'S2V-01（主体参考，锁人设强）', durations: [6] },
      { id: 'image-01', capability: 't2i', label: 'image-01 文生图' },
      { id: 'MiniMax-Text-01', capability: 'chat', label: 'MiniMax Text-01（长上下文）' },
      { id: 'abab6.5s-chat', capability: 'chat', label: 'abab6.5s（便宜）' }
    ],
    probe: {
      label: '连通性自检（一次最小对话）',
      method: 'POST',
      url: '{{baseUrl}}/text/chatcompletion_v2',
      body: {
        model: 'MiniMax-Text-01',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4
      }
    },
    templates: [
      {
        id: 'chat',
        label: '对话',
        capability: 'chat',
        method: 'POST',
        url: '{{baseUrl}}/text/chatcompletion_v2',
        stream: true,
        body: {
          model: 'MiniMax-Text-01',
          stream: true,
          messages: [{ role: 'user', content: '把这段话拆成三个分镜：执法艇在太湖上巡航' }]
        }
      },
      {
        id: 't2i',
        label: '文生图 image-01',
        capability: 't2i',
        method: 'POST',
        url: '{{baseUrl}}/image_generation',
        body: {
          model: 'image-01',
          prompt: '国风水墨，太湖清晨，执法艇破雾而行',
          aspect_ratio: '16:9',
          n: 1,
          response_format: 'url'
        }
      },
      {
        id: 'i2v',
        label: '图生视频（第①步：提交任务）',
        capability: 'i2v',
        method: 'POST',
        url: '{{baseUrl}}/video_generation',
        body: {
          model: 'MiniMax-Hailuo-02',
          prompt: '镜头缓慢推进，水面波光流动',
          first_frame_image: 'https://example.com/first-frame.png',
          duration: 6,
          resolution: '1080P'
        }
      },
      {
        id: 'h3',
        label: 'H3 全模态生视频（第①步，可带多张参考图）',
        capability: 'r2v',
        method: 'POST',
        url: '{{baseUrl}}/video_generation',
        body: {
          model: 'MiniMax-H3',
          content: [
            { type: 'text', text: '镜头缓慢推进，人物走向栈桥尽头' },
            { type: 'image_url', image_url: { url: 'https://example.com/character-sheet.png' } },
            { type: 'image_url', image_url: { url: 'https://example.com/scene-plate.png' } }
          ],
          duration: 6,
          resolution: '1080P'
        }
      },
      {
        id: 'video-query',
        label: '图生视频（第②步：查任务）',
        method: 'GET',
        url: '{{baseUrl}}/query/video_generation?task_id=PUT_TASK_ID_HERE'
      },
      {
        id: 'file-retrieve',
        label: '图生视频（第③步：取下载地址）',
        method: 'GET',
        url: '{{baseUrl}}/files/retrieve?file_id=PUT_FILE_ID_HERE'
      }
    ]
  },

  // ───────────────────────── 秘塔 MiniMax H3 中转 ─────────────────────────
  {
    id: 'metaso',
    name: '秘塔 metaso（MiniMax H3 中转）',
    docs: 'https://metaso.cn/minimax-h3',
    // 注意是 /api/minimax/v2 —— v2 而不是官方的 v1，路径也不同
    baseUrl: 'https://metaso.cn/api/minimax/v2',
    family: 'minimax',
    auth: { type: 'bearer', secret: 'METASO_API_KEY' },
    secrets: [
      { name: 'METASO_API_KEY', label: 'API Key', required: true, hint: '控制台里 mk- 开头的那串' }
    ],
    capabilities: ['t2v', 'i2v', 'r2v'],
    editableBaseUrl: true,
    endpoints: {
      videoCreate: '{{baseUrl}}/video_generation'
      // 查任务和取文件的路径官方示例里没给。适配器会依次试几个常见写法，
      // 试通哪个就用哪个，并把结果打进日志 —— 见 adapters.js 的 resolveQueryUrl。
    },
    /**
     * 请求体和 MiniMax 官方 H3 大体一致（content[] 多模态），但多两个字段：
     *   ratio       "16:9" 这类宽高比
     *   resolution  官方示例用 "2K"
     * 时长档位按示例是 5 秒起，和官方 H3 的 6 秒不一样 —— 别照搬。
     */
    videoDefaults: { resolution: '2K', ratio: true },
    models: [
      {
        id: 'MiniMax-H3',
        capability: 'r2v',
        label: 'MiniMax H3（2K，全模态，最多 9 张参考图）',
        durations: [5, 10, 15],
        multimodal: true
      }
    ],
    // 这家只做视频，没有对话接口可探。自检直接提交一个最小任务代价太高，
    // 所以走「能不能通过鉴权」这一层：路径对了但参数不全会回 4xx 而不是 401。
    probe: {
      label: '连通性自检（提交一个缺参数的请求，看鉴权是否通过）',
      method: 'POST',
      url: '{{baseUrl}}/video_generation',
      body: { model: 'MiniMax-H3' }
    },
    templates: [
      {
        id: 't2va',
        label: '文生视频 t2va（官方示例同款）',
        capability: 't2v',
        method: 'POST',
        url: '{{baseUrl}}/video_generation',
        body: {
          model: 'MiniMax-H3',
          content: [
            {
              type: 'text',
              text: '史诗级太空歌剧院线预告：女舰长独自站在巨大观景窗前，最后一支舰队正在集结并跃迁离去，强光爆闪、舰桥震动，她被留在原地。'
            }
          ],
          resolution: '2K',
          duration: 5,
          ratio: '16:9'
        }
      },
      {
        id: 'i2v',
        label: '图生视频（带参考图）',
        capability: 'i2v',
        method: 'POST',
        url: '{{baseUrl}}/video_generation',
        body: {
          model: 'MiniMax-H3',
          content: [
            { type: 'text', text: '镜头缓慢推进，人物走向栈桥尽头' },
            { type: 'image_url', image_url: { url: 'https://example.com/first-frame.png' } },
            { type: 'image_url', image_url: { url: 'https://example.com/character-sheet.png' } }
          ],
          resolution: '2K',
          duration: 5,
          ratio: '16:9'
        }
      },
      {
        id: 'query',
        label: '查任务状态（路径待确认，先在这里试）',
        method: 'GET',
        url: '{{baseUrl}}/query/video_generation?task_id=PUT_TASK_ID_HERE'
      }
    ]
  },

  // ───────────────────────── 视频专线 ─────────────────────────
  {
    id: 'kling',
    name: '可灵 Kling（原生）',
    docs: 'https://app.klingai.com/cn/dev/document-api',
    baseUrl: 'https://api-beijing.klingai.com',
    family: 'kling',
    // 可灵不收静态密钥：要用 AK/SK 现签一个 HS256 的 JWT，30 分钟过期
    auth: { type: 'kling-jwt', secret: 'KLING_ACCESS_KEY', secret2: 'KLING_SECRET_KEY' },
    secrets: [
      { name: 'KLING_ACCESS_KEY', label: 'Access Key', required: true },
      { name: 'KLING_SECRET_KEY', label: 'Secret Key', required: true, hint: '仅用于本地签发 JWT，不会外发' }
    ],
    capabilities: ['t2v', 'i2v', 'r2v'],
    endpoints: { i2v: '{{baseUrl}}/v1/videos/image2video' },
    taskPoll: {
      url: '{{baseUrl}}/v1/videos/image2video/{taskId}',
      method: 'GET',
      idPath: 'data.task_id',
      statusPath: 'data.task_status',
      successStates: ['succeed'],
      failureStates: ['failed']
    },
    models: [
      { id: 'kling-v2-1-master', capability: 'i2v', label: 'Kling 2.1 Master（质量最好）', durations: [5, 10] },
      { id: 'kling-v2-master', capability: 'i2v', label: 'Kling 2.0 Master', durations: [5, 10] },
      { id: 'kling-v1-6', capability: 'i2v', label: 'Kling 1.6（便宜）', durations: [5, 10] },
      { id: 'kling-v1-5', capability: 'i2v', label: 'Kling 1.5', durations: [5, 10] },
      { id: 'kling-v1', capability: 't2v', label: 'Kling 1.0 文生视频', durations: [5, 10] }
    ],
    probe: {
      label: '连通性自检（查任务列表）',
      method: 'GET',
      url: '{{baseUrl}}/v1/videos/image2video?pageNum=1&pageSize=1'
    },
    templates: [
      {
        id: 'i2v',
        label: '图生视频',
        capability: 'i2v',
        method: 'POST',
        url: '{{baseUrl}}/v1/videos/image2video',
        async: true,
        body: {
          model_name: 'kling-v2-master',
          image: 'https://example.com/first-frame.jpg',
          prompt: '镜头缓推，水面波光粼粼',
          duration: '5',
          mode: 'std'
        }
      }
    ]
  },
  {
    id: 'vidu',
    name: 'Vidu（原生，参考图生视频强）',
    docs: 'https://platform.vidu.cn/docs',
    baseUrl: 'https://api.vidu.cn/ent/v2',
    family: 'vidu',
    auth: { type: 'token', secret: 'VIDU_API_KEY' }, // Authorization: Token xxx，写成 Bearer 会 401
    secrets: [{ name: 'VIDU_API_KEY', label: 'API Key', required: true }],
    capabilities: ['i2v', 'r2v'],
    endpoints: { i2v: '{{baseUrl}}/img2video', r2v: '{{baseUrl}}/reference2video' },
    taskPoll: {
      url: '{{baseUrl}}/tasks/{taskId}/creations',
      method: 'GET',
      idPath: 'task_id',
      statusPath: 'state',
      successStates: ['success'],
      failureStates: ['failed']
    },
    models: [
      { id: 'viduq1', capability: 'r2v', label: 'Vidu Q1（支持多张参考图锁人设）', durations: [4, 8] },
      { id: 'viduq1-classic', capability: 'i2v', label: 'Vidu Q1 Classic', durations: [4, 8] },
      { id: 'vidu2.0', capability: 'r2v', label: 'Vidu 2.0', durations: [4, 8] },
      { id: 'vidu1.5', capability: 'r2v', label: 'Vidu 1.5（便宜）', durations: [4, 8] }
    ],
    probe: { label: '连通性自检', method: 'GET', url: '{{baseUrl}}/tasks?limit=1' },
    templates: [
      {
        id: 'r2v',
        label: '参考图生视频（一致性最好）',
        capability: 'r2v',
        method: 'POST',
        url: '{{baseUrl}}/reference2video',
        async: true,
        body: {
          model: 'viduq1',
          images: ['https://example.com/character.png', 'https://example.com/scene.png'],
          prompt: '角色走进画面，镜头缓推',
          duration: 4,
          aspect_ratio: '16:9'
        }
      },
      {
        id: 'i2v',
        label: '图生视频',
        capability: 'i2v',
        method: 'POST',
        url: '{{baseUrl}}/img2video',
        async: true,
        body: { model: 'viduq1', images: ['https://example.com/first-frame.jpg'], prompt: '镜头缓推', duration: 4 }
      }
    ]
  },

  // ───────────────────────── 兜底 ─────────────────────────
  {
    id: 'raw',
    name: '空白请求（任意 HTTP）',
    docs: '',
    baseUrl: '',
    family: 'raw',
    auth: { type: 'none' },
    secrets: [],
    capabilities: [],
    editableBaseUrl: true,
    models: [],
    templates: [{ id: 'blank', label: '空白 GET', method: 'GET', url: 'https://httpbin.org/get' }]
  }
];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/** 按能力筛服务商，"选模型"下拉用 */
export function providersWith(capability) {
  return PROVIDERS.filter((p) => (p.capabilities || []).includes(capability));
}

/** 前端要的精简版：不含任何密钥，只有结构 */
export function publicCatalog(overrides = {}) {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    docs: p.docs,
    family: p.family || 'custom',
    baseUrl: overrides[p.id]?.baseUrl || p.baseUrl,
    editableBaseUrl: Boolean(p.editableBaseUrl),
    auth: { type: p.auth.type, optional: Boolean(p.auth.optional) },
    secrets: p.secrets,
    capabilities: p.capabilities,
    models: p.models,
    probe: p.probe || null,
    templates: p.templates || [],
    taskPoll: p.taskPoll || null
  }));
}
