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
import * as comfy from './comfy.js';
import * as settings from '../settings.js';
import * as meter from '../meter.js';

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
 * 把画幅换算成**这个模型真的收得下**的尺寸。
 *
 * ── 为什么不能只有一张换算表 ──
 *
 * 各家对尺寸的约束差很远，而且违规时的表现是**最坏的那一种**：
 * 不报错，自己换一个尺寸出图。于是你选了 16:9，出来的是竖的或方的，
 * 请求记录里明明白白写着 1280x720，任务也"成功"了 —— 这种情况没法靠看日志查出来。
 *
 * 两类约束：
 *   enum  只收固定几个尺寸（OpenAI gpt-image-1、Seedream 3.0 那一类）
 *         → 在同方向里挑比例最接近的那个
 *   min/max 每边有上下限（Seedream 4.0 每边不低于 1280）
 *         → 按比例放大到落进区间，再对齐到 step
 *
 * 目录里没声明约束的，维持原样发预设尺寸 —— 不猜。
 */
export function fitImageSize(ratio, constraint, fallback) {
  const base = fallback || ratioToSize(ratio);
  if (!constraint) return base;
  const [rw, rh] = String(ratio || '16:9').split(':').map(Number);
  if (!rw || !rh) return base;
  const want = rw / rh;

  if (Array.isArray(constraint.enum) && constraint.enum.length) {
    const parse = (sz) => String(sz).split(/[*x×]/).map(Number);
    const sameSide = constraint.enum.filter((sz) => {
      const [w, h] = parse(sz);
      return w && h && (w > h) === (rw > rh) && (w === h) === (rw === rh);
    });
    const pool = sameSide.length ? sameSide : constraint.enum;
    return pool.reduce((best, cur) => {
      const [bw, bh] = parse(best);
      const [cw, ch] = parse(cur);
      return Math.abs(cw / ch - want) < Math.abs(bw / bh - want) ? cur : best;
    });
  }

  const min = Number(constraint.min) || 0;
  const max = Number(constraint.max) || 0;
  const step = Number(constraint.step) || 8;
  if (!min && !max) return base;

  // 短边顶到下限，长边跟着比例走；长边超上限就反过来压
  let w = rw >= rh ? (min * rw) / rh : min;
  let h = rw >= rh ? min : (min * rh) / rw;
  if (max) {
    const over = Math.max(w, h) / max;
    if (over > 1) {
      w /= over;
      h /= over;
    }
  }
  const round = (n) => Math.max(step, Math.round(n / step) * step);
  return `${round(w)}*${round(h)}`;
}

/** 这个模型声明的尺寸约束（目录里写，改厂商规则不用动代码） */
export function imageSizeConstraint(provider, model) {
  const entry = (provider?.models || []).find((m) => m.id === model);
  return entry?.imageSizes || provider?.imageSizes || null;
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
  /**
   * 走不走流式。**长生成一律该走**（拆分镜、出大纲、挑技法这些）。
   *
   * 默认关，是因为短调用（复核打分、绑说话人）走流式没有好处，
   * 只是多一层 SSE 解析。判据不是"重不重要"，是"要吐多少字"。
   */
  stream = false,
  /** 流式下多久没有新内容算死。见 http-client 里那段"慢和死是两回事"。 */
  /**
   * 多久没有新内容算死。
   *
   * ⚠ 90 秒对**思考型模型**是不够的。Claude 的 extended thinking、
   * o 系列这类模型在"想"的时候一个 token 都不吐，而中转站不会把思考过程
   * 转成 SSE —— 于是那几分钟在我们这边看来完全就是没动静。
   * 用户第二次撞上的多半就是这个：收到 1013 字节（刚开口）然后 90 秒静默。
   *
   * 所以默认放宽到 240 秒，并且做成可调 —— 中转站真死了的话多等两分钟，
   * 比把一次正在思考的调用误杀掉划算得多（误杀的代价是那次的钱白花，
   * 而且人会以为"这条路不通"而放弃）。
   */
  idleTimeoutMs = Number(settings.get('longIdleMs')) || 240000,
  onEvent = null,
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
  if (jsonMode && settings.get('jsonModeOff') !== true) {
    /**
     * 支持的厂商会严格输出 JSON；不支持的**通常**会忽略这个字段，
     * 所以下游仍然保留 extractJSON 的兜底解析。
     *
     * ⚠ "通常"两个字是有代价的。Anthropic 的原生接口里根本没有
     * response_format 这个参数，中转站把 OpenAI 协议翻译成 Anthropic 时
     * 遇上它可能直接卡住 —— 表现是**一个字节都不回**，而不是报错。
     * 所以给了一个开关（设置里的 jsonModeOff），碰上这种中转站能一键关掉。
     */
    body.response_format = { type: 'json_object' };
  }

  /**
   * ══════════ 长生成走流式 ══════════
   *
   * 拆分镜要吐几千 token 的 JSON。非流式的话，这几分钟里**连接上一个字节都没有** ——
   * 我们分不清"它在认真写"和"它已经死了"，只能等一个固定的总时长到点然后掐断。
   *
   * 真实事故：中转站 + Claude Opus，体检那一下几个 token、1.89 秒就回；
   * 真跑起来 180 秒到点被掐，一个字节都没收到。而"跑了 180 秒"本身不是问题 ——
   * 二十镜的分镜表出三四分钟很正常。
   *
   * 流式之后判据换成"多久没动静"：还在吐字就一直等，真停了才掐。
   * 顺带还有两个好处：界面上能看见它在动（那几分钟不再是一条僵住的进度条），
   * 以及中转站的响应更早开始 —— 很多中转站对非流式的长请求本来就有自己的超时。
   */
  const res = await send(
    {
      provider: providerId,
      label,
      method: 'POST',
      url: endpoint(provider, 'chat', '{{baseUrl}}/chat/completions'),
      body: stream ? { ...body, stream: true } : body,
      stream: stream || undefined,
      timeoutMs,
      // 空闲多久算死。给得比"模型思考一会儿"宽裕，比"人还愿意等"短
      idleTimeoutMs: stream ? idleTimeoutMs : 0,
      // 绝对上限兜底：对面一直发心跳却永远不结束时不至于挂到天荒地老
      maxTotalMs: stream ? Math.max(timeoutMs, idleTimeoutMs * 6) : 0
    },
    onEvent
  );
  if (!res.ok) fail(label, res);

  /**
   * ══════════ 流没收尾时，先看看收到的能不能用 ══════════
   *
   * 中转站有一种很常见的坏法：正文全发完了，但**不发 [DONE]、也不关连接**。
   * 从我们这边看就是"收到 27 万字节然后没动静了"，而那份内容其实是完整的。
   *
   * 用户真实撞上的就是这个：277463 字节 ≈ 4600 token 的正文，全是花过钱的，
   * 而我们连看都没看就整个丢掉，让他从头再跑一次、再花一次。
   *
   * 判据只有一个，而且是**验出来的不是猜出来的**：它能不能解析成 JSON。
   * 能 —— 就是完整的，照常用，只在日志里说一声流没收尾；
   * 不能 —— 才是真的断了，这时候报错才有底气说"没法用"。
   */
  if (res.incomplete) {
    const got = String(res.text || '');
    const usable = jsonMode ? looksCompleteJSON(got) : got.trim().length > 0;
    if (!usable) {
      /**
       * ⚠ **把收到的东西给人看**，不要只报一个字节数。
       *
       * 用户第二次报上来的是"收到 1013 字节后 90 秒没有新内容"——
       * 1013 字节 ≈ 18 个 token，也就是模型**刚开口就停了**。
       * 而光凭这个数字，我和他都只能猜：是中转站掐了？是模型在思考？
       * 还是它回了一句错误说明而不是 JSON？
       *
       * 这三种情况的下一步动作完全不同，而**收到的那点内容本身就是答案** ——
       * 它一直在日志里，但没人会为了看一句话专门去翻请求记录。
       * 报错里直接带上，一眼就分得清。
       */
      const peek = got.replace(/\s+/g, ' ').trim().slice(0, 200);
      const thinking = /think|reason|analysis/i.test(got) || got.trim().length < 40;
      throw new Error(
        `${label}：流开了个头就断了 —— 收到 ${res.incompleteBytes} 字节后 `
        + `${Math.round(res.incompleteIdleMs / 1000)} 秒没有新内容，而收到的这部分解析不出完整结果。\n`
        + `实际收到的是：「${peek}${got.length > 200 ? '…' : ''}」\n`
        + (thinking
          ? '收到的东西**非常少**，看起来模型刚开口就没声了。两种常见原因：\n'
            + '① 思考型模型（Claude 的 extended thinking、o 系列）在"想"的时候**一个字都不吐**，'
            + '而中转站不会把思考过程转成 SSE —— 于是那几分钟在我们看来就是没动静。'
            + '这种情况把「设置 → 长生成空闲上限」调大（比如 300 秒）就好了。\n'
            + '② 中转站在上游那边超时了，它自己先断的。这种调大没用，换个模型或换家中转。\n'
            + '分不清是哪种就看上面那句实际收到的内容：像 JSON 开头 = 它在写，是①；'
            + '像一句英文报错 = 是②。'
          : '这一段是真的不完整（已经验过了，不是猜的）。多半是中转站把连接掐了。\n'
            + '出分镜的话：先出大纲再拆分镜，那条路按场次分批，每批要写的东西少得多，不容易被掐。')
      );
    }
    onEvent?.({
      type: 'note',
      message: `⚠ 对面没有正常收尾（收到 ${res.incompleteBytes} 字节后停了），`
        + '但收到的内容能完整解析出来，这一次照常用 —— 没有白花钱。'
    });
  }

  /**
   * 记账就记在这里 —— 紧挨着解析响应的那一行。
   *
   * 不放在调用方（studio 里十几处），是因为那样每加一个新调用点都要记得
   * 补一行，而漏了不会红。这个应用里 modelUsed 和 refsSent 都是这么开始说谎的。
   */
  /**
   * ⚠ 流式的用量藏在**最后一个 SSE 事件**里，不在 res.json（那是 null）。
   *
   * 不挖的话，一开流式，token 那本账就全变成"漏账" —— 而且是静默的：
   * 用量表上少一大截，没有任何地方会红。今天刚为这类事修过两回。
   */
  const streamUsage = res.stream
    ? (() => {
      for (let i = (res.events || []).length - 1; i >= 0; i -= 1) {
        const d = res.events[i]?.data;
        if (!d || d === '[DONE]') continue;
        try {
          const got = meter.readTokenUsage(JSON.parse(d));
          if (got) return got;
        } catch {
          /* 不是 JSON 的事件跳过 */
        }
      }
      return null;
    })()
    : null;
  const usage = streamUsage || meter.readTokenUsage(res.json);
  if (usage) meter.record({ kind: 'token', provider: providerId, model, units: usage });
  else meter.blind({ kind: 'token', provider: providerId, model, why: '响应里没有可拆分进出的 usage' });

  /**
   * ⚠ **输出被截断了要当场说**，不能当成正常结果往下传。
   *
   * 模型吐到自己的上限时，返回的是 `finish_reason: "length"` —— 状态 200、
   * 没有任何错误字段，只是 JSON 从中间断掉。下游 extractJSON 有两种下场：
   *   解析失败 → 整批白跑，而报错说的是"模型没有返回合法 JSON"，
   *              让人以为是模型不听话，其实是话没说完
   *   碰巧解析出来 → **更糟**。你拿到一份少了后半截的分镜表，
   *              而且没有任何地方说它少了
   *
   * 拆分镜正是最容易撞上这个的一步（几十镜就是上万 token），
   * 所以这一层必须把它翻译成一句人能照着做的话。
   */
  const finish = res.stream
    ? lastFinishReason(res.events)
    : (res.json?.choices?.[0]?.finish_reason || res.json?.choices?.[0]?.finishReason || '');
  if (finish === 'length') {
    throw new Error(
      `${label}：模型的输出被自己的长度上限截断了（finish_reason=length），拿到的是半截内容，不能用。\n`
      + '这不是网络问题，也不是模型不听话 —— 是这一次要它写的东西超过了它一次能写的量。\n'
      + '出分镜的话：先出大纲再拆分镜，那条路会按场次分批，每批只拆几场，多长的剧本都不会撞上限。'
    );
  }

  const text =
    // 流式时正文是一段段拼起来的，res.json 是 null —— 拼好的在 res.text 里
    (res.stream ? res.text : null) ||
    res.json?.choices?.[0]?.message?.content ||
    res.json?.output?.choices?.[0]?.message?.content ||
    res.json?.output?.text ||
    '';
  if (typeof text !== 'string') {
    // 少数厂商把 content 也返回成数组
    return {
      text: Array.isArray(text) ? text.map((p) => p.text || '').join('') : '',
      raw: res.json,
      // 这一支原来漏了 usage。返回值形状不一致会让上层"有时拿得到有时拿不到"，
      // 而那种不一致找起来比没有还费劲
      usage: res.json?.usage || null
    };
  }
  return { text, raw: res.json, usage: usage || res.json?.usage || null };
}

/**
 * 这段文本里有没有一个**完整的** JSON 对象。
 *
 * 用真的解析，不用正则数括号 —— 括号计数在字符串里带 { } 时会算错，
 * 而分镜描述里带花括号完全可能。解析失败就是不完整，没有中间地带。
 *
 * 先整体试一次，不行再取最外层 {...} 试一次（模型爱在前后加一句话或代码块）。
 */
export function looksCompleteJSON(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    /* 往下再试一次 */
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return false;
  try {
    JSON.parse(s.slice(a, b + 1));
    return true;
  } catch {
    return false;
  }
}

/**
 * 流式响应里最后一个带 finish_reason 的事件说了什么。
 *
 * 截断的信号只在**最后几个事件**里，前面全是 delta。倒着找，找到就停。
 */
function lastFinishReason(events = []) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const d = events[i]?.data;
    if (!d || d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      const fr = j?.choices?.[0]?.finish_reason || j?.choices?.[0]?.finishReason;
      if (fr) return fr;
    } catch {
      /* 不是 JSON 的事件跳过 */
    }
  }
  return '';
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
/**
 * 把一张参考图取成字节 —— 本地 ComfyUI 要先把图传上去，LoadImage 才读得到。
 *
 * 我们手上的参考图有两种形态（见 studio.toModelRef）：配了对象存储时是
 * 一个公网地址，没配时是内联的 data: URI。两种都得能取。
 */
async function fetchRefBytes(ref) {
  const s = String(ref || '');
  const m = s.match(/^data:[^;]+;base64,(.*)$/);
  if (m) return Buffer.from(m[1], 'base64');
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`这张参考图既不是 data: 也不是 http(s)，取不到内容：${s.slice(0, 60)}`);
  }
  const res = await fetch(s);
  if (!res.ok) throw new Error(`取参考图失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 出一张图，顺带记账。
 *
 * ── 为什么记在外面包一层，而不是在四个 return 里各写一行 ──
 *
 * 下面那个 switch 有四条分支、四个 return（百炼、MiniMax、本地 ComfyUI、
 * OpenAI 兼容家族）。在每个 return 前面手工加一行记账，等于**四份重复**，
 * 而且以后加第五家的人不会知道还有这一步 —— 那家就会安静地不记账。
 *
 * 包在外面还有一个更要紧的好处：记的是**真的拿到图了**。
 * 抛异常的那些次一行账都不记，因为它们没出图。而如果记在 switch 里面、
 * 记在解析响应之前，失败的那些次也会被记上 —— 那就是虚报。
 *
 * 记的模型用的是 `used.model`（实际发出去的那个），不是入参 model ——
 * 带参考图时会自动切到图生图模型，切了之后账要记在切后的那个头上。
 * 这一条今天刚在 modelUsed 上栽过一次。
 */
export async function generateImage(args) {
  const result = await generateImageRaw(args);
  /** 一次调用出一张。没有 url 也没有 base64 的分支上面已经抛掉了。 */
  if (result?.url || result?.base64) {
    meter.record({
      kind: 'image',
      provider: args.providerId,
      model: result.used?.model || args.model,
      units: 1
    });
  }
  return result;
}

async function generateImageRaw({
  providerId,
  model,
  /**
   * 有参考图时改用的**图生图模型**。
   *
   * 这里曾经埋着一个把整层参考图机制悄悄废掉的 bug：
   * 带上 refImages 时代码只是往请求体里塞了个 `image` 字段，
   * **模型却还是文生图那个**（Seedream 3.0 t2i）。文生图模型不认这个字段，
   * 于是参考图被直接忽略 —— 一致性引擎最关键的第③层等于没接上，
   * 表现就是"出的图不像设定集，怎么调都不像"。
   *
   * 而目录里明明有 SeedEdit 3.0 i2i、设置里也有 imageEditModel 字段，
   * 只是从来没人去用它。现在有参考图就自动切过去。
   */
  editModel,
  prompt,
  negative = '模糊, 低质量, 畸变, 多余手指, 文字水印, 多人',
  size = null,
  aspectRatio = null,
  seed = null,
  refImages = [],
  timeoutMs = 300000,
  label = '出图',
  onEvent = null
}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);
  const family = provider.family || 'openai';
  // 画幅优先用这个项目自己的；项目没设才回落到全局设置
  const wantRatio = aspectRatio || settings.get('aspectRatio') || '16:9';
  if (!size) {
    const preset = ratioToSize(wantRatio);
    size = fitImageSize(wantRatio, imageSizeConstraint(provider, model), preset);
    // 比的是**数值**不是字符串：预设写成 1280*720、目录里的档位写成 1280x720，
    // 直接比字符串会把"没换"当成"换了"，于是每出一张图都要报一次假警
    const same = (a2, b2) => String(a2).replace(/[x×]/i, '*') === String(b2).replace(/[x×]/i, '*');
    if (!same(size, preset)) {
      // 换过尺寸必须说一声：不说的话，你在请求记录里看到的尺寸和你选的画幅对不上，
      // 会以为是这里算错了
      onEvent?.({
        type: 'note',
        message: `${model} 的尺寸有约束，${wantRatio} 按 ${size.replace('*', '×')} 出（预设的 ${preset.replace('*', '×')} 它收不下，硬发会被它自己换成别的比例）`
      });
    }
  }

  /**
   * 带了参考图 → 换成图生图模型。
   *
   * 只在这家真的支持 i2i、且配了图生图模型时才换；换不了的话如实说一声，
   * 别让人以为参考图生效了 —— 那正是这个 bug 最坑的地方：
   * 界面上写着"已带上 3 张设定集参考图"，实际一张都没起作用。
   */
  /**
   * 路由到的出图模型本身就是个**编辑模型**时提醒一声。
   *
   * SeedEdit / 通义万相 imageedit 这类是"拿一张图去改"的模型。
   * 把它选成「出图」那条路由、又没有参考图可给，它就只能自己发挥 ——
   * 出来的东西和你要的那一镜没什么关系。这种配置错误不会报任何错，
   * 只会让你觉得"这模型怎么乱画"，所以必须主动说出来。
   */
  const modelEntry = (provider.models || []).find((m) => m.id === model);
  if (modelEntry?.capability === 'i2i' && !refImages.length) {
    onEvent?.({
      type: 'note',
      message:
        `⚠ ${model} 是图生图（编辑）模型，而这次没有参考图给它 —— ` +
        '它只能自己发挥，画出来的多半不是你要的那一镜。' +
        '去「设置 → 能力路由 → 出图」换成文生图模型（带 t2i 的那些）。'
    });
  }

  const wantsRef = refImages.length > 0;
  const supportsI2I = (provider.capabilities || []).includes('i2i');
  /**
   * 三种意思要分清楚：
   *   不传        → 跟随「设置 → 图生图模型」（默认行为）
   *   传 null     → **明确不要换**。用户在卡片上专门挑了一个模型时走这条：
   *                 界面写着一个模型、实际发的是另一个，比参考图不生效更糟
   *   传具体模型  → 换成它
   */
  /**
   * ⚠ 记下**真正发出去的那个模型**，而不是调用方以为的那个。
   *
   * 下面有参考图时会把 model 换成图生图那个。原来换完就不吭声了 ——
   * 于是卡片上记的 modelUsed 是文生图那个，而图是图生图模型出的。
   *
   * 这个字段存在的理由是"中途换过模型是风格漂移最常见的原因"。
   * 它一旦说谎，那条诊断就废了：你对比两镜看到同一个模型名，
   * 而实际上一镜带参考图（走 i2i）、一镜没带（走 t2i），本来就是两个模型。
   */
  const used = { model, refsSent: 0 };
  const i2iModel = editModel === null ? null : editModel || settings.get('imageEditModel');
  if (wantsRef) {
    if (supportsI2I && i2iModel && i2iModel !== model) {  // eslint-disable-line no-lonely-if
      onEvent?.({ type: 'note', message: `带了 ${refImages.length} 张参考图，出图模型换成 ${i2iModel}（文生图模型不认参考图）` });
      model = i2iModel;
      used.model = i2iModel;
    } else if (!supportsI2I) {
      onEvent?.({
        type: 'note',
        message: `${provider.name} 不支持图生图，这 ${refImages.length} 张参考图发不出去 —— ` +
          '本镜的一致性只能靠提示词里的冻结描述撑着。要锁住脸就把「出图」换成支持图生图的一家。'
      });
      refImages = [];
      used.refsSent = 0;
    }
  }

  used.refsSent = refImages.length;

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
      // 百炼认的是 1280*720 这种星号写法；目录里的 enum 可能写成 x，统一一下
      const parameters = { size: String(size).replace(/x/i, '*'), n: 1 };
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
      return { used, url, base64: null, raw: polled?.json ?? submitted.json };
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
      return { used, url, base64, raw: res.json };
    }

    /**
     * ── 本地出图：ComfyUI ──
     *
     * 和别家的形状完全不同：没有"模型"这个参数，出什么图由**用户自己的
     * 工作流**决定。我们只往里填提示词、种子、尺寸、参考图。
     *
     * ⚠ 填不进去的每一样都要报上去（inject 回的 skipped）。
     * 最坏的一种坏法是"种子没填进去"：一致性复核不过时我们会换种子重试，
     * 而种子没生效的话三次重试出三张一模一样的图，日志上却写着"换了种子"。
     */
    case 'comfy': {
      const wf = comfy.parseWorkflow(settings.get('comfyWorkflow'));
      const base = baseUrlOf(provider).replace(/\/+$/, '');

      let refName = null;
      if (refImages.length) {
        const bytes = await fetchRefBytes(refImages[0]);
        refName = await comfy.uploadImage(base, bytes, `fd-ref-${Date.now()}.png`, { onEvent });
      }

      const [w, h] = String(size).split(/[x*]/i).map((n) => Number(n));
      const { workflow, filled, skipped } = comfy.inject(wf, {
        prompt, negative, seed, width: w, height: h, refName
      });
      /**
       * ⚠ 参考图**传上去了不等于用上了**。
       *
       * 工作流里没有 FD_REF 节点时，图传到了 ComfyUI，但没有任何节点读它 ——
       * 这一镜的一致性实际上只剩提示词撑着。
       *
       * 早上刚修过同一类错（modelUsed 记的是路由到的模型而不是真正出图那个），
       * 几小时后在这条新路上又犯了一次：refsSent 按"发过去几张"算，
       * 而不是按"真的接进工作流几张"。这个字段存在的全部理由就是
       * 回头能查"为什么这一镜不像"，它一说谎就没用了。
       */
      used.refsSent = filled.includes('参考图') ? refImages.length : 0;
      onEvent?.({ type: 'note', message: `本地出图：填进去了 ${filled.join('、')}（不花钱）` });
      for (const one of skipped) {
        onEvent?.({ type: 'note', message: `⚠ ${one}` });
      }

      const { url } = await comfy.run(base, workflow, { timeoutMs, onEvent });
      used.model = 'workflow';
      return { used, url, base64: null, raw: { local: true } };
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
      return { used, url, base64, raw: res.json };
    }
  }
}

// ──────────────────────────────── 出视频 ────────────────────────────────

/**
 * 出一段视频，顺带记账。
 *
 * ── 为什么按"回来的秒数"记，而不是下单时的秒数 ──
 *
 * 视频模型只出固定档（5/10、4/8）。要 4 秒，厂商给 5 秒，**按 5 秒计费**。
 * 记下单时那个 4，账就系统性地偏小 —— 而且是每一镜都偏，二十镜下来差一大截。
 * `actualDuration` 是各分支从响应里读出来（或对齐后确定）的那个数。
 *
 * ── 为什么失败的那次记成"漏账"而不是不记 ──
 *
 * 出视频是先下单后取件的。轮询超时、中途取消、拿不到结果，都不代表
 * 厂商没做也没计费 —— 多半是做了、计了，只是我们没接住。
 * 这种时候既不能记一个猜的秒数（假数），也不能当无事发生（少账），
 * 只能如实记一笔"这里有一次没记上"，让界面能说出来。
 */
export async function generateVideo(args) {
  let result;
  try {
    result = await generateVideoRaw(args);
  } catch (err) {
    meter.blind({
      kind: 'video',
      provider: args.providerId,
      model: args.model,
      why: '出视频没拿到结果（厂商那边可能已经出片并计费）'
    });
    throw err;
  }
  if (result?.url) {
    meter.record({
      kind: 'video',
      provider: args.providerId,
      model: result.usedModel || args.model,
      units: Number(result.actualDuration) || Number(args.duration) || 0
    });
  }
  return result;
}

/**
 * 图生视频 / 参考图生视频。
 *
 * refImages 有多张且厂商支持 r2v 时，优先走参考图通道 ——
 * Vidu 的 reference2video 能同时锁人物和场景，是目前跨镜头一致性最好的一条路。
 */
async function generateVideoRaw({
  providerId,
  model,
  prompt,
  firstFrameUrl = null,
  // 末帧：下一镜那张已经审过的图。给了它，这一段片子就会从 A 长到 B，
  // 切到下一镜时画面完全对齐 —— 衔接里唯一能做到"无缝"的一招。见 pipeline/continuity.js。
  lastFrameUrl = null,
  refImages = [],
  refVideos = [],
  duration = 5,
  resolution = null,
  aspectRatio = null,
  timeoutMs = 600000,
  label = '出视频',
  // 取消信号。只影响**轮询**，不打断已经发出去的提交 ——
  // 提交半路被掐是最坏的情况：可能已经计费，而 task_id 没拿到
  signal = null,
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
  /**
   * 末帧要不要发。
   *
   * 不是每家都收。**收不了的时候必须说出来**，不能默默降级成普通 i2v ——
   * 用户看到界面上标着"连续动作"，就会以为这两镜真的接上了，
   * 直到把成片放出来才发现中间有一跳，那时候钱已经花完了。
   */
  const endFrame = lastFrameUrl && provider.videoDefaults?.endFrame ? lastFrameUrl : null;
  if (lastFrameUrl && !endFrame) {
    onEvent?.({
      type: 'note',
      message:
        `${provider.name} 这一步不收末帧图，本镜按普通图生视频出 —— ` +
        '两镜之间会是硬切，不是无缝衔接。要无缝的话换一家收末帧的（可灵、Vidu、方舟）。'
    });
  }

  const maxImages = modelMaxImages(provider, model);
  // 末帧占一个名额，而且**优先于设定集参考图**：它是这两镜能不能对上的唯一保证，
  // 参考图只是让人别变样，后者可以靠首帧和提示词兜。
  const allImages = [firstFrameUrl, ...(endFrame ? [endFrame] : []), ...refImages].filter(Boolean);
  const capacity = endFrame ? Math.max(maxImages, provider.videoDefaults?.maxImagesWithEndFrame ?? maxImages) : maxImages;
  const picked = allImages.slice(0, capacity);
  /**
   * 末帧**不进普通图列表**。
   *
   * 收末帧的那几家都有专门的位置放它（海螺 / H3 的 last_frame_image、
   * 可灵的 image_tail、方舟的 role=last_frame、Vidu 的 start-end2video），
   * 下面每条分支也都是单独取 `endFrame` 用的。再把它留在 images 里，
   * 后果有两个，都不是小事：
   *
   *   · **同一张图发两遍**。走内联（没配对象存储）时白白多出一两 MB，
   *     而这条路恰恰就是被体积顶掉的那条 —— 用户那批片子的原话是
   *     "服务端拒了这 4 张图（合计 6.6MB，是内联发的）"。多出来的那份
   *     不但没用，还在把请求往上限外面推，然后我们照着减**参考图**。
   *   · H3 那条更糟：多出来的那一张**没有 role**，模型只会把它当成
   *     本镜的一张参考图 —— 等于把下一镜的画面掺进这一镜。
   *     日志上写着"锁成末帧"，实际做的是"顺便把下一镜也画进来"。
   *
   * 位置是固定的：allImages 就是按 [首帧, 末帧, 参考图…] 拼的。
   */
  const endSlot = endFrame ? (firstFrameUrl ? 1 : 0) : -1;
  const images = endSlot >= 0 && endSlot < picked.length
    ? picked.filter((_, i) => i !== endSlot)
    : picked;
  /**
   * 上限是 0 —— 这是个**文生视频模型**，一张图都不收。
   *
   * 这条必须单独说：选错模型时，前面出好的首帧图会被整个丢掉，
   * 而画面照样能出来，只是和分镜里那张完全不是一回事。
   * 不吭声的话，用户会以为"一致性做得不好"，其实是模型选错了。
   */
  if (capacity === 0 && allImages.length) {
    onEvent?.({
      type: 'note',
      message:
        `${model} 是文生视频模型，一张图都不收 —— 本镜的首帧图和 ${allImages.length - 1} 张参考图全都用不上，` +
        '画面只由提示词决定，和分镜里那张图不会是同一个。要接上首帧的话换一个图生视频模型（i2v）。'
    });
  } else if (allImages.length > picked.length) {
    onEvent?.({
      type: 'note',
      message: `${provider.name}·${model} 这一步最多收 ${capacity} 张图，已带上首帧${endFrame ? '和末帧' : ''}，另外 ${
        allImages.length - picked.length
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
      signal,
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
      signal,
      firstFrameUrl,
      lastFrameUrl: endFrame,
      refImages,
      refVideos,
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
          // 万相图生视频的画幅**跟着首帧图走**，这里不额外塞尺寸字段 ——
          // 百炼对未知参数是严格的，多给一个反而会把整个任务顶掉。
          // 所以这条路上"比例对不对"取决于首帧图，而首帧图出完就量过了（见 checkRatio）
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
          // 可灵管末帧叫 image_tail
          ...(endFrame ? { image_tail: endFrame } : {}),
          prompt,
          duration: String(actualDuration), // 可灵收的是字符串，不是数字
          // 画幅这一条以前整条路径都没发过 —— 竖屏项目会稳定地出成横片。
          // 图生视频时可灵通常跟着首帧图走，但显式给上更保险，也不至于在
          // 首帧图本身比例就不对时跟着一起错下去
          aspect_ratio: finalRatio,
          mode: 'std'
        }
      };
      break;

    case 'vidu':
      spec = {
        url: useRef
          ? endpoint(provider, 'r2v', '{{baseUrl}}/reference2video')
          : endFrame
            // Vidu 的首尾帧是另一条接口，images 里第一张是首帧、第二张是尾帧
            ? endpoint(provider, 'se2v', '{{baseUrl}}/start-end2video')
            : endpoint(provider, 'i2v', '{{baseUrl}}/img2video'),
        body: {
          model,
          images: useRef ? images : endFrame ? [images[0], endFrame] : [images[0]],
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
      if (endFrame) {
        // 方舟的首尾帧模式：两张图都要带 role 标明身份，不带的话会被当成两张参考图，
        // 而 Seedance 只收一张参考图 —— 于是整个任务直接提交失败
        content.push({ type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' });
        content.push({ type: 'image_url', image_url: { url: endFrame }, role: 'last_frame' });
      } else {
        for (const img of images) {
          content.push({ type: 'image_url', image_url: { url: img } });
        }
      }
      spec = {
        url: endpoint(provider, 'videoTasks', '{{baseUrl}}/contents/generations/tasks'),
        body: { model, content }
      };
    }
  }

  const { submitted, polled } = await sendAsync(
    { provider: providerId, label, method: 'POST', timeoutMs, pollSignal: signal, ...spec },
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
    /**
     * 末帧**到底有没有发出去**。
     *
     * 上层原来记的是 `Boolean(ctx.lastFrameUrl)` —— 那是**决定**发末帧，
     * 不是发成了。适配器这一层完全可能中途把它扔掉（写法被拒、体积超了），
     * 而那种情况下界面照样显示"这两镜是无缝的"。
     * 界面说谎比少一个功能糟糕得多，所以由发请求的这一层如实回报。
     */
    endFrameSent: Boolean(endFrame),
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
/**
 * 这一步能带几张图 —— **按模型问，不是按服务商问**。
 *
 * 同一家的不同模型差得可以很远：MiniMax 的 H3 收 9 张，同一家的海螺
 * 只吃 1 张首帧。按服务商取上限的后果，用户的日志里写得清清楚楚：
 *
 *     ※ 服务端嫌图带多了（5 张），改成 2 张重试
 *     ※ 服务端嫌图带多了（2 张），改成 1 张重试
 *     ※ 海螺任务已提交：2088852517485670400
 *
 * 每一镜都要**白撞两次墙**才发得出去。二十镜就是四十次白跑的往返，
 * 而这件事在目录里本来就是已知的 —— 只是没人问模型，只问了服务商。
 *
 * 兜底顺序：模型自己写的 > 服务商的天花板 > 4。
 * 用 `??` 不用 `||`：0 是合法答案（文生视频模型一张都不收），
 * 而 `||` 会把这个 0 当成"没写"，然后按 9 张发出去。
 */
export function modelMaxImages(provider, modelId) {
  const entry = (provider?.models || []).find((m) => m.id === modelId);
  return entry?.maxImages ?? provider?.videoDefaults?.maxImages ?? 4;
}

/** 请求体里到底放进去了几张图。只给报错文案用，数不准也不影响流程 */
function countImagesIn(body) {
  const text = JSON.stringify(body || {});
  return (text.match(/https?:\/\/|data:image\//g) || []).length;
}

const mediaLimitCache = new Map();

/**
 * 学来的上限**会过期**。
 *
 * 原来它是永久的，而那是个严重的错：一次偶发失败（某张图地址临时取不到、
 * 厂商抖了一下）会被归因成"图带多了"，然后这台服务**这辈子都按 1 张发** ——
 * 参考图少了一半以上，一致性跟着塌，而且没有任何报错，只是"最近出图不太像"。
 *
 * 用户截了秘塔控制台的图：参考素材那栏写着 `0/9`。也就是说我们学到的那个
 * "最多 1 张"从头到尾就是错的。降级必须是**可撤销**的，否则一次误判就是永久损失。
 *
 * 半小时后重新按满额试一次。真有限制的话最多多撞一次墙（参数校验失败，不计费）；
 * 而如果当初那次是偶发的，半小时后就自动恢复了。
 */
const LIMIT_TTL_MS = 30 * 60 * 1000;

export function rememberMediaLimit(key, count) {
  mediaLimitCache.set(key, { count, at: Date.now() });
}

export function learnedMediaLimit(key) {
  const hit = mediaLimitCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > LIMIT_TTL_MS) {
    mediaLimitCache.delete(key);
    return null;
  }
  return hit.count;
}

/**
 * 记住"这家厂商拉不到我们的桶"。
 *
 * 一部片子十几二十镜，如果每一镜都先撞一次 `cannot download media URL`
 * 再改内联，那就是十几次白跑的提交 —— 每次都要等厂商超时，慢得离谱，
 * 而且日志里全是失败，人根本看不出哪次是真出事了。
 *
 * 第一镜撞过之后就记下来，后面的镜直接走内联。和上限一样是**会过期的**：
 * 桶换了地域、CDN 配好了，半小时后自动回到"发地址"这条更省的路上。
 */
const unreachableCache = new Map();

export function rememberUrlUnreachable(key) {
  unreachableCache.set(key, Date.now());
}

export function urlUnreachable(key) {
  const at = unreachableCache.get(key);
  if (!at) return false;
  if (Date.now() - at > LIMIT_TTL_MS) {
    unreachableCache.delete(key);
    return false;
  }
  return true;
}

/** 只给自检和"重新试探"用 */
export function resetMediaLimits() {
  mediaLimitCache.clear();
  unreachableCache.clear();
}

/**
 * 这条报错是不是在说"图带多了"。
 *
 * ⚠ `2013` 必须当**错误码**匹配，不能裸着匹配 —— 裸的话，报错里出现
 * "2013" 这四个数字的任何地方（时间戳、任务号、年份）都会被当成
 * "图太多"，于是把一次完全不相干的失败学成永久降级。
 * 这类"匹配得太宽"的判断，出错时看起来永远像是别的问题。
 */
function isMediaLimitError(message) {
  const m = String(message || '');
  /**
   * ⚠ **2013 不是"图太多"** —— 厂商原话是 `cannot download media URL (2013)`，
   * 它抱怨的是自己取不到我们给的地址。
   *
   * 之前把 2013 当成数量超限，后果是一连串做在错地方的补救：
   * 自动减半重试 → 减到 1 张照样失败（地址还是取不到）→ 把"最多 1 张"
   * 记了下来 → 从此每一镜只带 1 张参考图，一致性塌了一半，而且不报任何错。
   *
   * 一个指错方向的判断，会让后面每一个动作都做在错的地方。
   * 所以这里只认**明确在说数量**的那些话，不认厂商的私有错误码。
   */
  if (/cannot\s+download|download\s+media/i.test(m)) return false;
  return /媒体数量|输入媒体数量|图片数量|number of (images|media)|media (count|number)|exceed.*(image|media)/i.test(m);
}

/**
 * 厂商说"下不到这张图"时，**我们自己去拉一次**。
 *
 * 这一步把猜测变成事实，而且答案指向完全不同的两个方向：
 *
 *   我们也拉不到  → 是我们这边的问题：地址不是公网的、签名过期了、桶是私有的
 *   我们拉得到    → 是厂商那边够不着：跨境、地域限制、它的出口被挡
 *
 * 这两种情况的下一步动作毫不相干，而单看那句 `cannot download media URL`
 * 是分不出来的 —— 人只能瞎试。一次 HEAD 请求换掉一整轮瞎试，很划算。
 * 只在**已经失败**时才做，正常路径上一次都不发。
 */
/**
 * 把几个公网地址下下来，变成内联图。
 *
 * 回 `{ images }` 表示绕得过去；回 `{ failedUrl }` 表示绕不过去，
 * 而且**指名是哪一张**卡住的 —— 调用方要拿它去做诊断（见下面为什么）。
 *
 * 太大的话绕过去也是白绕：内联几十 MB 只会换来一次超时（见 trimInlineImages）。
 */
async function inlineFromUrls(urls, onEvent) {
  const list = (urls || []).filter((u) => /^https?:/i.test(String(u)));
  if (!list.length) return { failedUrl: null };

  const out = [];
  let total = 0;
  for (const [i, u] of list.entries()) {
    let res;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(u, { signal: AbortSignal.timeout(30000) });
    } catch (err) {
      /**
       * 这一句以前是没有的 —— 拉不到就默默回 null，然后走去报原来那个错。
       *
       * 而那条路会生成一句**和事实相反**的话：诊断只探 images[0]，
       * 所以第 1 张好、第 3 张坏的时候，用户读到的是"我们这边拉得到，
       * 是厂商够不着"。他会照着这句去查跨境、查 CDN、甚至重建对象存储桶，
       * 而真正坏掉的是第 3 张图。
       *
       * 指名道姓说是第几张，比"拉不到"三个字值钱得多。
       */
      onEvent?.({ type: 'note', message: `想改成内联图绕过去，但第 ${i + 1} 张我们自己也下不下来（${err.message}）—— 这条路走不通` });
      return { failedUrl: u };
    }
    if (!res.ok) {
      onEvent?.({ type: 'note', message: `想改成内联图绕过去，但第 ${i + 1} 张我们自己也下不下来（HTTP ${res.status}）—— 这条路走不通` });
      return { failedUrl: u };
    }
    // eslint-disable-next-line no-await-in-loop
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || 'image/png';
    total += Math.ceil((buf.length * 4) / 3);
    if (total > INLINE_BUDGET) {
      onEvent?.({
        type: 'note',
        message: `想改成内联图绕过去，但这几张加起来超过 ${(INLINE_BUDGET / 1048576).toFixed(0)}MB，内联发只会换来一次超时 —— 不绕了`
      });
      return { failedUrl: null };
    }
    out.push(`data:${type};base64,${buf.toString('base64')}`);
  }
  onEvent?.({ type: 'note', message: `厂商拉不到我们的地址，改把图下下来内联发（共 ${out.length} 张，${(total / 1048576).toFixed(1)}MB）` });
  return { images: out };
}

async function probeMediaUrl(url) {
  if (!url) return '（这一镜没带参考图，问题不在图上）';
  if (String(url).startsWith('data:')) {
    return '我们发的是内联图（data URI），而这家只收公网地址 —— 去「设置 → 对象存储」配一个，或者填一个上传网关。';
  }
  try {
    const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(15000) });
    if (res.ok || res.status === 206) {
      /**
       * 这句话要说得比原来保守。
       *
       * 这个探测是**从跑着这个应用的机器上**发出去的，而多数人的桶和应用
       * 在同一片机房里（我们自己就是：应用在香港，桶也在香港）。同机房拉得到
       * 几乎必然成立，它证明不了"地址是公网可达的"—— 只证明了"我们够得着"。
       * 把它说成"地址本身是好的"，会让人放心地不去查桶权限，而那恰恰是最常见的原因。
       */
      return (
        `我们这边拉得到（HTTP ${res.status}）—— 但我们是从跑着这个应用的机器上拉的，` +
        `如果桶和应用在同一片机房，这一条几乎必然成立，证明不了地址在公网上可达。` +
        `两种可能：① 桶不是公共读、限时地址厂商用不了；② 地址是好的，但厂商那边够不着（桶在境外而厂商在境内，或它的出口被挡）。` +
        `把这个地址复制到手机流量下的无痕窗口里打开一次，就能分清是哪一种 —— 打不开是①，打得开是②。`
      );
    }
    if (res.status === 403) {
      return '我们这边也是 403 —— 多半是限时地址过期了，或者桶是私有的而签名不被接受。「设置 → 对象存储」里把有效期调长，或者把桶设成公共读。';
    }
    return `我们这边也拉不到（HTTP ${res.status}）—— 先把这个地址在无痕窗口里打开确认一下。`;
  } catch (err) {
    return `我们这边也拉不到（${err.message}）—— 这个地址不是公网可达的。`;
  }
}

/**
 * 内联图（base64）按**总体积**卡，不按张数卡。
 *
 * 张数上限管的是厂商收不收得下；体积管的是这个请求发不发得出去 ——
 * 两回事。参考图上限提到 9 张之后，一旦走内联兜底（没配对象存储时），
 * 请求体一下子几十 MB：光上传就超过任何合理的超时，而失败的样子是
 * "请求超时"，完全看不出是体积问题。
 *
 * base64 还会再胀三分之一，所以这里卡的是编码后的实际字节数。
 * 8MB 是个经验值：多数厂商的请求体上限在 10~20MB 之间，留出余量。
 */
const INLINE_BUDGET = 8 * 1024 * 1024;

/**
 * @param reserved 不在 images 里、但**照样占请求体**的那张图（末帧）。
 *                 末帧走各家的专门字段，不进普通图列表 —— 可它的字节数
 *                 是实打实要发出去的。不把它算进预算的话，这里以为还剩
 *                 两三 MB，实际早就超了，然后失败在厂商那一侧，
 *                 而我们给出的解释会是"图带多了"（错的）。
 */
function trimInlineImages(images, onEvent, reserved = null) {
  const bytesOf = (u) => (String(u || '').startsWith('data:') ? String(u).length : 0);
  const reservedBytes = bytesOf(reserved);
  const inline = images.filter((u) => bytesOf(u) > 0);
  if (!inline.length && !reservedBytes) return images;

  const kept = [];
  // 末帧先占上位置：它是这两镜能不能接上的唯一保证，宁可少发参考图
  let used = reservedBytes;
  for (const img of images) {
    const size = bytesOf(img);
    if (size && used + size > INLINE_BUDGET && kept.length) break;
    kept.push(img);
    used += size;
  }
  if (kept.length < images.length) {
    const total = images.reduce((n, u) => n + bytesOf(u), 0) + reservedBytes;
    onEvent?.({
      type: 'note',
      message:
        `参考图是内联发的（没配对象存储），${images.length} 张` +
        (reservedBytes ? '加上末帧' : '') +
        `加起来 ${(total / 1048576).toFixed(1)}MB 太大，这次只发前 ${kept.length} 张` +
        (reservedBytes ? '（末帧照发 —— 它是这两镜能不能接上的唯一保证）' : '') + '。' +
        `配上「设置 → 对象存储」之后图会以地址形式发出去，就能把 ${images.length} 张全带上`
    });
  }
  return kept;
}

async function submitWithMediaBackoff({
  providerId, provider, model, url, images: rawImages, buildBody, checkBiz, label, onEvent,
  // 走专门字段发出去的末帧。不在 images 里，但请求体里有它
  reservedInline = null
}) {
  let images = trimInlineImages(rawImages, onEvent, reservedInline);

  // 这家上一镜就拉不到我们的桶，别再撞一次墙了，直接走内联（拉不动或太大就照旧发地址）。
  const reachKey = `${providerId}::${baseUrlOf(provider)}::urls`;
  if (urlUnreachable(reachKey) && images.some((u) => /^https?:/i.test(String(u)))) {
    const pre = await inlineFromUrls(images, onEvent);
    if (pre.images) images = pre.images;
  }
  /**
   * 学来的上限按 服务商 + 地址 + **模型** 记。
   *
   * 少了模型这一段，同一家里一个模型学到的数会扣到另一个模型头上：
   * 海螺试出"最多 1 张"之后，同一家的 H3 也跟着只发 1 张 ——
   * 而 H3 是这家唯一能靠多张参考图锁人设的模型，等于把它废掉了。
   * 一致性上的损失从来不会报错，只会让人觉得"最近出的图不太像"。
   */
  const key = `${providerId}::${baseUrlOf(provider)}::${model || ''}`;
  const learned = learnedMediaLimit(key);
  let count = learned ? Math.min(learned, images.length) : images.length;
  if (learned && images.length > learned) {
    onEvent?.({
      type: 'note',
      message:
        `${model} 在这家半小时内试出来最多收 ${learned} 张图，本次先按 ${learned} 张发` +
        `（如果厂商界面上写的比这多，多半是上次那个失败另有原因 —— 过半小时会自动重试满额）`
    });
  }

  for (;;) {
    const imgs = images.slice(0, count);
    const body = buildBody(imgs);
    try {
      const json = checkBiz(
        await send(
          { provider: providerId, label: `${label}·提交`, method: 'POST', url, body, timeoutMs: 60000 },
          onEvent
        ),
        '提交'
      );
      /**
       * 只有走**公网地址**时才把这个数记下来。
       *
       * 内联发的时候，"减到几张才过"量的是**体积**不是张数 ——
       * 把它当张数上限记住，等于用一个错误的结论去限制后面每一镜：
       * 配好对象存储之后本来能发 9 张，却因为这条记忆继续只发 1 张，
       * 而且不报任何错，只是"最近出的图不太像"。
       *
       * 学错的代价比不学大得多，所以这一条宁可不学。
       */
      const wasInline = imgs.some((u) => String(u).startsWith('data:'));
      if (count < images.length && !wasInline) rememberMediaLimit(key, count);
      return json;
    } catch (err) {
      /**
       * "下不到图"和"图带多了"是两件完全不同的事，补救动作也完全不同。
       * 减半重试对前者毫无用处（地址还是取不到），只会白等几轮，
       * 最后还留下一个错误的"这家只收 1 张"。所以这里直接停下来，
       * 并且把"到底是谁拉不到"查清楚再抛。
       */
      if (/cannot\s+download|download\s+media/i.test(err.message || '')) {
        /**
         * 厂商说它下不到我们给的地址。
         *
         * ── 先别急着报错，先想一件事 ──
         *
         * 如果**我们自己拉得到**这张图，那这个问题其实是可以绕过去的：
         * 把图**下下来，当内联图发过去**。厂商不需要能访问我们的桶 ——
         * 它只需要拿到那几个字节。
         *
         * 这一条在"桶在境外、厂商在境内"的场合特别值钱：那种情况下
         * 换地域要重建桶、重传所有素材，而这一镜现在就想出。
         * 报一句"把桶换到和厂商同一侧"是对的建议，但它救不了眼前这一镜。
         *
         * 只试一次，而且卡体积（内联发太大照样会超时 —— 那是另一个坑，
         * 上面 trimInlineImages 那段写着）。绕过去之后仍然要把
         * **长期的解法**说出来，否则每一镜都要多跑一趟这个弯路。
         */
        const inlined = await inlineFromUrls(imgs, onEvent);
        if (inlined.images) {
          try {
            const json = checkBiz(
              await send(
                { provider: providerId, label: `${label}·提交（改内联图）`, method: 'POST', url, body: buildBody(inlined.images), timeoutMs: 120000 },
                onEvent
              ),
              '提交'
            );
            rememberUrlUnreachable(reachKey);
            onEvent?.({
              type: 'note',
              message:
                '改成内联图发过去，成了 —— 厂商拉不到我们的桶，但它拿得到图本身。'
                + '这一镜不用重来。长期的解法还是把桶换到和厂商同一侧（境内厂商就用境内地域），'
                + '不然每一镜都要多绕这一趟，而且内联图多了会超时。'
            });
            return json;
          } catch (retryErr) {
            onEvent?.({ type: 'note', message: `改内联图也没成（${String(retryErr.message).slice(0, 120)}）` });
          }
        }

        /**
         * 诊断要探**真正卡住的那一张**，不是永远探第 1 张。
         *
         * 上面拉的时候已经知道是第几张坏了。这时候还去探 images[0]，
         * 就会在第 1 张好、第 3 张坏的情况下输出"我们这边拉得到，是厂商够不着" ——
         * 一句和事实相反的话，会把人送去查跨境和 CDN，而坏的是第 3 张图。
         */
        const verdict = await probeMediaUrl(inlined.failedUrl || images[0]);
        err.message = `${err.message}\n\n我们替你查了一下：${verdict}`;
        throw err;
      }
      if (!isMediaLimitError(err.message) || count <= 1) throw err;
      const next = Math.max(1, Math.floor(count / 2));
      /**
       * 减图之前先确认：**少发几张，请求体真的会变吗？**
       *
       * 海螺这条路上 buildBody 只用 imgs[0]（其余走 subject_reference 或压根不用），
       * 所以 5 张、2 张、1 张拼出来的请求体**一模一样**。原来的代码照样退让三轮，
       * 于是发了三个完全相同的请求，第三个碰巧成了，然后把"这家只收 1 张"记了下来 ——
       * 一个纯属虚构的结论，却会实打实地砍掉后面每一镜的参考图。
       *
       * 请求体没变就不是张数的问题，重试也不会有任何不同。停下来，说实话。
       */
      if (JSON.stringify(buildBody(images.slice(0, next))) === JSON.stringify(body)) {
        err.message =
          `${err.message}\n\n` +
          `这一步减图没有意义：${model} 的请求体里本来就只放得下 ${countImagesIn(body)} 张图，` +
          `发 ${count} 张和发 ${next} 张拼出来的请求**完全一样**。所以这次失败不是"图带多了"，` +
          '是别的原因（地址取不到、参数不合法、或者厂商那一下抖了）——按上面这条服务端原话查。';
        throw err;
      }
      /**
       * ⚠ 内联图的时候，"图带多了"这句话**多半是假象**。
       *
       * 用户的实例：控制台上写着参考素材 `0/9`（也就是最多 9 张），
       * 而发 4 张就被拒。张数远没到上限，被顶掉的是**体积** ——
       * 4 张内联 base64 加起来 8.9MB，一个请求体扛不住。
       *
       * 而各家在体积超了时给的话往往还是"媒体数量超限"那一套，
       * 于是我们照着字面减张数：4 → 2 → 1。三次上传、每次好几 MB、
       * 前两次纯属白跑，最后"成功"了还留下一个错误结论（这家只收 1 张），
       * 参考图从此少一大半，一致性跟着塌。
       *
       * 真正的出路是**别内联**：配上对象存储，图以地址发出去，
       * 请求体从 8.9MB 掉到几 KB，9 张也塞得下。
       * 所以这句话必须说清楚是体积，而不是让人以为这家小气。
       */
      const inlineBytes = imgs.reduce((n, u) => n + (String(u).startsWith('data:') ? u.length : 0), 0);
      const mb = inlineBytes / 1048576;
      const catalogMax = provider.videoDefaults?.maxImages ?? 0;
      onEvent?.({
        type: 'note',
        message: inlineBytes > 0
          ? `服务端拒了这 ${count} 张图（合计 ${mb.toFixed(1)}MB，是内联发的）。`
            + `${catalogMax >= count ? `这家标称能收 ${catalogMax} 张，${count} 张远没到上限 —— 所以顶掉它的多半是**体积**，不是张数。` : ''}`
            + `先改成 ${next} 张重试（这次失败是参数校验，没开始出片，不计费）；`
            + '但真正的解法是「设置 → 对象存储」配一个 —— 配上之后图以地址发出去，'
            + '请求体从几 MB 掉到几 KB，参考图一张都不用丢。'
          : `服务端嫌图带多了（${count} 张），改成 ${next} 张重试 —— 这次失败是参数校验，没开始出片，不计费`
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
  signal = null,
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
    { intervalMs: settings.get('pollIntervalMs'), timeoutMs, signal, taskId: id }
  );

  const contentUrl = ep('content', '{{baseUrl}}/videos/{id}/content').replace('{id}', encodeURIComponent(id));
  return {
    url: contentUrl,
    // 关键：这个地址不带密钥取不到，落盘时必须把头带上
    downloadHeaders: buildAuthHeaders(provider),
    // Sora 这条路不收末帧（目录里也没标），如实回报，别让上层记成"接上了"
    endFrameSent: false,
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
  signal = null,
  firstFrameUrl,
  // 末帧。秘塔控制台上那两个框（起始帧 / 结束帧）就是它
  lastFrameUrl = null,
  refImages,
  refVideos = [],
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

  /**
   * 末帧到底怎么带 —— 这一家**没有公开文档说清楚**。
   *
   * 已知的事实只有一条：秘塔控制台上摆着「起始帧」和「结束帧」两个上传框，
   * 所以它一定收。但字段名是哪个，只能试：
   *
   *   ① last_frame_image      —— 海螺自家 first_frame_image 的对称写法，最可能
   *   ② content 里带 role     —— 方舟 Seedance 用的就是这套（first_frame/last_frame）
   *
   * 与其押一个然后**安静地失效**（那正是这条功能一直是空的原因），
   * 不如按可能性排序试一遍。提交参数校验失败**不计费**，
   * 试错的代价只是一次往返；而押错的代价是这条功能白做。
   *
   * 通了就按 服务商+地址+模型 记住，同一批后面的镜头直接用。
   */
  const endFrameShapes = isH3 ? [
    {
      id: 'content-role',
      apply: (b, url) => ({
        ...b,
        content: [...(b.content || []), { type: 'image_url', image_url: { url }, role: 'last_frame' }]
      })
    }
  ] : [
    {
      id: 'last_frame_image',
      apply: (b, url) => ({ ...b, last_frame_image: url })
    },
    {
      id: 'content-role',
      apply: (b, url) => ({
        ...b,
        content: [
          ...(b.content || []).map((c, i) =>
            // 带 role 时首帧也要标出来，否则它会被当成一张普通参考图
            c.type === 'image_url' && i === 1 ? { ...c, role: 'first_frame' } : c),
          { type: 'image_url', image_url: { url }, role: 'last_frame' }
        ]
      })
    }
  ];
  const shapeKey = `${providerId}::${baseUrlOf(provider)}::${model}::endframe`;
  let shapeIdx = Number(learnedMediaLimit(shapeKey));
  if (!Number.isInteger(shapeIdx) || shapeIdx < 0 || shapeIdx >= endFrameShapes.length) shapeIdx = 0;

  const buildBody = (imgs) => {
    let b;
    if (isH3) {
      // H3 是全模态：content[] 里按 type 区分 text / image_url / video_url / audio_url。
      // 官方收到 9 张，中转家常常收得更少 —— 具体几张由下面的退让逻辑试出来。
      const content = [{ type: 'text', text: prompt }];
      for (const [index, url] of imgs.entries()) {
        content.push({
          type: 'image_url', image_url: { url },
          role: firstFrameUrl && index === 0 ? 'first_frame' : 'reference_image'
        });
      }
      for (const item of refVideos) {
        const url = typeof item === 'string' ? item : item?.url;
        if (url) content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
      }
      b = { model, content, duration, resolution };
      // 中转家（如秘塔）多要一个 ratio 字段，官方 H3 没有
      if (vd.ratio) b.ratio = aspectRatio;
      return lastFrameUrl ? endFrameShapes[shapeIdx].apply(b, lastFrameUrl) : b;
    }
    b = { model, prompt, duration, resolution };
    if (imgs[0]) b.first_frame_image = imgs[0];
    // 海螺系：末帧走对称的那个字段名
    if (lastFrameUrl) b.last_frame_image = lastFrameUrl;
    // S2V 系列用主体参考锁人设，是 Hailuo 这边一致性最好的一条路
    if (refImages.length && /S2V/i.test(model)) {
      b.subject_reference = [{ type: 'character', image_file: refImages[0] }];
    }
    return b;
  };

  /**
   * 试末帧的写法：第一种不成就换第二种，两种都不成就**不带末帧再发一次**。
   *
   * 最后那一步很要紧 —— 接缝做不上是遗憾，为它把整镜废掉是不成比例的。
   * 而且要说出来：不说的话，用户看到的是"标了连续动作但成片还是跳"，
   * 却不知道是末帧那一步没成。
   */
  const submitOnce = () => submitWithMediaBackoff({
    providerId,
    provider,
    model,
    url: createUrl,
    images,
    buildBody,
    checkBiz,
    label,
    onEvent,
    // 末帧不在 images 里（走 last_frame_image / role=last_frame），但它照样占体积
    reservedInline: lastFrameUrl
  });

  let created;
  if (!lastFrameUrl) {
    created = await submitOnce();
  } else {
    let lastErr = null;
    for (let i = shapeIdx; i < endFrameShapes.length; i += 1) {
      shapeIdx = i;
      try {
        // eslint-disable-next-line no-await-in-loop
        created = await submitOnce();
        rememberMediaLimit(shapeKey, i);
        if (i > 0) {
          onEvent?.({ type: 'note', message: `末帧按「${endFrameShapes[i].id}」这种写法发通了，同一批后面的镜头直接用这个` });
        }
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        /**
         * ⚠ **被体积/张数顶掉 ≠ 这种末帧写法不对。**
         *
         * 换一种写法发过去还是那么多字节，白撞一次墙，而且会把结论
         * 引到"这家不认这种写法"上 —— 然后我们据此扔掉末帧。
         * 真正该做的是下面那一步：先撤参考图。
         */
        if (isMediaLimitError(err.message)) {
          onEvent?.({
            type: 'note',
            message: '这次被顶掉的是**体积或张数**，不是末帧的写法 —— 换个写法发还是那么大，不白撞这一次。'
          });
          break;
        }
        const another = i + 1 < endFrameShapes.length;
        onEvent?.({
          type: 'note',
          message: `末帧按「${endFrameShapes[i].id}」发被拒了（${String(err.message).slice(0, 80)}）。`
            + (another ? `换「${endFrameShapes[i + 1].id}」再试 —— 参数校验失败不计费` : '两种写法都不成，改成不带末帧发。')
        });
      }
    }

    /**
     * ⚠ 这里**不要**再补一次"只带首帧和末帧重试"。
     *
     * 我第一版加了那一步，理由是"先扔参考图、别扔末帧"—— 方向对，
     * 但那件事 submitWithMediaBackoff 已经做完了：末帧现在走
     * reservedInline，根本不在 images 里，所以它的退让是
     * 5 张 → 2 张 → 1 张（只剩首帧），末帧一路都在。
     * 退到 1 张仍然失败时再发一次 `images.slice(0, 1)`，
     * 发的是**和上一次一模一样的请求体** —— 白等一轮，多花一次上传。
     *
     * 顺序本来就是对的，补一刀只会重复。
     */
    if (lastErr) {
      // 到这一步才认输：不带末帧兜底，并且说清楚接缝这次没做上
      lastFrameUrl = null;
      onEvent?.({
        type: 'note',
        message: '这一镜没带上末帧 —— 接缝那儿会跳一下。'
          + '「设置 → 一致性引擎 → 接缝」改成「接住真实末帧」的话，下一镜会从这一段的真实末帧接上，照样是连的。'
      });
      created = await submitOnce();
    }
  }

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
    { intervalMs: settings.get('pollIntervalMs'), timeoutMs, signal, taskId }
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
    // 兜底那几步会把 lastFrameUrl 清成 null，所以这里读到的就是"发送时的真相"
    endFrameSent: Boolean(lastFrameUrl),
    refVideosSent: isH3 ? refVideos.filter((item) => typeof item === 'string' ? item : item?.url).length : 0,
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
    /**
     * 配音按字数计费，而**字数就是我们发出去的那段字** —— 这一处的
     * "请求侧的数"恰好就是事实，不是打算：厂商数的也是这段字。
     * 记在拿到音频之后，失败的那些次不记。
     */
    meter.record({ kind: 'tts', provider: providerId, model, units: countChars(text) });
    return { url, raw: res.json };
  }

  /**
   * OpenAI 兼容家族的 /audio/speech 直接回二进制，交给上层用 fetch 落盘。
   *
   * ⚠ 账记在**这里**而不是上层落盘之后：上层那条路径不经过适配层，
   * 补在那儿等于又开一个"调用点手工登记"的口子。代价是这一支在
   * 上层落盘失败时会多记一笔 —— 但那时候厂商其实已经合成完、也已经计费了，
   * 所以多记的这一笔恰恰是对的。
   */
  meter.record({ kind: 'tts', provider: providerId, model, units: countChars(text) });
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

/**
 * 配音计费按"字符"算，各家口径大同小异：中文一个字算一个，标点也算。
 * 这里不做任何聪明的过滤 —— 过滤掉标点会让我们的数**系统性地小于账单**，
 * 而偏小的账正是这个功能要消灭的东西。
 */
function countChars(text) {
  return [...String(text ?? '')].length;
}

/**
 * 生成一段音效。
 *
 * ── 为什么不能拿 TTS 凑合 ──
 *
 * 这是两种模型。把"敲门声"交给 TTS，得到的是**一个人念出"敲门声"这三个字**。
 * 这个坑在分镜那一层已经踩过：音效被写进台词字段，配音时一字不落地念了出来。
 * 所以音效走自己的能力（sfx）和自己的路由，不和配音共用。
 *
 * ── 时长 ──
 *
 * 卡在镜头长度以内。音效比画面长的话，它会盖到下一镜上 ——
 * 上一场的敲门声在新场景里还在响，观众立刻就听出不对。
 */
export async function generateSfx({
  providerId,
  model,
  text,
  seconds = 2,
  timeoutMs = 120000,
  label = '音效'
}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);
  if (!(provider.capabilities || []).includes('sfx')) {
    throw new Error(
      `${provider.name} 不做音效生成。音效和配音是两种模型 —— ` +
      '拿配音模型生成的话，出来的是一个人在念"敲门声"这三个字。' +
      '去「设置 → 能力路由 → 音效」选一家支持的。'
    );
  }

  const res = await send(
    {
      provider: providerId,
      label,
      method: 'POST',
      url: endpoint(provider, 'sfx', '{{baseUrl}}/sound-generation'),
      body: {
        text,
        // 档位之外的值有的家会直接 400，夹一下更稳；太短听不出来，太长会压到下一镜
        duration_seconds: Math.min(22, Math.max(0.5, Number(seconds) || 2)),
        // 音效要的是**贴着描述**，不是创意发挥
        prompt_influence: 0.6,
        ...(model ? { model_id: model } : {})
      },
      timeoutMs
    },
    null
  );
  if (!res.ok) fail(label, res);

  // 音效按秒计费，用的是**夹过之后**真正发出去的那个秒数，不是入参
  const billedSeconds = Math.min(22, Math.max(0.5, Number(seconds) || 2));
  meter.record({ kind: 'sfx', provider: providerId, model, units: billedSeconds });

  // 有的家直接回音频二进制，有的家回一个地址。两种都接
  const url = firstMediaUrl(res.json, { extensions: ['.mp3', '.wav', '.ogg'] }) || firstMediaUrl(res.json);
  if (url) return { url, raw: res.json };

  return {
    url: null,
    binaryRequest: {
      provider: providerId,
      method: 'POST',
      url: interpolate(provider.endpoints?.sfx || '{{baseUrl}}/sound-generation', provider),
      body: {
        text,
        duration_seconds: Math.min(22, Math.max(0.5, Number(seconds) || 2)),
        prompt_influence: 0.6,
        ...(model ? { model_id: model } : {})
      }
    }
  };
}

/** 当前设置下，各能力实际会用哪家哪个模型 —— 界面上要显示，出错时也好排查 */
export function resolvedRouting() {
  const s = settings.all();
  return {
    chat: { provider: s.chatProvider, model: s.chatModel },
    // 调度（挑技法 / 绑说话人 / 分章）。没单独配就跟着剧本模型走 ——
    // 多一个必填项换来的抱怨，比这点质量提升多得多
    director: {
      provider: s.directorProvider || s.chatProvider,
      model: s.directorModel || s.chatModel,
      followsChat: !s.directorProvider && !s.directorModel
    },
    vision: { provider: s.visionProvider, model: s.visionModel },
    image: { provider: s.imageProvider, model: s.imageModel },
    video: { provider: s.videoProvider, model: s.videoModel },
    tts: { provider: s.ttsProvider, model: s.ttsModel },
    // 音效。没配就是不做音效 —— 不回退到配音模型，那会念出"敲门声"三个字
    sfx: { provider: s.sfxProvider || '', model: s.sfxModel || '' }
  };
}


/** 只给自检用：这几个判断出过大错，值得单独验 */
export const __isMediaLimitError = isMediaLimitError;
export const __probeMediaUrl = probeMediaUrl;
export const __trimInlineImages = trimInlineImages;
/** 只给自检用：退让那一路的话术出过误导，值得单独验 */
export const __submitWithMediaBackoff = submitWithMediaBackoff;
