/**
 * 统一媒体能力适配层。
 *
 * 上层（一致性引擎、Studio 流水线）只说"我要一张图/一段视频"，
 * 各家协议的差异全压在这一层里。加一家新厂商，改这里的 switch 就够了，
 * 流水线一行不用动。
 *
 * 各家踩过的坑写在对应分支的注释里 —— 这些都是联调时最费时间的部分。
 */
import { getProvider, resolveResolution, videoResolutions } from './catalog.js';
import { allowedDurations, alignDuration } from '../duration.js';
import { send, sendAsync, baseUrlOf, interpolate, diagnose } from './index.js';
import { poll } from '../http-client.js';
import * as settings from '../settings.js';

/** 深度优先找响应里第一个媒体 URL。各家藏的深度都不一样，与其逐个写路径不如直接找。 */
export function firstMediaUrl(obj, { extensions = null } = {}) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const value of Object.values(node)) {
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        if (/\.(json|txt|html)(\?|$)/i.test(value)) continue;
        if (extensions && !extensions.some((ext) => value.toLowerCase().includes(ext))) continue;
        return value;
      }
      if (value && typeof value === 'object') {
        const found = walk(value);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(obj) || (extensions ? walk(obj) : null);
}

/** base64 出图的厂商（OpenAI gpt-image-1 默认就是 b64）也要能接住 */
function firstBase64(obj) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && /^(b64_json|b64|image_base64|base64)$/i.test(key) && value.length > 100) {
        return value;
      }
      if (value && typeof value === 'object') {
        const found = walk(value);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(obj);
}

/** 海螺只认宽高比，不认像素尺寸。把 1280*720 这类换算过去。 */
function sizeToRatio(size) {
  const [w, h] = String(size).split(/[*x×]/).map(Number);
  if (!w || !h) return '16:9';
  const ratio = w / h;
  const table = [
    ['21:9', 21 / 9], ['16:9', 16 / 9], ['4:3', 4 / 3], ['3:2', 3 / 2],
    ['1:1', 1], ['2:3', 2 / 3], ['3:4', 3 / 4], ['9:16', 9 / 16]
  ];
  return table.reduce((best, cur) => (Math.abs(cur[1] - ratio) < Math.abs(best[1] - ratio) ? cur : best))[0];
}

/**
 * 画幅 → 出图尺寸。
 * 竖屏短剧必须出竖图，横图裁成竖屏会把人裁掉半张脸 ——
 * 所以出图和出视频共用「设置 → 画幅」这一个开关。
 */
const RATIO_SIZES = {
  '21:9': '1512*648',
  '16:9': '1280*720',
  '4:3': '1024*768',
  '1:1': '1024*1024',
  '3:4': '768*1024',
  '9:16': '720*1280'
};
export function ratioToSize(ratio) {
  return RATIO_SIZES[ratio] || RATIO_SIZES['16:9'];
}

function endpoint(provider, key, fallback) {
  const raw = provider.endpoints?.[key] || fallback;
  return interpolate(raw, provider);
}

function fail(label, res) {
  throw new Error(`${label} 失败（HTTP ${res.status}）：${diagnose(res)}`);
}

// ──────────────────────────────── 对话 ────────────────────────────────

/**
 * 统一对话入口。images 传进来就自动组装成多模态消息 —— 一致性校验靠它。
 */
export async function chat({
  providerId,
  model,
  system,
  user,
  images = [],
  temperature = 0.7,
  jsonMode = false,
  timeoutMs = 180000,
  label = '对话'
}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });

  if (images.length) {
    // OpenAI 多模态格式，火山/百炼兼容模式/智谱/FloatAI 都吃这一套
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: user },
        ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
      ]
    });
  } else {
    messages.push({ role: 'user', content: user });
  }

  const body = { model, messages, temperature };
  if (jsonMode) {
    // 支持的厂商会严格输出 JSON；不支持的会忽略这个字段，不至于报错，
    // 所以下游仍然保留 extractJSON 的兜底解析。
    body.response_format = { type: 'json_object' };
  }

  const res = await send(
    {
      provider: providerId,
      label,
      method: 'POST',
      url: endpoint(provider, 'chat', '{{baseUrl}}/chat/completions'),
      body,
      timeoutMs
    },
    null
  );
  if (!res.ok) fail(label, res);

  const text =
    res.json?.choices?.[0]?.message?.content ??
    res.json?.output?.choices?.[0]?.message?.content ??
    res.json?.output?.text ??
    '';
  if (typeof text !== 'string') {
    // 少数厂商把 content 也返回成数组
    return { text: Array.isArray(text) ? text.map((p) => p.text || '').join('') : '', raw: res.json };
  }
  return { text, raw: res.json, usage: res.json?.usage || null };
}

// ──────────────────────────────── 出图 ────────────────────────────────

/**
 * 文生图 / 图生图统一入口。
 *
 * refImages 非空时自动走各家的"参考图"通道 —— 这是保住角色一致性的关键路径，
 * 纯靠提示词描述外貌是锁不住人设的。
 */
export async function generateImage({
  providerId,
  model,
  prompt,
  negative = '模糊, 低质量, 畸变, 多余手指, 文字水印, 多人',
  size = null,
  seed = null,
  refImages = [],
  timeoutMs = 300000,
  label = '出图',
  onEvent = null
}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);
  const family = provider.family || 'openai';
  size = size || ratioToSize(settings.get('aspectRatio') || '16:9');

  switch (family) {
    case 'dashscope': {
      // 百炼出图是异步任务：POST 拿 task_id，再轮询。必须带 X-DashScope-Async: enable，
      // 不带的话接口会同步阻塞并且大概率超时。
      const input = { prompt, negative_prompt: negative };
      if (refImages.length) {
        // 万相的图生图走 ref_img；一并把强度调低，保人设又不至于完全复制原图
        input.ref_img = refImages[0];
      }
      const parameters = { size, n: 1 };
      if (seed !== null) parameters.seed = seed;
      if (refImages.length) parameters.ref_strength = 0.55;

      const { submitted, polled } = await sendAsync(
        {
          provider: providerId,
          label,
          method: 'POST',
          url: endpoint(provider, 't2i', '{{baseUrl}}/api/v1/services/aigc/text2image/image-synthesis'),
          headers: { 'X-DashScope-Async': 'enable' },
          body: { model, input, parameters },
          timeoutMs
        },
        onEvent
      );
      if (!submitted.ok) fail(label, submitted);
      const url = firstMediaUrl(polled?.json ?? submitted.json);
      if (!url) throw new Error(`${label}：响应里没有图片 URL`);
      return { url, base64: null, raw: polled?.json ?? submitted.json };
    }

    case 'minimax': {
      // 海螺出图用 aspect_ratio 而不是 size，返回在 data.image_urls 数组里
      const body = {
        model,
        prompt: negative ? `${prompt}。避免出现：${negative}` : prompt,
        aspect_ratio: sizeToRatio(size),
        n: 1,
        response_format: 'url'
      };
      if (seed !== null) body.seed = seed;
      if (refImages.length) body.subject_reference = [{ type: 'character', image_file: refImages[0] }];

      const res = await send(
        {
          provider: providerId,
          label,
          method: 'POST',
          url: endpoint(provider, 'images', '{{baseUrl}}/image_generation'),
          body,
          timeoutMs
        },
        onEvent
      );
      if (!res.ok) fail(label, res);
      // 海螺把业务错误塞在 base_resp 里，HTTP 仍然是 200 —— 不看这里会以为成功了
      const status = res.json?.base_resp;
      if (status && status.status_code !== 0) {
        throw new Error(`${label} 失败：${status.status_msg}（code ${status.status_code}）`);
      }
      const url = res.json?.data?.image_urls?.[0] || firstMediaUrl(res.json);
      const base64 = url ? null : firstBase64(res.json);
      if (!url && !base64) throw new Error(`${label}：响应里既没有图片 URL 也没有 base64`);
      return { url, base64, raw: res.json };
    }

    case 'kling':
    case 'vidu':
      throw new Error(`${provider.name} 不提供出图能力，请在设置里把「出图」换成别家`);

    default: {
      // OpenAI 兼容家族（含火山方舟 Seedream / SeedEdit、OpenAI gpt-image-1、FloatAI 中转）
      const body = { model, prompt, size: size.replace('*', 'x'), response_format: 'url' };
      if (seed !== null) body.seed = seed;
      if (refImages.length) {
        // 火山 SeedEdit 收单张 image；OpenAI 的 images/edits 是另一条 multipart 路径，
        // 这里统一按"JSON + image 字段"发，走 OpenAI 官方编辑接口时请在联调台里改用 /images/edits。
        body.image = refImages.length === 1 ? refImages[0] : refImages;
      }
      if (family === 'openai') {
        // OpenAI 的 gpt-image-1 不认 negative_prompt，把负向词并进正向描述
        body.prompt = negative ? `${prompt}\n\n避免出现：${negative}` : prompt;
        delete body.response_format; // gpt-image-1 固定返回 b64
      } else {
        body.negative_prompt = negative;
      }

      const res = await send(
        {
          provider: providerId,
          label,
          method: 'POST',
          url: endpoint(provider, 'images', '{{baseUrl}}/images/generations'),
          body,
          timeoutMs
        },
        onEvent
      );
      if (!res.ok) fail(label, res);
      const url = firstMediaUrl(res.json);
      const base64 = url ? null : firstBase64(res.json);
      if (!url && !base64) throw new Error(`${label}：响应里既没有图片 URL 也没有 base64`);
      return { url, base64, raw: res.json };
    }
  }
}

// ──────────────────────────────── 出视频 ────────────────────────────────

/**
 * 图生视频 / 参考图生视频。
 *
 * refImages 有多张且厂商支持 r2v 时，优先走参考图通道 ——
 * Vidu 的 reference2video 能同时锁人物和场景，是目前跨镜头一致性最好的一条路。
 */
export async function generateVideo({
  providerId,
  model,
  prompt,
  firstFrameUrl = null,
  refImages = [],
  duration = 5,
  resolution = null,
  aspectRatio = null,
  timeoutMs = 600000,
  label = '出视频',
  onEvent = null
}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);
  const family = provider.family || 'openai';

  // 分辨率：调用方指定 > 设置里选的 > 这家的默认档。
  // 统一在这里翻译成该厂商认识的写法，各分支只管把 finalResolution 塞进自己的字段。
  const wanted = resolution || settings.get('videoResolution');
  const finalResolution = resolveResolution(provider, wanted) || '720P';
  const known = videoResolutions(provider);
  if (
    wanted &&
    wanted !== 'auto' &&
    known.length &&
    !known.some((r) => r.toLowerCase() === String(wanted).toLowerCase())
  ) {
    onEvent?.({
      type: 'note',
      message: `${provider.name} 不支持 ${wanted}（它只认 ${known.join('/')}），本次按 ${finalResolution} 出`
    });
  }
  const finalRatio = aspectRatio || settings.get('aspectRatio') || '16:9';
  const supportsR2V = (provider.capabilities || []).includes('r2v');
  const useRef = supportsR2V && refImages.length > 0 && !firstFrameUrl;

  // 视频模型只接受固定档位（5/10、4/8 之类）。默认向上取：
  // 宁可多出来一点合成时裁掉，也不要少了把动作或台词切断。
  const allowed = allowedDurations(provider, model);
  const actualDuration = alignDuration(duration, allowed);
  if (actualDuration !== Math.round(duration)) {
    onEvent?.({
      type: 'note',
      message: `${provider.name} 的合法时长只有 ${allowed.join('/')} 秒，${duration}s 已对齐到 ${actualDuration}s`
    });
  }

  // 海螺是三步流程，和别家的两步轮询不是一回事，单独走一条路径
  if (family === 'minimax') {
    return generateVideoMiniMax({
      provider,
      providerId,
      model,
      prompt,
      firstFrameUrl,
      refImages,
      duration: actualDuration,
      requestedDuration: duration,
      allowed,
      resolution: finalResolution,
      aspectRatio: finalRatio,
      timeoutMs,
      label,
      onEvent
    });
  }

  let spec;
  switch (family) {
    case 'dashscope':
      spec = {
        url: endpoint(provider, 'i2v', '{{baseUrl}}/api/v1/services/aigc/video-generation/video-synthesis'),
        headers: { 'X-DashScope-Async': 'enable' },
        body: {
          model,
          input: { prompt, img_url: firstFrameUrl || refImages[0] },
          parameters: { resolution: finalResolution, duration: actualDuration }
        }
      };
      break;

    case 'kling':
      spec = {
        url: endpoint(provider, 'i2v', '{{baseUrl}}/v1/videos/image2video'),
        body: {
          model_name: model,
          image: firstFrameUrl || refImages[0],
          prompt,
          duration: String(actualDuration), // 可灵收的是字符串，不是数字
          mode: 'std'
        }
      };
      break;

    case 'vidu':
      spec = {
        url: useRef
          ? endpoint(provider, 'r2v', '{{baseUrl}}/reference2video')
          : endpoint(provider, 'i2v', '{{baseUrl}}/img2video'),
        body: {
          model,
          images: useRef ? refImages.slice(0, 3) : [firstFrameUrl || refImages[0]],
          prompt,
          duration: actualDuration,
          aspect_ratio: finalRatio
        }
      };
      break;

    default: {
      // 火山方舟 Seedance：参数不走独立字段，而是拼在 text 里的 --key value
      const flags = `--resolution ${finalResolution.toLowerCase()} --dur ${actualDuration} --ratio ${finalRatio}`;
      const content = [{ type: 'text', text: `${prompt} ${flags}` }];
      for (const img of [firstFrameUrl, ...refImages].filter(Boolean).slice(0, 4)) {
        content.push({ type: 'image_url', image_url: { url: img } });
      }
      spec = {
        url: endpoint(provider, 'videoTasks', '{{baseUrl}}/contents/generations/tasks'),
        body: { model, content }
      };
    }
  }

  const { submitted, polled } = await sendAsync(
    { provider: providerId, label, method: 'POST', timeoutMs, ...spec },
    onEvent
  );
  if (!submitted.ok) fail(label, submitted);

  const url = firstMediaUrl(polled?.json ?? submitted.json, { extensions: ['.mp4', '.mov', '.webm'] })
    || firstMediaUrl(polled?.json ?? submitted.json);
  if (!url) throw new Error(`${label}：响应里没有视频 URL`);
  return {
    url,
    actualDuration,
    requestedDuration: duration,
    allowedDurations: allowed,
    resolution: finalResolution,
    raw: polled?.json ?? submitted.json
  };
}

/**
 * 查任务的地址。
 *
 * 官方写明了是 /query/video_generation?task_id=…，但中转平台经常改路径
 * 而且文档里只给了「提交」那一步。与其让用户卡在这儿，不如把几种常见写法
 * 挨个试一遍，通了就记住 —— 同一家后面所有任务都直接用它。
 */
const queryUrlCache = new Map();

const QUERY_SHAPES = [
  (base, id) => `${base}/query/video_generation?task_id=${encodeURIComponent(id)}`,
  (base, id) => `${base}/video_generation/${encodeURIComponent(id)}`,
  (base, id) => `${base}/query/video_generation/${encodeURIComponent(id)}`,
  (base, id) => `${base}/video_generation?task_id=${encodeURIComponent(id)}`,
  (base, id) => `${base}/tasks/${encodeURIComponent(id)}`
];

async function resolveQueryUrl(provider, providerId, taskId, label, onEvent) {
  const base = baseUrlOf(provider);
  const configured = provider.endpoints?.videoQuery;
  if (configured) return `${interpolate(configured, provider)}?task_id=${encodeURIComponent(taskId)}`;

  // 缓存键带上 baseUrl：换了中转地址就该重新探，不能拿旧路径去套新家
  const cacheKey = `${providerId}::${base}`;
  const cached = queryUrlCache.get(cacheKey);
  if (cached) return cached(base, taskId);

  for (const shape of QUERY_SHAPES) {
    const url = shape(base, taskId);
    try {
      const res = await send(
        { provider: providerId, label: `${label}·探查询路径`, method: 'GET', url, timeoutMs: 20000 },
        null
      );
      // 404/405 说明路径不对，继续试；其他状态（哪怕任务还在跑）说明路径是对的
      if (res.status !== 404 && res.status !== 405) {
        queryUrlCache.set(cacheKey, shape);
        onEvent?.({ type: 'note', message: `查任务路径：${url.replace(taskId, '…')}` });
        return url;
      }
    } catch {
      /* 连不上就试下一个 */
    }
  }
  throw new Error(
    `${label}：任务提交成功（${taskId}），但没试出查询任务的接口路径。` +
      `请到「API 联调台」用这家的「查任务状态」模板手动确认路径，再告诉我改一下。`
  );
}

/**
 * 海螺（MiniMax）的图生视频：三步。
 *
 *   ① POST /video_generation          → task_id
 *   ② GET  /query/video_generation    → status；成功后给 file_id
 *   ③ GET  /files/retrieve?file_id=…  → download_url
 *
 * 比别家多出第③步，所以不能套通用的 taskPoll（那个假设轮询响应里就有 URL）。
 * 新版接口据说也可能在第②步直接给 url —— 两种都接住，有 url 就跳过第③步。
 *
 * 还有个坑：海螺把业务错误放在 base_resp 里，HTTP 状态仍然是 200。
 * 只看 res.ok 会把失败当成功，然后在"找不到 URL"处报一个莫名其妙的错。
 */
async function generateVideoMiniMax({
  provider,
  providerId,
  model,
  prompt,
  firstFrameUrl,
  refImages,
  duration,
  requestedDuration,
  allowed,
  resolution,
  aspectRatio = '16:9',
  timeoutMs,
  label,
  onEvent
}) {
  const checkBiz = (res, step) => {
    if (!res.ok) fail(`${label}·${step}`, res);
    const base = res.json?.base_resp;
    if (base && base.status_code !== 0) {
      throw new Error(`${label}·${step} 失败：${base.status_msg}（code ${base.status_code}）`);
    }
    return res.json;
  };

  // ① 提交。H3 和 Hailuo 系的请求结构不是一回事，按模型名分流。
  const isH3 = /(^|[-_])H3([-_]|$)/i.test(model);
  const vd = provider.videoDefaults || {};
  let body;

  if (isH3) {
    // H3 是全模态：content[] 里按 type 区分 text / image_url / video_url / audio_url，
    // 最多收 9 张图。对一致性引擎是实打实的利好 ——
    // 首帧 + 角色设定图 + 场景基准图可以一起送，不用二选一。
    const content = [{ type: 'text', text: prompt }];
    const images = [firstFrameUrl, ...refImages].filter(Boolean).slice(0, 9);
    for (const url of images) content.push({ type: 'image_url', image_url: { url } });
    body = { model, content, duration, resolution };
    // 中转家（如秘塔）多要一个 ratio 字段，官方 H3 没有
    if (vd.ratio) body.ratio = aspectRatio;
  } else {
    body = { model, prompt, duration, resolution };
    if (firstFrameUrl) body.first_frame_image = firstFrameUrl;
    // S2V 系列用主体参考锁人设，是 Hailuo 这边一致性最好的一条路
    if (refImages.length && /S2V/i.test(model)) {
      body.subject_reference = [{ type: 'character', image_file: refImages[0] }];
    }
  }

  const created = checkBiz(
    await send(
      {
        provider: providerId,
        label: `${label}·提交`,
        method: 'POST',
        url: endpoint(provider, 'videoCreate', '{{baseUrl}}/video_generation'),
        body,
        timeoutMs: 60000
      },
      onEvent
    ),
    '提交'
  );

  const taskId = created.task_id || created.data?.task_id;
  if (!taskId) throw new Error(`${label}：提交后没拿到 task_id`);
  onEvent?.({ type: 'note', message: `海螺任务已提交：${taskId}` });

  // ② 轮询。中转家往往不写查任务的路径，所以第一次先探出正确的那个。
  const queryUrl = await resolveQueryUrl(provider, providerId, taskId, label, onEvent);
  const finalStatus = await poll(
    async (attempt) => {
      const res = await send(
        {
          provider: providerId,
          label: `${label}·轮询 #${attempt}`,
          method: 'GET',
          url: queryUrl,
          timeoutMs: 30000
        },
        null
      );
      const json = checkBiz(res, '轮询');
      const state = String(json.status || json.data?.status || '').toLowerCase();
      onEvent?.({ type: 'poll', attempt, state });
      if (['success', 'succeeded', 'finished'].includes(state)) return { done: true, value: json };
      if (['fail', 'failed'].includes(state)) throw new Error(`${label}：任务失败（${state}）`);
      return { done: false, value: json };
    },
    { intervalMs: settings.get('pollIntervalMs'), timeoutMs }
  );

  // ③ 取下载地址（第②步已经给了 url 就跳过）
  let url = firstMediaUrl(finalStatus, { extensions: ['.mp4', '.mov'] }) || firstMediaUrl(finalStatus);
  if (!url) {
    const fileId = finalStatus.file_id || finalStatus.data?.file_id;
    if (!fileId) throw new Error(`${label}：任务成功但既没有 URL 也没有 file_id`);
    onEvent?.({ type: 'note', message: `取下载地址（file_id ${fileId}）…` });
    const fileUrl = endpoint(provider, 'fileRetrieve', '{{baseUrl}}/files/retrieve');
    const fileJson = checkBiz(
      await send(
        {
          provider: providerId,
          label: `${label}·取文件`,
          method: 'GET',
          url: `${fileUrl}?file_id=${encodeURIComponent(fileId)}`,
          timeoutMs: 60000
        },
        onEvent
      ),
      '取文件'
    );
    url = fileJson.file?.download_url || firstMediaUrl(fileJson);
  }
  if (!url) throw new Error(`${label}：没能拿到视频下载地址`);

  // 海螺的下载地址只活 9 小时，所以上层必须立刻落盘 —— 它本来就是这么做的
  onEvent?.({ type: 'note', message: '拿到下载地址（9 小时后失效，正在落盘）' });
  return {
    url,
    actualDuration: duration,
    requestedDuration,
    allowedDurations: allowed,
    resolution,
    raw: finalStatus
  };
}

// ──────────────────────────────── 配音 ────────────────────────────────

export async function synthesizeSpeech({
  providerId,
  model,
  text,
  voice = 'Cherry',
  timeoutMs = 120000,
  label = '配音'
}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);

  if ((provider.family || '') === 'dashscope') {
    const res = await send(
      {
        provider: providerId,
        label,
        method: 'POST',
        url: endpoint(provider, 'tts', '{{baseUrl}}/api/v1/services/aigc/multimodal-generation/generation'),
        body: { model, input: { text, voice } },
        timeoutMs
      },
      null
    );
    if (!res.ok) fail(label, res);
    const url = firstMediaUrl(res.json, { extensions: ['.wav', '.mp3'] }) || firstMediaUrl(res.json);
    if (!url) throw new Error(`${label}：响应里没有音频 URL`);
    return { url, raw: res.json };
  }

  // OpenAI 兼容家族的 /audio/speech 直接回二进制，交给上层用 fetch 落盘
  return {
    url: null,
    binaryRequest: {
      provider: providerId,
      method: 'POST',
      url: `${baseUrlOf(provider)}/audio/speech`,
      body: { model, input: text, voice, response_format: 'mp3' }
    }
  };
}

/** 当前设置下，各能力实际会用哪家哪个模型 —— 界面上要显示，出错时也好排查 */
export function resolvedRouting() {
  const s = settings.all();
  return {
    chat: { provider: s.chatProvider, model: s.chatModel },
    vision: { provider: s.visionProvider, model: s.visionModel },
    image: { provider: s.imageProvider, model: s.imageModel },
    video: { provider: s.videoProvider, model: s.videoModel },
    tts: { provider: s.ttsProvider, model: s.ttsModel }
  };
}
