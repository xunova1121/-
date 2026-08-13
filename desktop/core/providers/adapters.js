/**
 * 统一媒体能力适配层。
 *
 * 上层（一致性引擎、Studio 流水线）只说"我要一张图/一段视频"，
 * 各家协议的差异全压在这一层里。加一家新厂商，改这里的 switch 就够了，
 * 流水线一行不用动。
 *
 * 各家踩过的坑写在对应分支的注释里 —— 这些都是联调时最费时间的部分。
 */
import { getProvider } from './catalog.js';
import { allowedDurations, alignDuration } from '../duration.js';
import { send, sendAsync, baseUrlOf, interpolate, diagnose } from './index.js';
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
  size = '1280*720',
  seed = null,
  refImages = [],
  timeoutMs = 300000,
  label = '出图',
  onEvent = null
}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);
  const family = provider.family || 'openai';

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
  resolution = '720P',
  aspectRatio = '16:9',
  timeoutMs = 600000,
  label = '出视频',
  onEvent = null
}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);
  const family = provider.family || 'openai';
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

  let spec;
  switch (family) {
    case 'dashscope':
      spec = {
        url: endpoint(provider, 'i2v', '{{baseUrl}}/api/v1/services/aigc/video-generation/video-synthesis'),
        headers: { 'X-DashScope-Async': 'enable' },
        body: {
          model,
          input: { prompt, img_url: firstFrameUrl || refImages[0] },
          parameters: { resolution, duration: actualDuration }
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
          aspect_ratio: aspectRatio
        }
      };
      break;

    default: {
      // 火山方舟 Seedance：参数不走独立字段，而是拼在 text 里的 --key value
      const flags = `--resolution ${resolution.toLowerCase()} --dur ${actualDuration} --ratio ${aspectRatio}`;
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
  return { url, actualDuration, requestedDuration: duration, allowedDurations: allowed, raw: polled?.json ?? submitted.json };
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
