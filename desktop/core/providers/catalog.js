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
  tts: '语音合成',
  /**
   * 音效 ≠ 语音合成。
   *
   * 两者是完全不同的模型：TTS 要的是"把这段字念出来"，音效要的是
   * "生成一段敲门声"。拿 TTS 去做音效，结果是一个人**朗读"敲门声"这三个字** ——
   * 这个坑在分镜那一层已经踩过一次了（音效写进台词字段，配音时被念出来），
   * 所以这里从一开始就分成两种能力，不共用路由。
   */
  sfx: '音效生成'
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
  hint = '',
  // 剩下的原样并进去：像 OpenAI 的视频接口那样"兼容家族但多一套东西"的情况，
  // 不必为它单独抄一份完整定义。（早期版本这里会把多给的字段悄悄丢掉。）
  ...extra
}) {
  return {
    ...extra,
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
    capabilities: ['chat', 'vision', 't2i', 'i2i', 't2v', 'i2v', 'tts'],
    // 音色是候选不是断言，界面上可以手填（见 dashscope 那份注释）
    voices: [
      { id: 'alloy', label: 'alloy（中性）' },
      { id: 'echo', label: 'echo（男·沉）' },
      { id: 'fable', label: 'fable（男·叙述感）' },
      { id: 'onyx', label: 'onyx（男·厚重）' },
      { id: 'nova', label: 'nova（女·明亮）' },
      { id: 'shimmer', label: 'shimmer（女·柔）' }
    ],
    hint: 'sk- 开头；用兼容网关时把 baseUrl 一并改掉',
    models: [
      { id: 'gpt-4o', capability: 'vision', label: 'GPT-4o（带视觉，做一致性复核）' },
      { id: 'gpt-4o-mini', capability: 'chat', label: 'GPT-4o mini（便宜，跑分镜够用）' },
      { id: 'gpt-4.1', capability: 'chat', label: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', capability: 'chat', label: 'GPT-4.1 mini' },
      { id: 'o4-mini', capability: 'chat', label: 'o4-mini（推理，拆复杂剧本）' },
      {
        id: 'gpt-image-1',
        capability: 't2i',
        label: 'GPT Image 1（文生图 / 图生图）',
        // 官方只收这三个，给别的直接 400。与其让整步失败，不如按方向挑一个最接近的
        imageSizes: { enum: ['1024x1024', '1536x1024', '1024x1536'] }
      },
      { id: 'dall-e-3', capability: 't2i', label: 'DALL·E 3' },
      { id: 'gpt-4o-mini-tts', capability: 'tts', label: 'GPT-4o mini TTS（可指定语气）' },
      { id: 'tts-1-hd', capability: 'tts', label: 'TTS-1 HD（音质好）' },
      { id: 'tts-1', capability: 'tts', label: 'TTS-1（快）' },
      // Sora：OpenAI 的视频接口。时长只收 4/8/12 秒这三档
      { id: 'sora-2', capability: 'i2v', label: 'Sora 2（视频，4/8/12 秒）', durations: [4, 8, 12] },
      { id: 'sora-2-pro', capability: 'i2v', label: 'Sora 2 Pro（质量更高，更贵）', durations: [4, 8, 12] }
    ],
    /**
     * OpenAI 的视频不是"聊天补全"那一套，走自己的 /videos 三步：
     *   ① POST /videos            → {"id":"video_…","status":"queued"}
     *   ② GET  /videos/{id}       → status: queued / in_progress / completed / failed
     *   ③ GET  /videos/{id}/content → 直接回 mp4 二进制
     *
     * 第③步和别家最大的不同：**下载也要带 Authorization**。
     * 别家给的是公网直链，拿着就能下；这里必须带着密钥去取，
     * 所以适配层会把鉴权头一路传到落盘那一步。
     */
    /**
     * 出图带参考图时走 `/v1/images/edits`（multipart 传文件），
     * 而不是往 `/images/generations` 的 JSON 里塞一个 image 字段 ——
     * 后者那个参数在 OpenAI 这边**根本不存在**，会被整个忽略，
     * 表现是"传了参考图但完全没起作用"。
     *
     * ⚠ 判据必须是这个显式声明，**不能用 family === 'openai'**：
     * 火山方舟的 family 也是 'openai'（它那句注释写得很清楚：
     * "对话侧完全兼容 OpenAI 协议"），但它的 SeedEdit 确实收 JSON 里的
     * image 字段。拿 family 当判据会把火山那条正确的路一起改坏 ——
     * 自检里五条既有断言当场红，就是这么撞出来的。
     */
    imageApi: 'openai-edits',
    videoApi: 'openai-videos',
    videoEndpoints: {
      create: '{{baseUrl}}/videos',
      status: '{{baseUrl}}/videos/{id}',
      content: '{{baseUrl}}/videos/{id}/content'
    },
    videoDefaults: {
      // Sora 收的是像素尺寸而不是 720p 这种档位，所以这里列的是尺寸
      resolution: '1280x720',
      resolutions: ['1280x720', '720x1280', '1024x1792', '1792x1024'],
      // 参考图只收一张（input_reference）
      maxImages: 1,
      refNote: 'Sora 的参考图只收 1 张（首帧），其余设定集参考图由提示词里的冻结描述承担'
    }
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
     * Seedance 的分辨率是拼在提示词里的 --resolution 标志，不是独立字段。
     * 档位就这三档，写小写 —— 方舟对大小写敏感。
     */
    videoDefaults: {
      resolution: '720p',
      resolutions: ['480p', '720p', '1080p'],
      /**
       * ⚠ Seedance 的图生视频只收**一张首帧图**（首尾帧模式最多两张，且要带 role）。
       * 多塞几张参考图过去会直接被判非法参数，任务提交就失败 ——
       * 这是"出视频一直失败"最常见的一个原因。
       * 一致性在这条路上靠首帧图本身 + 提示词里的冻结设定描述兜住。
       */
      maxImages: 1,
      // 首尾帧模式：两张图各带一个 role（first_frame / last_frame）。
      // 不带 role 的话它会当成两张参考图，而 Seedance 只收一张 —— 直接提交失败。
      endFrame: true,
      maxImagesWithEndFrame: 2,
      refNote: '方舟 Seedance 只收 1 张首帧图（首尾帧衔接时 2 张），其余设定集参考图改由提示词里的冻结描述承担'
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
      {
        id: 'doubao-seed-1-6-thinking-250615',
        capability: 'chat',
        // 挑技法、绑说话人这类"读一遍全片再判断"的活儿，思考型模型强一档；
        // 而且全片只调用一两次，贵一点也贵不到哪儿去
        label: '豆包 Seed 1.6 Thinking（思考型，调度首选）'
      },
      { id: 'doubao-1-5-vision-pro-32k-250115', capability: 'vision', label: '豆包 1.5 Vision Pro' },
      { id: 'deepseek-v3-241226', capability: 'chat', label: 'DeepSeek V3（方舟托管）' },
      { id: 'deepseek-r1-250120', capability: 'chat', label: 'DeepSeek R1（方舟托管，推理强）' },
      { id: 'kimi-k2-250711', capability: 'chat', label: 'Kimi K2（方舟托管）' },
      {
        id: 'doubao-seedream-4-0-250828',
        capability: 't2i',
        label: 'Seedream 4.0 文生图（最新）',
        /**
         * 4.0 每边不低于 1280、不高于 4096。
         *
         * 这条必须写出来：给它一个 1280×720（我们 16:9 的预设），短边 720 低于下限，
         * 服务端不会报错，而是**自己换一个尺寸出图** —— 于是你选了横屏，
         * 出来的却是竖的或方的，而请求记录里白纸黑字写着 1280x720。
         * 这种"参数被悄悄改写"是最难查的一类，只能在发出去之前就换算好。
         */
        imageSizes: { min: 1280, max: 4096, step: 8 }
      },
      {
        id: 'doubao-seedream-3-0-t2i-250415',
        capability: 't2i',
        label: 'Seedream 3.0 文生图',
        // 3.0 收的是固定几档，给别的会就近似 —— 那也是一次悄悄的改写
        imageSizes: {
          enum: ['1024x1024', '1152x864', '864x1152', '1280x720', '720x1280', '1248x832', '832x1248', '1512x648', '648x1512']
        }
      },
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
      {
        name: 'DASHSCOPE_API_KEY',
        label: 'API Key',
        required: true,
        hint:
          '百炼控制台 → API-KEY，sk- 开头。⚠ 密钥分区域：新加坡站签发的密钥在北京站一律 401，' +
          '那种情况下把上面的接口根地址改成 https://dashscope-intl.aliyuncs.com 再自检。'
      }
    ],
    capabilities: ['chat', 'vision', 't2i', 'i2i', 't2v', 'i2v', 'r2v', 'tts'],
    endpoints: {
      chat: '{{baseUrl}}/compatible-mode/v1/chat/completions',
      t2i: '{{baseUrl}}/api/v1/services/aigc/text2image/image-synthesis',
      i2v: '{{baseUrl}}/api/v1/services/aigc/video-generation/video-synthesis',
      tts: '{{baseUrl}}/api/v1/services/aigc/multimodal-generation/generation'
    },
    // 万相的档位写大写 P，和方舟正好相反，所以两边各自声明，不做统一
    videoDefaults: {
      resolution: '720P',
      resolutions: ['480P', '720P', '1080P'],
      // 万相的 img_url 是单数字段，本来也只收一张
      maxImages: 1,
      refNote: '通义万相只收 1 张首帧图'
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
/**
 * 音色清单。
 *
 * 和模型清单一样，这是**候选不是断言** —— 各家音色列表随版本变，
 * 而且能不能用还看你账号开通了什么。界面上允许手填，填了就以你填的为准。
 *
 * 为什么要给每个角色单独配音色：这和"每个角色同一张脸"是完全一样的道理。
 * 全片一个音色，两个人对话时观众分不出谁在说话 —— 画面上做了四层一致性，
 * 声音上却是同一个人配了所有角色，这个反差比不一致更出戏。
 */
    voices: [
      { id: 'Cherry', label: 'Cherry（女·清亮）', gender: 'f' },
      { id: 'Serena', label: 'Serena（女·沉稳）', gender: 'f' },
      { id: 'Chelsie', label: 'Chelsie（女·柔和）', gender: 'f' },
      { id: 'Ethan', label: 'Ethan（男·明朗）', gender: 'm' },
      { id: 'longwan', label: '龙婉（女·温柔，CosyVoice）', gender: 'f' },
      { id: 'longcheng', label: '龙橙（男·磁性，CosyVoice）', gender: 'm' },
      { id: 'longxiaochun', label: '龙小淳（女·知性，CosyVoice）', gender: 'f' },
      { id: 'longhua', label: '龙华（男·浑厚，CosyVoice）', gender: 'm' }
    ],
    /**
     * 自检走"列模型"而不是"发一次对话"。
     *
     * 发对话就得指定一个模型，而百炼的模型是按需开通的 ——
     * 示例里写死的那个你账号里没开，自检就红，可你的密钥完全没问题。
     * 列模型只验鉴权，不挑模型，这类误报直接消失。
     */
    probe: {
      label: '连通性自检（列出你账号里可用的模型）',
      method: 'GET',
      url: '{{baseUrl}}/compatible-mode/v1/models'
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

  /**
   * ───────────────────────── 本地出图：ComfyUI ─────────────────────────
   *
   * 和别家最大的不同：**跑在你自己的显卡上**。于是有两件别处做不到的事：
   *
   *   · 重出不花钱。改一句描述试五十次成本是零 —— 这直接改变用法，
   *     现在每按一次「重出」都是钱，人会犹豫，而犹豫的结果是将就
   *   · 一致性可以硬来。我们现在的第③层是"发参考图求厂商照办"
   *     （所以才有 headMatch 去抓"这家没吃参考图"）；ComfyUI 那边能上
   *     IPAdapter / ControlNet / LoRA —— 那不是求它，是让它做不到别的
   *
   * ⚠ 不需要密钥。secrets 是空的，密钥体检那一套要认得这种情况 ——
   * 把"没配密钥"报成故障，人会去找一个根本不存在的密钥。
   *
   * ⚠ 工作流是**用户自己的**（见 providers/comfy.js）：他导出 API 格式贴进来，
   * 在要我们填的节点上打 FD_PROMPT / FD_SEED 这类标记。硬塞一个我们
   * 自己的工作流，等于把 ComfyUI 最值钱的部分（可定制）扔掉。
   */
  {
    id: 'comfyui',
    name: '本地出图（ComfyUI）',
    docs: 'https://docs.comfy.org',
    baseUrl: 'http://127.0.0.1:8188',
    family: 'comfy',
    optional: true,
    // 本地服务不校验密钥。type: 'none' 是显式的这家不需要密钥 ——
    // 留空 auth 会让 publicCatalog 直接 500（它读 p.auth.type），
    // 而那个 500 的样子是整个「服务商与密钥」页打不开，看不出是谁害的
    auth: { type: 'none', optional: true },
    secrets: [],
    capabilities: ['t2i', 'i2i'],
    editableBaseUrl: true,
    hint: '要先把 ComfyUI 跑起来，并在「设置 → 本地出图」贴一份 API 格式的工作流',
    endpoints: {
      images: '{{baseUrl}}/prompt'
    },
    models: [
      {
        id: 'workflow',
        capability: 't2i',
        label: '按我贴的工作流出图',
        note: '出什么图完全由工作流决定（SDXL / Flux / 挂 LoRA 都行）。本地跑，不花钱'
      }
    ]
  },

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
    /**
     * ⚠ **i2i 是为 image-01 的 subject_reference 补的。**
     *
     * 适配器里早就写了这一段：
     *   body.subject_reference = [{ type: 'character', image_file: … }]
     * 而能力表里没有 'i2i' —— 于是参考图在进那个 switch 之前就被
     * "这家不支持图生图"那条分支剥掉了。整段代码够不到，是死的。
     *
     * 这件事的分量：subject_reference 是**云端少数几个真的按"这个人长什么样"
     * 设计的通道**（字面就写着 type: 'character'），而 gpt-image 的 edits
     * 做的是合成、不是身份保持。用户要的"换场景但还是这张脸"，云端这边
     * 主要就指望它。留着一段够不到的代码，等于把这条路悄悄封了。
     *
     * ⚠ 这条改动**没有在真机上验过** —— 本机出网是白名单，打不到海螺。
     * 验过的只有"参考图能走到请求体里、而且装的是角色那张"（见自检）。
     * 厂商那边认不认这个字段，得你那边真跑一次才知道。
     */
    capabilities: ['chat', 'vision', 't2i', 'i2i', 'i2v', 't2v', 'r2v'],
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
    // 官方 H3 支持到 2K；Hailuo 系最高 1080P。取并集，选了模型不支持的档位服务端会直接报错说清楚。
    videoDefaults: {
      resolution: '1080P',
      resolutions: ['512P', '768P', '1080P', '2K'],
      /**
       * ⚠ 这个 9 是**这家的天花板**，不是每个模型都收得下。
       *
       * 只有 H3 收 9 张；Hailuo / I2V / S2V 系走 first_frame_image，
       * 实际只吃 1 张（S2V 另外加一张 subject_reference）。
       * 所以真正生效的上限写在**每个模型自己**的 maxImages 上，这里只是兜底 ——
       * 按厂商定上限，会让选了海螺的人每一镜都先带 5 张撞一次墙、再减到 2 张撞一次、
       * 最后才发得出去：白跑两轮，而且日志上看起来像是厂商小气。
       */
      maxImages: 9
    },
    models: [
      // H3 是全模态：一次能收最多 9 张图 + 3 段视频 + 3 段音频，出 2K、原生立体声、最长 15 秒。
      // 请求结构和 Hailuo 系不同（content[] 多模态数组），适配器按模型名分流。
      { id: 'MiniMax-H3', capability: 'r2v', label: 'H3 全模态（9 张参考图，2K，最长 15 秒）', durations: [6, 10, 15], multimodal: true, maxImages: 9 },
      { id: 'MiniMax-Hailuo-2.3', capability: 'i2v', label: '海螺 2.3 图生视频（最新）', durations: [6, 10], maxImages: 1 },
      { id: 'MiniMax-Hailuo-02', capability: 'i2v', label: '海螺 02 图生视频', durations: [6, 10], maxImages: 1 },
      { id: 'I2V-01-Director', capability: 'i2v', label: 'I2V-01 Director（可写运镜指令）', durations: [6], maxImages: 1 },
      { id: 'I2V-01-live', capability: 'i2v', label: 'I2V-01 live（二次元更好）', durations: [6], maxImages: 1 },
      { id: 'I2V-01', capability: 'i2v', label: 'I2V-01', durations: [6], maxImages: 1 },
      { id: 'T2V-01-Director', capability: 't2v', label: 'T2V-01 Director 文生视频', durations: [6], maxImages: 0 },
      { id: 'T2V-01', capability: 't2v', label: 'T2V-01 文生视频', durations: [6], maxImages: 0 },
      // S2V 的第二张走 subject_reference 字段，不占 first_frame_image 的位置
      { id: 'S2V-01', capability: 'i2v', label: 'S2V-01（主体参考，锁人设强）', durations: [6], maxImages: 2 },
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
      videoCreate: '{{baseUrl}}/video_generation',
      /**
       * 查任务：`GET {{baseUrl}}/query/video_generation/{task_id}`。
       * 这是 MiniMax v2 官方文档写明的写法，**task_id 是路径段、不是查询参数**，
       * 而这家的 baseUrl 已经以 /v2 结尾，所以直接拼在后面就对。
       *
       * 用 `?task_id=` 那种（v1 的写法）去问 v2 会很误导人：中转平台把它当成
       * 未知路径裸转发给上游，上游拿中转 key 当然不认，回一句 login fail (1004) ——
       * "路径不对"就这样伪装成了"密钥不对"。
       *
       * 响应长这样（用户实测）——
       *   {"task":{"id":…,"status":"succeeded","content":{"url":…},
       *            "resolution":"2K","duration":5}}
       * 注意状态和地址都在 **task 这一层里面**，少看一层就读不出状态，
       * 然后一路轮询到超时（表现是"厂商平台早就出好了，流水线还在转"）。
       *
       * 这里仍然留空 = 自动探测，而不是写死：中转平台改路径很勤，
       * 写死了改版就得等我发新版。探测已经把这个写法排在第一个试，
       * 而且会验证返回内容确实是一条任务记录，试一次就中。
       * 真要写死，在「服务商与密钥 → 接口地址（高级）」里填，填完立刻生效。
       */
      videoQuery: '',
      // 这家没有"取文件"这一步：地址直接在 task.content.url 里
      fileRetrieve: ''
    },
    /**
     * 这家自己的一套路径，排在通用候选之前试。
     *
     * 线索来自用户实测拿到的视频地址：
     *   https://files.metaso.cn/api/video-generation/2087979924949516288/content
     * 说明秘塔在 MiniMax 那套之外，还有自己的 /api/video-generation/{id} 这条线。
     * 猜错了代价只有一次请求 —— 探测会验证返回的确实是一条任务记录才认。
     */
    videoQueryShapes: [
      '{origin}/api/video-generation/{taskId}',
      '{origin}/api/video-generation/{taskId}/status',
      '{{baseUrl}}/query/video_generation/{taskId}'
    ],
    /**
     * 请求体和 MiniMax 官方 H3 大体一致（content[] 多模态），但多两个字段：
     *   ratio       "16:9" 这类宽高比
     *   resolution  官方示例用 "2K"
     * 时长档位按示例是 5 秒起，和官方 H3 的 6 秒不一样 —— 别照搬。
     */
    videoDefaults: {
      resolution: '768P',
      ratio: true,
      // 服务端原话：仅支持 480p、512p、768P 或 2K。注意大小写不统一，按它给的原样发。
      resolutions: ['480p', '512p', '768P', '2K'],
      /**
       * 9 张 —— 和官方 H3 一样。
       *
       * 这里原来写的是 3，理由是"这家会回「输入媒体数量超过限制 (2013)」，
       * 保守一点"。**那个理由站不住**：用户截了这家控制台的图，
       * 参考素材那一栏明明白白写着 `0/9`（外加视频 0/3、音频 0/3）。
       *
       * 也就是说当初那次 2013 报错多半不是"图太多"，而是别的原因
       * （某张图的地址取不到、总体积超了、那一次的临时故障）——
       * 而我们把它归因成张数，然后**永久按 3 张发**，白白丢掉了一半的
       * 参考图，也就是白白丢掉了一致性。
       *
       * 教训：拿一个猜测当默认值，它就会变成事实，而且没人会去质疑它。
       * 真上限以厂商界面为准；退让逻辑仍然留着兜底，但它只是兜底。
       */
      maxImages: 9,
      /**
       * ⚠ 这家**是收首尾帧的** —— 控制台上明明白白摆着「起始帧」和「结束帧」两个框。
       *
       * 这里原来没写 endFrame，于是「连续动作」在秘塔上整个是空的：
       * 我们先说一句"把下一镜那张图锁成末帧，两镜之间会是无缝的"，
       * 紧接着适配器发现目录里没标 endFrame，又说一句"这家不收末帧，会是硬切"。
       * 两句自相矛盾的话躺在同一份日志里，而用户手上的控制台截图证明第二句是错的。
       *
       * 教训和上面那个 maxImages 是同一个：**目录里的一个"没写"，
       * 和"明确写了不支持"在代码里是同一回事**，而它会安静地关掉一整条功能。
       */
      endFrame: true,
      // 首尾帧两张 + 参考图，总共仍在 9 张之内
      maxImagesWithEndFrame: 9,
      refNote: '按官方 H3 的 9 张发；万一这家另有限制，会自动减半重试'
    },
    models: [
      {
        id: 'MiniMax-H3',
        capability: 'r2v',
        label: 'MiniMax H3（2K，全模态，最多 9 张参考图）',
        durations: [5, 10, 15],
        multimodal: true
      }
    ],
    /**
     * 这家只做视频，没有便宜的接口可探。真提交一个任务要花钱，
     * 所以故意发一个缺参数的请求：
     *   401/403 → 密钥不对
     *   400/422 → **鉴权通过了、路径也对**，只是参数不全 —— 这就算连通
     * paramErrorMeansOk 就是告诉自检别把后一种当失败。
     */
    probe: {
      label: '连通性自检（发一个缺参数的请求，看鉴权是否通过）',
      method: 'POST',
      url: '{{baseUrl}}/video_generation',
      body: { model: 'MiniMax-H3' },
      // 这个自检打的是视频接口，所以要替换成用户路由到这家的**视频**模型
      capability: 'video',
      paramErrorMeansOk: true
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
          resolution: '768P',
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
          resolution: '768P',
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

  // ───────────────────────── 出图专线：Agnes AI ─────────────────────────
  /**
   * 路径长得和 OpenAI 一模一样（/v1/images/generations、Bearer 鉴权），
   * 但**不能当 OpenAI 兼容家族接**，有三处不一样，每一处错了都不报错：
   *
   *   1. `response_format` 不能放在请求体顶层，要放进 `extra_body`。
   *      通用分支恰恰是往顶层放的。
   *   2. 尺寸不收任意像素，收 `1K`/`2K`/`3K`/`4K` 档位 + `ratio` 宽高比。
   *      发 1280x720 这类"不受原生支持的精确尺寸"，文档明说会被
   *      **自动映射到最接近的档位** —— 也就是你在请求记录里看到 1280x720、
   *      任务成功、出来的图却是别的尺寸。这正是 fitImageSize 那段注释里
   *      写的"最坏的那一种"表现。
   *   3. 参考图字段的位置文档自己说了两遍，两遍不一样（见 adapters 里的 agnes 分支）。
   *
   * 所以它有自己的 family。
   */
  {
    id: 'agnes',
    name: 'Agnes AI（Agnes Image）',
    docs: 'https://www.agnes-ai.cn/zh-Hans/docs/',
    baseUrl: 'https://api.agnes-ai.cn/v1',
    family: 'agnes',
    auth: { type: 'bearer', secret: 'AGNES_API_KEY' },
    secrets: [
      {
        name: 'AGNES_API_KEY',
        label: 'API Key',
        required: true,
        hint:
          'Agnes 控制台签发。文档上写着「所有支持的输出分辨率档位和输入参考图片当前均免费」——' +
          '注意那个「当前」，别把它当成长期承诺来排产。'
      }
    ],
    capabilities: ['t2i', 'i2i', 't2v', 'i2v'],
    /**
     * 出视频是异步任务：POST 拿号，再查。
     *
     * ⚠ 查结果那条**不在 v1 下面** —— 提交是 `/v1/videos`，查询是
     * `/agnesapi?video_id=…`。所以用 {{apiRoot}}（接口根地址去掉版本段）
     * 而不是 {{baseUrl}}，这样用户把根地址改到中转站时两条一起动。
     *
     * idPath 取 video_id：响应里 id / task_id / video_id 三个都有，
     * 文档说"新接入建议使用 video_id"，也只有它配这条推荐的查询地址。
     */
    taskPoll: {
      url: '{{apiRoot}}/agnesapi?video_id={taskId}',
      method: 'GET',
      idPath: 'video_id',
      statusPath: 'status',
      successStates: ['completed'],
      failureStates: ['failed']
    },
    videoDefaults: {
      resolution: '720P',
      resolutions: ['480P', '720P', '1080P'],
      /**
       * 末帧走「关键帧动画」模式（extra_body.mode: 'keyframes'），
       * 所以这一步最多两张：首帧 + 末帧。设定集的参考图这一步带不上。
       */
      endFrame: true,
      maxImages: 2,
      refNote: 'Agnes 出视频只收首帧（和末帧），一致性由首帧图和提示词里的冻结设定承担'
    },
    /**
     * 同一个模型既文生图也图生图，不需要另配「图生图模型」。
     *
     * 不声明这个的话，带参考图时会去读「设置 → 图生图模型」，
     * 那一项默认是火山的 doubao-seededit-3-0-i2i —— 于是要么把一个
     * 火山的模型 id 发给 Agnes，要么弹一句"Agnes 没有这个模型，
     * 请改成 Agnes 自己的编辑模型"，而 Agnes 根本没有单独的编辑模型。
     */
    i2iSameModel: true,
    endpoints: {
      images: '{{baseUrl}}/images/generations',
      videos: '{{baseUrl}}/videos'
    },
    /**
     * 出图尺寸锁在 2K 这一档。
     *
     * 为什么不是 1K：16:9 的 1K 是 1312×736，比 1080p 还矮。这个项目最后要出
     * 1080p 的片子，拿一张 736 高的图去做首帧，放大的糊是躲不掉的。
     * 文档自己也建议"要 1920×1080 就请求 2K + 16:9，再在下游缩放"。
     *
     * 为什么不是 4K：出图慢、下游还要重新编码，多出来的像素在成片里看不见。
     *
     * 写成 enum 是为了复用 fitImageSize —— 它会在同方向里挑比例最接近的那个，
     * 并且换过尺寸时自动说一声。这里数字全部照抄文档的「输出尺寸参考」表，
     * 一个都没算，因为算出来的和它实际给的对不上就白搭。
     */
    imageSizes: {
      why: '它只收 1K/2K/3K/4K 四档，1K 的 16:9 只有 1312×736（比 1080p 还矮）'
        + '，所以取 2K。发 1280×720 它不会报错，但会自己映射到最近的一档，而那张映射表没公开。',
      enum: [
        '2048*2048',  // 1:1
        '1728*2304',  // 3:4
        '2304*1728',  // 4:3
        '2624*1472',  // 16:9
        '1472*2624',  // 9:16
        '1664*2496',  // 2:3
        '2496*1664',  // 3:2
        '3136*1344'   // 21:9
      ]
    },
    models: [
      {
        id: 'agnes-image-2.1-flash',
        capability: 't2i',
        label: 'Agnes Image 2.1 Flash（文生图 / 图生图 / 多图合成）'
      },
      {
        id: 'agnes-video-v2.0',
        capability: 'i2v',
        label: 'Agnes Video 2.0（图生视频 / 首尾帧）',
        /**
         * 时长不是档位，是**帧数**：num_frames ≤ 441 且必须是 8n+1。
         * 24 fps 下这等于 1/3 秒一档 —— 实际上是连续的。
         *
         * 这里列整秒 1~18，是为了让 alignDuration 有东西可对齐，而不是
         * 因为它只能出这几个数。真正发出去的帧数由 agnesFrames 算，
         * 出来多长以响应里的 seconds 为准。
         *
         * 上限 18 是 441 帧 ÷ 24 fps 的结果，不是拍脑袋定的。
         */
        durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
      }
    ],
    /**
     * 自检发一次最小的文生图。
     *
     * 这家没有「列模型」接口，只能靠真发一次 —— 所以档位挑最小的 1K、
     * 提示词也给最短的，别让一次自检跑掉半分钟。
     */
    probe: {
      label: '连通性自检（出一张 1K 小图）',
      method: 'POST',
      url: '{{baseUrl}}/images/generations',
      body: {
        model: 'agnes-image-2.1-flash',
        prompt: 'a single red apple on a white table',
        size: '1K',
        ratio: '1:1',
        extra_body: { response_format: 'url' }
      }
    },
    templates: [
      {
        id: 't2i',
        label: '文生图（档位 + 宽高比）',
        capability: 't2i',
        method: 'POST',
        url: '{{baseUrl}}/images/generations',
        body: {
          model: 'agnes-image-2.1-flash',
          prompt: '国风水墨，太湖清晨，执法艇破雾而行，电影感构图',
          size: '2K',
          ratio: '16:9',
          extra_body: { response_format: 'url' }
        }
      },
      {
        /**
         * ⚠ 这个模板存在的**首要目的**是让你亲手验一件事：
         * 参考图到底该放 `image` 还是 `extra_body.image`。文档两处说法不一样，
         * 而放错的表现是——不报错、不警告，安静地退化成一次纯文生图。
         *
         * 验法：给一张辨识度极高的参考图（比如一张脸），提示词写
         * "保持这个人的长相"。出来的不是那个人，就是没吃到。
         */
        id: 'i2i',
        label: '图生图 / 多图合成（两个位置都放，见注释）',
        capability: 'i2i',
        method: 'POST',
        url: '{{baseUrl}}/images/generations',
        body: {
          model: 'agnes-image-2.1-flash',
          prompt: '保持这个人的长相和服装，把他放到雨夜的码头上',
          size: '2K',
          ratio: '16:9',
          image: ['https://example.com/face.png'],
          extra_body: {
            response_format: 'url',
            image: ['https://example.com/face.png']
          }
        }
      },
      {
        id: 'i2v',
        label: '图生视频（异步任务）',
        capability: 'i2v',
        method: 'POST',
        url: '{{baseUrl}}/videos',
        async: true,
        body: {
          model: 'agnes-video-v2.0',
          prompt: '镜头缓慢推进，水面泛起波光',
          image: 'https://example.com/first-frame.png',
          width: 1280,
          height: 720,
          num_frames: 121,
          frame_rate: 24
        }
      },
      {
        /**
         * ⚠ 首尾帧在这一家叫「关键帧动画」，而且和图生视频是**两种模式**：
         * 顶层 image 是图生视频，extra_body.image + mode:'keyframes' 才是首尾帧。
         * 两个一起发等于同时点了两种模式 —— 别照着出图那个模板抄。
         */
        id: 'keyframes',
        label: '首尾帧（关键帧动画）',
        capability: 'i2v',
        method: 'POST',
        url: '{{baseUrl}}/videos',
        async: true,
        body: {
          model: 'agnes-video-v2.0',
          prompt: '在两个关键帧之间生成流畅过渡，保持人物一致',
          extra_body: {
            image: ['https://example.com/keyframe1.png', 'https://example.com/keyframe2.png'],
            mode: 'keyframes'
          },
          num_frames: 121,
          frame_rate: 24
        }
      },
      {
        id: 'video-query',
        label: '查视频任务（用 video_id）',
        method: 'GET',
        url: '{{apiRoot}}/agnesapi?video_id=PUT_VIDEO_ID_HERE'
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
    // image2video 的 image 是单数字段
    // image_tail 是可灵的末帧字段。有它才能做到"这一镜的结尾就是下一镜的开头"
    videoDefaults: {
      maxImages: 1,
      endFrame: true,
      maxImagesWithEndFrame: 2,
      refNote: '可灵图生视频只收 1 张首帧图（用首尾帧衔接时 2 张）'
    },
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
    endpoints: {
      i2v: '{{baseUrl}}/img2video',
      r2v: '{{baseUrl}}/reference2video',
      // 首尾帧是另一条接口：images[0] 是首帧、images[1] 是尾帧
      se2v: '{{baseUrl}}/start-end2video'
    },
    // reference2video 收多张参考图 —— 这是跨镜头一致性最好的一条路
    videoDefaults: { maxImages: 3, endFrame: true, maxImagesWithEndFrame: 2 },
    taskPoll: {
      url: '{{baseUrl}}/tasks/{taskId}/creations',
      method: 'GET',
      idPath: 'task_id',
      statusPath: 'state',
      successStates: ['success'],
      failureStates: ['failed']
    },
    models: [
      { id: 'viduq1', capability: 'r2v', label: 'Vidu Q1（支持多张参考图锁人设）', durations: [4, 8], maxImages: 3 },
      // classic 走 img2video，只吃首帧那一张
      { id: 'viduq1-classic', capability: 'i2v', label: 'Vidu Q1 Classic', durations: [4, 8], maxImages: 1 },
      { id: 'vidu2.0', capability: 'r2v', label: 'Vidu 2.0', durations: [4, 8], maxImages: 3 },
      { id: 'vidu1.5', capability: 'r2v', label: 'Vidu 1.5（便宜）', durations: [4, 8], maxImages: 3 }
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

  // ───────────────────────── ElevenLabs：音效 ─────────────────────────
  /**
   * 目前唯一一家有**专门的音效接口**的。
   *
   * 别的家有的是 TTS（把字念出来）或者音乐生成（写一段旋律），
   * 都不是"生成一段敲门声"。拿它们凑合的结果是：
   * TTS 会**朗读"敲门声"这三个字**，音乐生成会给你一段配乐 ——
   * 两种都比没有音效更糟，因为它们会被当成成片的一部分发出去。
   *
   * ⚠ 请求结构照官方文档写。厂商改版很勤，真对不上时到「API 联调台」
   * 用 sfx 这个模板试出能通的写法，再到「服务商与密钥 → 接口地址」里改 ——
   * 这正是那两处存在的意义，不指望预设永远对。
   */
  {
    id: 'elevenlabs',
    name: 'ElevenLabs（音效 / 配音）',
    docs: 'https://elevenlabs.io/docs/api-reference',
    baseUrl: 'https://api.elevenlabs.io/v1',
    family: 'elevenlabs',
    // 它不用 Bearer，用自己的 xi-api-key 头
    auth: { type: 'header', header: 'xi-api-key', secret: 'ELEVENLABS_API_KEY' },
    secrets: [
      {
        name: 'ELEVENLABS_API_KEY',
        label: 'API Key',
        required: true,
        hint: '控制台 → Profile → API Key。音效按生成秒数计费，一镜通常一两秒。'
      }
    ],
    capabilities: ['sfx', 'tts'],
    editableBaseUrl: true,
    endpoints: {
      sfx: '{{baseUrl}}/sound-generation',
      tts: '{{baseUrl}}/text-to-speech/{voice}'
    },
    models: [
      { id: 'eleven_text_to_sound_v2', capability: 'sfx', label: '音效生成（一句话描述 → 一段声音）' },
      { id: 'eleven_multilingual_v2', capability: 'tts', label: '多语种配音' }
    ],
    /**
     * 这家没有便宜的"列模型"接口可探，而真生成一次要花钱。
     * 拿用量接口当连通性自检：它只读，不产生费用，但能验证密钥对不对。
     */
    probe: { label: '连通性自检（读订阅信息，不计费）', method: 'GET', url: '{{baseUrl}}/user/subscription' },
    templates: [
      {
        id: 'sfx',
        label: '音效生成',
        capability: 'sfx',
        method: 'POST',
        url: '{{baseUrl}}/sound-generation',
        body: {
          text: 'knocking on a wooden door, three knocks',
          duration_seconds: 2,
          // 0~1：越高越贴提示词，越低越"有创意"。音效要的是贴，所以给高
          prompt_influence: 0.6
        }
      },
      {
        id: 'subscription',
        label: '看用量（不计费）',
        method: 'GET',
        url: '{{baseUrl}}/user/subscription'
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

/**
 * 这家到底有没有这个模型？
 *
 * ══════════ 为什么要有这一条 ══════════
 *
 * 真实事故：路由配成了「openai / claude-opus-5」。
 * claude-opus-5 是 Anthropic 的模型 id，OpenAI 那家根本没有它。
 * 而这个搭配**一路畅通无阻**：能选、能存、能发出去，
 * 然后在拆分镜那一步卡满三分钟，回一句「请求超时（180151ms 未返回）」。
 *
 * 三分钟之后拿到的信息量是零，而这件事在**点下去之前**就完全判断得出来 ——
 * 目录里明明白白列着这家有哪些模型。
 *
 * ══════════ 为什么不能见到不认识的就报警 ══════════
 *
 * 中转站（在国内是常态）走的正是"OpenAI 的协议、别家的模型"：
 * 你把 openai 的接口根地址指到中转站，然后用它家支持的任意模型 id。
 * 那**完全合法**，而且是很多人唯一能用的路。
 *
 * 所以判据是两条一起看：目录里没有 **且** 接口根地址没被改过。
 * 改过地址 = 你自己知道你在连别的东西，我们不该多嘴。
 *
 * 返回 null 表示没话说 —— 调用方据此决定要不要显示。
 */
export function modelWarning(providerId, modelId, { baseUrlOverridden = false } = {}) {
  const provider = getProvider(providerId);
  const model = String(modelId || '').trim();
  if (!provider || !model) return null;
  // 地址改过 = 接的是中转/网关，模型 id 由那边说了算，闭嘴
  if (baseUrlOverridden) return null;
  const known = provider.models || [];
  // 这家压根没列模型（比如只当网关用的那几家），无从判断
  if (!known.length) return null;
  if (known.some((m) => m.id === model)) return null;

  /**
   * 认一下这个 id **像**谁家的 —— "这不是这家的模型"已经有用，
   * "这看着像 Anthropic 的模型" 更有用：人一眼就知道自己选串行了。
   */
  const FAMILY = [
    [/^claude[-.]/i, 'Anthropic（Claude）'],
    [/^gpt[-.]|^o[134][-.]?|^chatgpt/i, 'OpenAI'],
    [/^gemini[-.]/i, 'Google'],
    [/^deepseek[-.]/i, 'DeepSeek'],
    [/^qwen|^qwq/i, '通义千问'],
    [/^doubao[-.]|^ep-/i, '火山方舟'],
    [/^glm[-.]/i, '智谱'],
    [/^moonshot[-.]|^kimi/i, '月之暗面']
  ];
  const looksLike = FAMILY.find(([re]) => re.test(model))?.[1] || '';
  const guess = looksLike && looksLike !== provider.name
    ? `「${model}」看着是 ${looksLike} 的模型。`
    : '';

  return {
    model,
    provider: providerId,
    providerName: provider.name,
    looksLike,
    text:
      `${provider.name} 的模型表里没有「${model}」。${guess}`
      + `发过去多半不是报错就是干等 —— 这一家目前列的是：${known.slice(0, 6).map((m) => m.id).join('、')}${known.length > 6 ? ' 等' : ''}。`
      + '如果你用的是中转站，把「服务商与密钥 → 接口根地址」改成中转站地址，这条提示就不再出现。'
  };
}

/** 按能力筛服务商，"选模型"下拉用 */
export function providersWith(capability) {
  return PROVIDERS.filter((p) => (p.capabilities || []).includes(capability));
}

/** 这家视频接口认哪些分辨率档位。空数组 = 它不收这个字段，别瞎发。 */
/** 这家有哪些音色可选。空数组表示这家没给清单 —— 界面上退回手填。 */
export function voicesOf(providerId) {
  const p = typeof providerId === 'string' ? PROVIDERS.find((x) => x.id === providerId) : providerId;
  return p?.voices || [];
}

export function videoResolutions(provider) {
  return provider?.videoDefaults?.resolutions || [];
}

/**
 * 把用户选的分辨率翻译成**这一家认识的那个写法**。
 *
 * 各家的大小写完全不统一：方舟要 `720p`，万相要 `720P`，秘塔要 `768P` 但 `480p`。
 * 用户在设置里选一次之后不该因为换了家就失效，所以这里按大小写不敏感匹配，
 * 匹配上就用**厂商自己的原样拼写**发出去。
 *
 * 匹配不上（比如从秘塔的 2K 切到方舟，方舟根本没有 2K）就退回该家默认档，
 * 而不是把一个必然报错的值发过去 —— 换个服务商就整条流水线报错，太蠢了。
 */
export function resolveResolution(provider, requested) {
  const list = videoResolutions(provider);
  const fallback = provider?.videoDefaults?.resolution || null;
  if (!list.length) return fallback;
  if (!requested || requested === 'auto') return fallback;
  const hit = list.find((r) => r.toLowerCase() === String(requested).toLowerCase());
  return hit || fallback;
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
    // 界面上的分辨率下拉直接读这个，免得前端再抄一份档位清单
    videoDefaults: p.videoDefaults || null,
    // 音色清单：每个角色配一个，界面要拿它渲染下拉
    voices: p.voices || [],
    // 接口地址清单：中转平台的路径经常对不上，界面上要能让用户自己改
    endpoints: p.endpoints || {},
    probe: p.probe || null,
    templates: p.templates || [],
    taskPoll: p.taskPoll || null
  }));
}
