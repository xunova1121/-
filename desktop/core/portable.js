/**
 * 换电脑：把配置带走，把密钥留下。
 *
 * ── 为什么非要有这一条 ──
 *
 * 用户换了台电脑，第一句话是「里面服务商的 API 和 url 全不见了」。
 * 他没做错什么 —— 这个应用的所有数据都只存在那台机器上，从不上传，
 * 而在这之前，"换电脑"的答案是**你自己去 %APPDATA% 里找文件拷**。
 * 对一个要卖的产品来说，这不叫方案。
 *
 * ── 为什么密钥不进导出文件 ──
 *
 * 导出文件会被随手发微信、丢网盘、贴给同事复现问题。
 * 一个躺在聊天记录里的明文密钥，等于把账单交给了所有看得到它的人。
 *
 * 所以这份文件**只带能公开的那半**：服务商地址、接口覆盖、模型路由、
 * 画幅、单价。密钥另说 —— 换电脑就是要去各家控制台重新复制一遍，
 * 而那件事本来也只需要几分钟。
 *
 * ⚠ 但"我们没打算带密钥"和"里面真的没有密钥"是两回事。
 * 中转站的地址里塞一个 ?key=sk-xxx 是很常见的写法，而那也是密钥。
 * 所以导出前**逐个值扫一遍**，看着像密钥的就抹掉并如实报出来 ——
 * 而不是嘴上保证一句"不含密钥"。
 */

import * as settings from './settings.js';

/**
 * 会被带走的那几项。
 *
 * ⚠ 白名单，不是黑名单。用黑名单的话，以后往设置里加一个带敏感值的字段，
 * 它会**自动**进导出文件，而没有任何人会注意到 —— 漏一项的代价是泄密，
 * 而多一项的代价只是少搬一个设置。
 */
export const PORTABLE_KEYS = [
  // 服务商地址与接口覆盖：走中转站的人全靠这两项，也是最难重填的
  'baseUrls', 'endpointOverrides',
  // 能力路由：哪一步用哪家的哪个模型
  'chatProvider', 'chatModel',
  'directorProvider', 'directorModel',
  'outlineProvider', 'outlineModel',
  'imageProvider', 'imageModel',
  'videoProvider', 'videoModel',
  'visionProvider', 'visionModel',
  'ttsProvider', 'ttsModel',
  'sfxProvider', 'sfxModel',
  // 画面规格
  'aspectRatio', 'videoResolution', 'imageSize',
  // 单价：一条条填出来的，重填最烦
  'rates',
  // 一致性引擎那几个开关
  'consistencyVerify', 'consistencyThreshold', 'consistencyMaxRetries',
  'useReferenceImages', 'refMode', 'neighborRef',
  // 其它跑起来会影响结果的偏好
  'videoPromptMode', 'seamMode', 'durationPolicy', 'autoCheckOnStart'
];

/**
 * 看着像不像密钥。
 *
 * ⚠ 宁可错杀。抹掉一个其实无害的字符串，代价是用户手动补一次；
 * 漏掉一个真密钥，代价是它躺在别人的聊天记录里。两者不对等。
 */
const SECRETISH = [
  /\bsk-[A-Za-z0-9_-]{8,}/,          // OpenAI 系
  /\bak-[A-Za-z0-9_-]{8,}/,
  /\bark-[A-Za-z0-9-]{8,}/,          // 火山方舟
  /\bLTAI[A-Za-z0-9]{8,}/,           // 阿里云 AccessKeyId
  /\bAKIA[A-Z0-9]{12,}/,             // AWS
  /\bghp_[A-Za-z0-9]{20,}/,          // GitHub
  /\beyJ[A-Za-z0-9_-]{20,}/,         // JWT
  // 地址里挂着的凭据参数：?key=、&token=、:password@
  /[?&](?:key|api[-_]?key|token|access[-_]?token|secret|password|pwd|sig|signature)=[^&\s]{8,}/i,
  /:\/\/[^/\s:]+:[^@/\s]{6,}@/
];

export function looksSecret(text) {
  const s = String(text ?? '');
  return SECRETISH.some((re) => re.test(s));
}

/** 把一个值里像密钥的部分抹掉，回 { value, hit } */
function scrub(value) {
  if (typeof value === 'string') {
    if (!looksSecret(value)) return { value, hit: false };
    let out = value;
    for (const re of SECRETISH) {
      out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '「已抹掉」');
    }
    return { value: out, hit: true };
  }
  if (Array.isArray(value)) {
    let hit = false;
    const out = value.map((x) => {
      const r = scrub(x);
      if (r.hit) hit = true;
      return r.value;
    });
    return { value: out, hit };
  }
  if (value && typeof value === 'object') {
    let hit = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = scrub(v);
      if (r.hit) hit = true;
      out[k] = r.value;
    }
    return { value: out, hit };
  }
  return { value, hit: false };
}

export const FORMAT = 'futuredream.settings.v1';

/**
 * 导出。回的是**可以直接存成文件**的那个对象，外加一份"抹掉了什么"的清单。
 *
 * ⚠ `redacted` 必须回给界面并显示出来。抹掉了却不说，用户会带着一份
 * 缺了地址的配置去新电脑，然后在那边查"为什么连不上" —— 而那时候
 * 线索已经断在两台机器之外了。
 */
export function exportSettings() {
  const all = settings.all();
  const data = {};
  const redacted = [];
  for (const key of PORTABLE_KEYS) {
    if (!(key in all)) continue;
    const v = all[key];
    if (v === undefined || v === null || v === '') continue;
    const r = scrub(v);
    if (r.hit) redacted.push(key);
    data[key] = r.value;
  }
  return {
    file: {
      format: FORMAT,
      exportedAt: new Date().toISOString(),
      /**
       * ⚠ 这句话是写给**拿到文件的人**看的，不是写给我们自己看的。
       * 文件会被转发，而转发的时候没人会附上说明。
       */
      note: '这份文件只有配置，没有 API 密钥。密钥请到各服务商控制台重新获取后手动填写。',
      settings: data
    },
    redacted,
    count: Object.keys(data).length
  };
}

/**
 * 导入。
 *
 * ⚠ 只认白名单里的键，别的一律丢掉并报出来。
 * 一份手改过、或者别的版本导出的文件里可能有任何东西，
 * 而 settings.patch 收什么就存什么 —— 不过滤的话，
 * 一个拼错的键会安安静静地躺在设置里，永远不生效也永远查不出来。
 */
export function importSettings(payload = {}) {
  const src = payload && typeof payload === 'object'
    ? (payload.settings && typeof payload.settings === 'object' ? payload.settings : payload)
    : {};

  if (payload?.format && payload.format !== FORMAT) {
    throw new Error(`不认识这个格式：${payload.format}（这里认的是 ${FORMAT}）`);
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    throw new Error('这不是一份配置文件 —— 里面应该是一个对象');
  }

  const patch = {};
  const skipped = [];
  const stripped = [];
  for (const [k, v] of Object.entries(src)) {
    if (!PORTABLE_KEYS.includes(k)) { skipped.push(k); continue; }
    // 导入的文件也可能带着密钥（比如别人手改过）—— 同样抹掉，不落盘
    const r = scrub(v);
    if (r.hit) stripped.push(k);
    patch[k] = r.value;
  }

  const keys = Object.keys(patch);
  if (!keys.length) throw new Error('这份文件里没有一项能导入的设置');
  settings.patch(patch);
  return { applied: keys, skipped, stripped };
}
