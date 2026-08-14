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
import { buildAuthHeaders } from './auth.js';
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

/**
 * 解析一个接口地址。优先级：用户在界面上填的 > 目录里写的 > 兜底默认。
 * 中转平台的路径经常和官方对不上，让用户能自己改是最快的一条路。
 */
function endpoint(provider, key, fallback) {
  const override = settings.get('endpointOverrides')?.[`${provider.id}.${key}`];
  const raw = override || provider.endpoints?.[key] || fallback;
  return interpolate(raw, provider);
}

/**
 * 百炼这一族只认公网 URL，不收 base64 内联图。
 *
 * 而本应用默认把本地图转成 data URI 交给模型（Windows 用户不必先去开一个 OSS 桶）——
 * 两者一撞，任务会**提交成功**然后在轮询里以 InvalidParameter 失败，
 * 白等一轮，报错里也看不出是这个原因。所以在发出去之前就拦下来，把出路说清楚。
 */
function requirePublicUrl(url, label, what) {
  if (!url || !String(url).startsWith('data:')) return;
  throw new Error(
    `${label}：阿里云百炼的${what}只认**公网 URL**，不收 base64 内联图，而这里给的是本地图转的 data URI。\n` +
      `两条路：\n` +
      `① 在「设置 → 图片上传网关」里填一个接收 multipart 上传、返回 {url} 的接口（自建图床或 OSS 直传），` +
      `配好之后镜头图会先上传再把公网地址交给百炼；\n` +
      `② 把这条能力换成收 base64 的那几家 —— 火山方舟、秘塔、MiniMax 都可以。`
  );
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

/** 当前路由到的视频模型接受哪些时长档位。界面用它提前提示，不用等跑完才知道。 */
export function routedVideoDurations() {
  const r = resolvedRouting();
  const provider = getProvider(r.video?.provider);
  if (!provider) return [];
  return allowedDurations(provider, r.video.model);
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
        requirePublicUrl(refImages[0], label, '参考图生图');
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

  /**
   * 各家收几张图差得很远，超了不是"多的被忽略"，而是**整个任务提交失败**：
   * 方舟 Seedance 只认 1 张首帧（首尾帧模式 2 张且要带 role），可灵、万相也是 1 张，
   * Vidu 收 3 张，H3 收 9 张。
   *
   * 设定集参考图是按"能带多少带多少"给过来的，所以在这里按厂商上限截断，
   * 并且明确告诉用户被截掉了几张、一致性改由什么承担 ——
   * 悄悄丢掉会让人以为参考图生效了，悄悄全发出去则会让整步一直失败。
   */
  const maxImages = provider.videoDefaults?.maxImages ?? 4;
  const allImages = [firstFrameUrl, ...refImages].filter(Boolean);
  const images = allImages.slice(0, maxImages);
  if (allImages.length > images.length) {
    onEvent?.({
      type: 'note',
      message: `${provider.name} 这一步最多收 ${maxImages} 张图，已带上首帧，另外 ${
        allImages.length - images.length
      } 张设定集参考图这次不发（${provider.videoDefaults?.refNote || '一致性由首帧图和提示词里的冻结设定承担'}）`
    });
  }
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

  // OpenAI 的视频不走 chat 那套协议，自己一条路
  if (provider.videoApi === 'openai-videos') {
    return generateVideoOpenAI({
      provider,
      providerId,
      model,
      prompt,
      images,
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
      images,
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
      // 百炼只认公网 URL，不收 base64 内联图。不先拦一下的话，
      // 任务会提交成功、然后在轮询里以 InvalidParameter 失败 ——
      // 白等一轮，报错还看不出是这个原因。
      requirePublicUrl(images[0], label, '图生视频');
      spec = {
        url: endpoint(provider, 'i2v', '{{baseUrl}}/api/v1/services/aigc/video-generation/video-synthesis'),
        headers: { 'X-DashScope-Async': 'enable' },
        body: {
          model,
          input: { prompt, img_url: images[0] },
          parameters: { resolution: finalResolution, duration: actualDuration }
        }
      };
      break;

    case 'kling':
      spec = {
        url: endpoint(provider, 'i2v', '{{baseUrl}}/v1/videos/image2video'),
        body: {
          model_name: model,
          image: images[0],
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
          images: useRef ? images : [images[0]],
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
      for (const img of images) {
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

/** 清掉探出来的查询路径缓存。改了 baseUrl 或手填了地址之后要用，自检也要用。 */
export function resetQueryUrlCache() {
  queryUrlCache.clear();
}

/**
 * 查任务的候选写法，按命中概率排序。
 *
 * 第一条是 MiniMax v2 官方文档写明的那条：
 *   GET {base}/query/video_generation/{task_id}   →   {"task":{"status":…,"content":{"url":…}}}
 * 注意 **task_id 是路径段，不是查询参数** —— 这是踩过的坑：
 * 拿 `?task_id=` 那种写法去问 v2，中转平台会把它当成未知路径裸转发给上游，
 * 上游拿我们的中转 key 当然不认，回一句 `login fail …(1004)`。
 * 于是"路径不对"被伪装成了"密钥不对"。
 *
 * 第二条是给那些 baseUrl 还停在 /v1、但用的是 v2 模型（H3）的情况兜底。
 * 后面几条是各家中转的自创写法，见一个记一个。
 */
const QUERY_SHAPES = [
  (base, id) => `${base}/query/video_generation/${encodeURIComponent(id)}`,
  (base, id) => `${base.replace(/\/v1$/, '/v2')}/query/video_generation/${encodeURIComponent(id)}`,
  (base, id) => `${base}/video_generation/${encodeURIComponent(id)}`,
  (base, id) => `${base}/query/video_generation?task_id=${encodeURIComponent(id)}`,
  (base, id) => `${base}/video_generation?task_id=${encodeURIComponent(id)}`,
  (base, id) => `${base}/tasks/${encodeURIComponent(id)}`,
  (base, id) => `${base}/task/${encodeURIComponent(id)}`,
  (base, id) => `${base}/video_generation/query?task_id=${encodeURIComponent(id)}`,
  (base, id) => `${base}/query?task_id=${encodeURIComponent(id)}`
];

/**
 * 这段 body 是不是在报错。
 *
 * 国内这一圈网关有个共同脾气：**HTTP 200，错误藏在 body 里**。
 * 秘塔就回过这个：
 *   {"type":"error","error":{"type":"authorized_error",
 *    "message":"login fail: ... (1004)","http_code":"401"}}
 * 不认这种的话，轮询会把它当成"任务还没好"，一直等下去。
 */
export function bodyError(json) {
  if (!json || typeof json !== 'object') return '';

  // MiniMax 家族：业务码放 base_resp
  if (json.base_resp && json.base_resp.status_code !== 0) {
    return `${json.base_resp.status_msg}（code ${json.base_resp.status_code}）`;
  }
  // {"type":"error","error":{...}} 这一族
  if (json.type === 'error' || json.error) {
    const e = json.error || {};
    const msg = e.message || e.msg || json.message || '';
    const code = e.http_code || e.code || e.type || '';
    if (msg) return `${msg}${code ? `（${code}）` : ''}`;
  }
  // {"code":1004,"msg":"..."} 这一族。注意 code 为 0 / "0" / "ok" 都算正常
  const code = json.code ?? json.errCode ?? json.err_code;
  const ok = code === undefined || code === null || code === 0 || code === '0' || code === 'ok';
  if (!ok) {
    const msg = json.msg || json.message || json.error_msg || '';
    if (msg) return `${msg}（code ${code}）`;
  }
  return '';
}

/** 这条报错是不是在说"密钥不对/没带上"——和"路径不对"完全是两回事 */
export function isAuthError(text) {
  return /401|403|unauthor|authoriz|login fail|api key|apikey|token|鉴权|密钥|未授权/i.test(String(text || ''));
}

/**
 * 从各家五花八门的响应里把状态词抠出来。
 *
 * 外面套一层是常事，而且套的名字各不相同：
 *   MiniMax v2 / 秘塔  {"task":{"id":…,"status":"succeeded","content":{"url":…}}}
 *   百炼               {"output":{"task_status":"SUCCEEDED"}}
 *   一堆中转           {"data":{"status":…}}
 * 少看一层就等于读不出状态，然后一路轮询到超时 —— 这个坑踩过一次，
 * 表现是"视频在厂商平台早就出好了，流水线还在转"。
 */
export function readTaskState(json) {
  const raw =
    json?.status ??
    json?.state ??
    json?.task_status ??
    json?.task?.status ??
    json?.task?.state ??
    json?.data?.status ??
    json?.data?.state ??
    json?.data?.task_status ??
    json?.output?.task_status ??
    json?.result?.status ??
    '';
  return String(raw || '').toLowerCase();
}

/**
 * 这段响应看着像不像"一条任务记录"。
 *
 * 光看 HTTP 200 是**不够**的 —— 这是踩出来的：中转平台常常对任何路径都回 200，
 * 首页、错误页、一个空对象都算。探路径时只要不是 404 就锁上，
 * 结果锁到一个跟任务毫无关系的地址，之后每次轮询都读到"没有状态"，
 * 一路轮到十分钟超时。用户那边看到的就是
 * "视频在厂商平台明明已经生成好了，流水线却一直转"。
 *
 * 所以判定改成看**内容**：提到了这个 task_id、或者有认得出的状态词、
 * 或者直接给了视频地址 —— 三者有其一才算数。
 */
function looksLikeTask(json, taskId) {
  if (!json || typeof json !== 'object') return false;
  if (taskId && JSON.stringify(json).includes(String(taskId))) return true;
  if (readTaskState(json)) return true;
  if (firstMediaUrl(json, { extensions: ['.mp4', '.mov'] })) return true;
  return false;
}

/** 带上 task_id 的错误：上层要靠它把"任务还在天上飘着"记到镜头里 */
function taskError(message, taskId) {
  const err = new Error(message);
  err.taskId = taskId;
  return err;
}

/** 把目录里声明的模板展开成一个具体地址 */
function expandShape(tpl, base, taskId) {
  let origin = base;
  try {
    origin = new URL(base).origin;
  } catch {
    /* baseUrl 不合法的话就退回原样，下面照样能拼 */
  }
  return tpl
    .replaceAll('{{baseUrl}}', base)
    .replaceAll('{origin}', origin)
    .replaceAll('{taskId}', encodeURIComponent(taskId));
}

async function resolveQueryUrl(provider, providerId, taskId, label, onEvent) {
  const base = baseUrlOf(provider);
  const configured =
    settings.get('endpointOverrides')?.[`${providerId}.videoQuery`] || provider.endpoints?.videoQuery;
  if (configured) {
    const resolved = interpolate(configured, provider);
    // 用户填的地址里可以自己带 {taskId}；没带就按最常见的写法追加 ?task_id=
    return resolved.includes('{taskId}')
      ? resolved.replace('{taskId}', encodeURIComponent(taskId))
      : `${resolved}${resolved.includes('?') ? '&' : '?'}task_id=${encodeURIComponent(taskId)}`;
  }

  // 缓存键带上 baseUrl：换了中转地址就该重新探，不能拿旧路径去套新家
  const cacheKey = `${providerId}::${base}`;
  const cached = queryUrlCache.get(cacheKey);
  if (cached) return cached(base, taskId);

  // 目录里给这家单独声明的写法排在通用候选前面 —— 中转平台常有自己的一套路径，
  // 通用清单猜不到，但它自己知道
  const shapes = [
    ...(provider.videoQueryShapes || []).map((tpl) => (b, id) => expandShape(tpl, b, id)),
    ...QUERY_SHAPES
  ];

  const tried = [];
  const authRejected = [];
  for (const shape of shapes) {
    const url = shape(base, taskId);
    try {
      const res = await send(
        { provider: providerId, label: `${label}·探查询路径`, method: 'GET', url, timeoutMs: 20000 },
        null
      );
      if (looksLikeTask(res.json, taskId)) {
        queryUrlCache.set(cacheKey, shape);
        onEvent?.({ type: 'note', message: `查任务路径：${url.replace(taskId, '…')}` });
        return url;
      }
      // 这个地址**存在**、只是不认我们的密钥 —— 和"路径不对"是两回事，
      // 混在一起报会让人去查错误的东西
      const said = bodyError(res.json);
      if (res.status === 401 || res.status === 403 || (said && isAuthError(said))) {
        authRejected.push(`${url.replace(taskId, '…')} → ${said || `HTTP ${res.status}`}`);
      }
      tried.push(
        `${url.replace(taskId, '…')} → HTTP ${res.status}${said ? `，${said}` : ''}${
          !said && res.json ? `，响应 ${JSON.stringify(res.json).slice(0, 100)}` : ''
        }`
      );
    } catch (err) {
      tried.push(`${url.replace(taskId, '…')} → ${err.message}`);
    }
  }
  // 全都被挡在鉴权外面 = 路径可能是对的，但这家查任务时要的密钥形式和提交时不一样。
  // 这种情况下让用户去改路径是南辕北辙，得直说是鉴权的问题。
  if (authRejected.length && authRejected.length === tried.length) {
    throw taskError(
      `${label}：任务提交成功（task_id ${taskId}），但每个查询地址都回"密钥不对"：\n  ${authRejected.join(
        '\n  '
      )}\n` +
        `注意提交那一步是通的，所以密钥本身没问题 —— 是这家**查任务时要的鉴权形式和提交时不一样**` +
        `（有的中转要把 key 放在 URL 参数里，有的只认 POST）。\n` +
        `到「API 联调台」用 task_id ${taskId} 试出能查通的写法，` +
        `再到「服务商与密钥 → 接口地址（高级）」把它填进「查视频任务」那一栏。\n` +
        `实在查不到也别急：片子多半已经在平台上出好了，` +
        `把地址复制过来用分镜卡片里的「手动补入」贴进去就行。`,
      taskId
    );
  }
  throw taskError(
    `${label}：任务提交成功（task_id ${taskId}），但没有一个候选路径能查到它。\n` +
      `试过这些：\n  ${tried.join('\n  ')}\n` +
      `任务本身多半在厂商那边跑着 —— 到「API 联调台」用 task_id ${taskId} 手动查一次，` +
      `把能查到的那个地址填到「服务商与密钥 → 接口地址（高级）→ 查视频任务」，填完立刻生效。\n` +
      `或者直接去平台上复制视频地址，用分镜卡片里的「手动补入」贴回来。`,
    taskId
  );
}

/**
 * 中转平台到底收几张图，只有它自己知道。
 *
 * 秘塔就是个例子：转的是 H3（官方 9 张），但它自己回
 * 「输入媒体数量超过限制 (2013)」—— 文档里没写几张算超。
 * 目录里那个 maxImages 只能算一个起点，猜高了整步一直失败，猜低了白白丢掉一致性。
 *
 * 所以按"试出来"处理：撞到数量上限就减半重试，直到只剩首帧。
 * 这种失败是**参数校验失败**，服务端还没开始出片，不产生费用，试几次不心疼。
 * 试出来的值按 服务商 + baseUrl 记住，同一批后面的镜头直接用，不再重复撞墙。
 *
 * 缓存的 key 带上 baseUrl：同一家换个中转地址，限制就可能不一样。
 */
const mediaLimitCache = new Map();

/** 这条报错是不是在说"图带多了" */
function isMediaLimitError(message) {
  return /媒体数量|输入媒体|媒体数|图片数量|number of (images|media)|media (count|number)|exceed.*(image|media)|2013/i.test(
    String(message || '')
  );
}

async function submitWithMediaBackoff({ providerId, provider, url, images, buildBody, checkBiz, label, onEvent }) {
  const key = `${providerId}::${baseUrlOf(provider)}`;
  const learned = mediaLimitCache.get(key);
  let count = learned ? Math.min(learned, images.length) : images.length;
  if (learned && images.length > learned) {
    onEvent?.({
      type: 'note',
      message: `这家之前试出来最多收 ${learned} 张图，本次直接按 ${learned} 张发`
    });
  }

  for (;;) {
    const imgs = images.slice(0, count);
    try {
      const json = checkBiz(
        await send(
          { provider: providerId, label: `${label}·提交`, method: 'POST', url, body: buildBody(imgs), timeoutMs: 60000 },
          onEvent
        ),
        '提交'
      );
      if (count < images.length) mediaLimitCache.set(key, count);
      return json;
    } catch (err) {
      if (!isMediaLimitError(err.message) || count <= 1) throw err;
      const next = Math.max(1, Math.floor(count / 2));
      onEvent?.({
        type: 'note',
        message: `服务端嫌图带多了（${count} 张），改成 ${next} 张重试 —— 这次失败是参数校验，没开始出片，不计费`
      });
      count = next;
    }
  }
}

/**
 * OpenAI 的视频（Sora）：自己一套，三步。
 *
 *   ① POST /videos              → {"id":"video_…","status":"queued"}
 *   ② GET  /videos/{id}         → queued / in_progress / completed / failed
 *   ③ GET  /videos/{id}/content → **直接回 mp4 二进制**
 *
 * 和别家最大的不同在第③步：别人给的是公网直链，拿着就能下；
 * 这里的地址必须**带着 Authorization** 才取得到。
 * 所以这里把鉴权头一路带回去交给落盘那一步 —— 少了它，
 * 下载会拿到一个 401 的 JSON，然后存成一个打不开的"mp4"。
 */
async function generateVideoOpenAI({
  provider,
  providerId,
  model,
  prompt,
  images,
  duration,
  requestedDuration,
  allowed,
  resolution,
  aspectRatio,
  timeoutMs,
  label,
  onEvent
}) {
  const ep = (key, fallback) => interpolate(provider.videoEndpoints?.[key] || fallback, provider);

  // Sora 收的是像素尺寸而不是 720p 这种档位，所以得让尺寸和画幅方向对上 ——
  // 竖屏短剧配了个 1280x720 出来，等于白出一条横片。
  const wantPortrait = (() => {
    const [w, h] = String(aspectRatio || '16:9').split(':').map(Number);
    return w && h ? h > w : false;
  })();
  const sizes = provider.videoDefaults?.resolutions || [];
  const isPortrait = (sz) => {
    const [w, h] = String(sz).split('x').map(Number);
    return w && h ? h > w : false;
  };
  let size = resolution;
  if (sizes.length && isPortrait(size) !== wantPortrait) {
    const match = sizes.find((sz) => isPortrait(sz) === wantPortrait);
    if (match) {
      onEvent?.({ type: 'note', message: `画幅是 ${aspectRatio}，尺寸从 ${size} 换成 ${match}` });
      size = match;
    }
  }

  const body = { model, prompt, seconds: String(duration), size };
  // 首帧参考图：JSON 里给 URL 或 data URI 都行
  if (images[0]) body.input_reference = images[0];

  const created = await send(
    { provider: providerId, label: `${label}·提交`, method: 'POST', url: ep('create', '{{baseUrl}}/videos'), body, timeoutMs: 60000 },
    onEvent
  );
  if (!created.ok) fail(`${label}·提交`, created);

  const id = created.json?.id;
  if (!id) throw new Error(`${label}：提交后没拿到视频任务 id（响应 ${JSON.stringify(created.json).slice(0, 200)}）`);
  onEvent?.({ type: 'note', message: `Sora 任务已提交：${id}` });

  const statusUrl = ep('status', '{{baseUrl}}/videos/{id}').replace('{id}', encodeURIComponent(id));
  const finalJson = await poll(
    async (attempt) => {
      const res = await send(
        { provider: providerId, label: `${label}·轮询 #${attempt}`, method: 'GET', url: statusUrl, timeoutMs: 30000 },
        null
      );
      const said = bodyError(res.json);
      if (said) throw taskError(`${label}：查任务失败 —— ${said}（id ${id}）`, id);

      const state = String(res.json?.status || '').toLowerCase();
      onEvent?.({ type: 'poll', attempt, state: state || '读不出状态', progress: res.json?.progress });
      if (state === 'completed') return { done: true, value: res.json };
      if (state === 'failed') {
        const why = res.json?.error?.message || '厂商未说明原因';
        throw taskError(`${label}：任务失败 —— ${why}（id ${id}）`, id);
      }
      return { done: false, value: res.json };
    },
    { intervalMs: settings.get('pollIntervalMs'), timeoutMs }
  );

  const contentUrl = ep('content', '{{baseUrl}}/videos/{id}/content').replace('{id}', encodeURIComponent(id));
  return {
    url: contentUrl,
    // 关键：这个地址不带密钥取不到，落盘时必须把头带上
    downloadHeaders: buildAuthHeaders(provider),
    actualDuration: Number(finalJson?.seconds) || duration,
    requestedDuration,
    allowedDurations: allowed,
    resolution: size,
    raw: finalJson
  };
}

/**
 * 只查一次某个任务，不轮询。
 *
 * 用在"待认领任务"上：任务当初提交成功了，但当时查不到状态（路径没探对、
 * 或者中转平台抽风），于是那一镜一直空着。与其让它烂在那儿，不如给一个
 * **零成本**的重查入口 —— 查一次不产生任何生成费用，而且用户如果刚在
 * 「接口地址（高级）」里填对了路径，这一下就能把所有待认领的任务一次性收回来。
 */
export async function queryTaskOnce({ providerId, taskId, label = '查任务', onEvent } = {}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);

  const url = await resolveQueryUrl(provider, providerId, taskId, label, onEvent);
  const res = await send(
    { provider: providerId, label: `${label}·查一次`, method: 'GET', url, timeoutMs: 30000 },
    null
  );

  const json = res.json || {};
  const said = bodyError(json);
  if (said) return { done: false, url: null, state: '', reason: said, queryUrl: url, raw: json };

  const state = readTaskState(json);
  const media = firstMediaUrl(json, { extensions: ['.mp4', '.mov'] }) || firstMediaUrl(json);
  const failed = ['fail', 'failed', 'error', 'canceled', 'cancelled'].includes(state);

  return {
    done: Boolean(media),
    url: media,
    state,
    failed,
    reason: failed ? `任务在厂商那边失败了（${state}）` : '',
    queryUrl: url,
    raw: json
  };
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
  images,
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
  const createUrl = endpoint(provider, 'videoCreate', '{{baseUrl}}/video_generation');

  const buildBody = (imgs) => {
    if (isH3) {
      // H3 是全模态：content[] 里按 type 区分 text / image_url / video_url / audio_url。
      // 官方收到 9 张，中转家常常收得更少 —— 具体几张由下面的退让逻辑试出来。
      const content = [{ type: 'text', text: prompt }];
      for (const url of imgs) content.push({ type: 'image_url', image_url: { url } });
      const b = { model, content, duration, resolution };
      // 中转家（如秘塔）多要一个 ratio 字段，官方 H3 没有
      if (vd.ratio) b.ratio = aspectRatio;
      return b;
    }
    const b = { model, prompt, duration, resolution };
    if (imgs[0]) b.first_frame_image = imgs[0];
    // S2V 系列用主体参考锁人设，是 Hailuo 这边一致性最好的一条路
    if (refImages.length && /S2V/i.test(model)) {
      b.subject_reference = [{ type: 'character', image_file: refImages[0] }];
    }
    return b;
  };

  const created = await submitWithMediaBackoff({
    providerId,
    provider,
    url: createUrl,
    images,
    buildBody,
    checkBiz,
    label,
    onEvent
  });

  const taskId = created.task_id || created.data?.task_id;
  if (!taskId) throw new Error(`${label}：提交后没拿到 task_id`);
  onEvent?.({ type: 'note', message: `海螺任务已提交：${taskId}` });

  // ② 轮询。中转家往往不写查任务的路径，所以第一次先探出正确的那个。
  const queryUrl = await resolveQueryUrl(provider, providerId, taskId, label, onEvent);
  // 连着几次读不出状态，就别再耗着了 —— 见下面 unknownShape 的说明
  let unknownShape = 0;
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

      // HTTP 200 但 body 里在报错 —— 国内网关的常见脾气。
      // 当成"任务还没好"会一直等下去；鉴权错更是等到天荒地老也不会变。
      const said = bodyError(json);
      if (said) {
        queryUrlCache.delete(`${providerId}::${baseUrlOf(provider)}`);
        throw new Error(
          isAuthError(said)
            ? `${label}：查任务时被拒了 —— ${said}\n` +
              `提交那一步是通的，所以密钥本身没问题，是这家**查任务要的鉴权形式和提交时不一样**。\n` +
              `到「API 联调台」用 task_id ${taskId} 试出能查通的写法，` +
              `再填到「服务商与密钥 → 接口地址（高级）→ 查视频任务」。`
            : `${label}：查任务失败 —— ${said}（task_id ${taskId}）`
        );
      }

      const state = readTaskState(json);

      /**
       * 读不出状态就别装作在等。
       *
       * 之前这里会一直轮到十分钟超时，界面上显示"轮询第 105 次（排队中）"——
       * 而任务在厂商那边早就出片了。真正的原因是这个地址根本不是任务查询接口，
       * 或者它的字段名我们不认识。连续几次都读不出来就停下来，
       * 把响应原样摊开，并且把探出来的路径作废，下次重新探。
       */
      if (!state && !firstMediaUrl(json, { extensions: ['.mp4', '.mov'] })) {
        unknownShape += 1;
        if (unknownShape === 1) {
          onEvent?.({
            type: 'note',
            message: `这个地址返回的内容里读不出任务状态，原样是：${JSON.stringify(json).slice(0, 200)}`
          });
        }
        if (unknownShape >= 3) {
          queryUrlCache.delete(`${providerId}::${baseUrlOf(provider)}`);
          throw new Error(
            `${label}：连查了 ${unknownShape} 次都读不出任务状态，不再空等。\n` +
              `查的地址：${queryUrl}\n` +
              `它返回的是：${JSON.stringify(json).slice(0, 300)}\n` +
              `任务多半在厂商那边跑着（task_id ${taskId}）。` +
              `到「API 联调台」拿这个 task_id 手动查一次，把真正能查到的地址告诉我，我写进目录里。`
          );
        }
      } else {
        unknownShape = 0;
      }

      onEvent?.({ type: 'poll', attempt, state: state || '读不出状态' });
      // 各家的终态词不统一：Success / succeeded / finished / done / completed 都见过。
      // 漏判一个，任务明明成了却一直轮询到超时 —— 用户看到的就是"生成了但不显示"。
      if (['success', 'succeeded', 'finished', 'done', 'completed', 'ok'].includes(state)) {
        return { done: true, value: json };
      }
      // v2 的状态词是 queued / running / succeeded / failed / cancelled
      if (['fail', 'failed', 'error', 'canceled', 'cancelled'].includes(state)) {
        throw new Error(
          `${label}：任务失败（${state}）${json.status_msg || json.message ? ` — ${json.status_msg || json.message}` : ''}`
        );
      }
      // 状态词不认识、但地址已经给出来了，就当成了 —— 中转平台经常自创状态词
      if (!state && firstMediaUrl(json, { extensions: ['.mp4', '.mov'] })) {
        onEvent?.({ type: 'note', message: '响应里没有状态字段，但已经能取到视频地址，按完成处理' });
        return { done: true, value: json };
      }
      return { done: false, value: json };
    },
    { intervalMs: settings.get('pollIntervalMs'), timeoutMs }
  );

  // ③ 取下载地址（第②步已经给了 url 就跳过）
  let url = firstMediaUrl(finalStatus, { extensions: ['.mp4', '.mov'] }) || firstMediaUrl(finalStatus);
  if (!url) {
    const fileId = finalStatus.file_id || finalStatus.data?.file_id;
    if (!fileId) {
      // 中转平台把地址塞在哪个字段，各家不一样。找不到时把响应原样带出来 ——
      // "任务成功了但界面上没有视频"这种问题，答案就在这段 JSON 里，
      // 只说一句"没拿到地址"等于让人去猜。
      throw new Error(
        `${label}：任务已成功，但响应里既没有视频 URL 也没有 file_id。` +
          `服务端返回的是：${JSON.stringify(finalStatus).slice(0, 400)}` +
          `\n把这段发给我，或者到「API 联调台」用这家的「查任务状态」模板手动看一眼是哪个字段。`
      );
    }
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
  if (!url) {
    throw new Error(
      `${label}：第三步取文件也没拿到下载地址。服务端返回的是：${JSON.stringify(finalStatus).slice(0, 400)}`
    );
  }

  // 海螺的下载地址只活 9 小时，所以上层必须立刻落盘 —— 它本来就是这么做的
  onEvent?.({ type: 'note', message: '拿到下载地址（9 小时后失效，正在落盘）' });
  // 厂商如实回了时长和分辨率就用它的 —— 界面上"模型实出"那一栏要的正是这个真实值
  const task = finalStatus.task || finalStatus.data || finalStatus;
  return {
    url,
    actualDuration: Number(task.duration) || duration,
    requestedDuration,
    allowedDurations: allowed,
    resolution: task.resolution || resolution,
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
