/**
 * 模型分工：不同的事交给更擅长的模型。
 *   日常对话 → 快模型（首字快，便宜）
 *   编程     → 代码能力强的模型
 *   写作文档 → 文笔好的模型
 *   深度思考 / 调研 → 推理模型
 *   看图     → 支持图片的模型
 *
 * 每句话先按内容判断属于哪类（规则判断，不额外调用模型，零延迟），再换成对应的模型；
 * 没配置的类别沿用默认模型。
 * 可以跨服务商：分工里写“服务商::模型”（如 deepseek::deepseek-chat）就用那个服务商的密钥和地址；
 * 只写模型名的，用当前服务商。那个服务商没填密钥时，退回默认模型。
 */
import { providerById } from '../../shared/providers.js';

/** 跨服务商的模型写法：“服务商::模型” */
export const SEP = '::';
export const routeRef = (provider, model) => `${provider}${SEP}${model}`;
/** “服务商::模型” → { provider, model }；只有模型名时 provider 为空（用当前服务商） */
export function parseRoute(v) {
  const s = String(v ?? '').trim();
  const i = s.indexOf(SEP);
  if (i > 0 && providerById(s.slice(0, i))) return { provider: s.slice(0, i), model: s.slice(i + SEP.length).trim() };
  return { provider: '', model: s };
}
/** 显示用：“模型（服务商）” */
export function routeLabel(v, current = '') {
  const { provider, model } = parseRoute(v);
  return provider && provider !== current ? `${model}（${providerById(provider)?.name ?? provider}）` : model;
}

/** 填了密钥、能用的服务商（当前服务商总算一个；本机 Ollama 只在正用着时算） */
export function keyedProviders(cfg) {
  const ok = (id) => {
    const p = providerById(id);
    if (!p || p.kind === 'mock') return false;
    if (id === cfg.provider) return true;
    if (p.custom) return Boolean(cfg.baseURLs?.custom?.trim() && cfg.keys?.[id]?.trim());
    return p.needsKey === false ? false : Boolean(cfg.keys?.[id]?.trim());
  };
  return [cfg.provider, ...Object.keys(cfg.keys || {})].filter((id, i, a) => a.indexOf(id) === i && ok(id));
}
export const TASKS = {
  chat: { name: '日常对话', hint: '选一个快的小模型，回答秒出' },
  code: { name: '编程', hint: '写代码、改 bug、做网页' },
  write: { name: '写作 / 文档', hint: '报告、PPT、邮件、润色、翻译' },
  reason: { name: '深度思考 / 调研', hint: '分析、对比、规划、调研、多步任务' },
  vision: { name: '看图', hint: '发了图片、截屏分析' }
};

const CODE = /代码|编程|程序|函数|变量|bug|报错|异常|调试|脚本|编译|html|css|javascript|typescript|python|java\b|golang|rust|sql|正则|前端|后端|接口|api|部署|docker|git\b|网页|网站|小程序|```/i;
const WRITE = /(写|起草|撰写|帮我写|生成)(一|个|篇|份|封)?.{0,6}(报告|文档|文章|周报|日报|月报|总结|邮件|方案|计划书?|简历|ppt|幻灯片|文案|合同|论文|稿|通知|公告|说明书|演讲)|润色|改写|翻译|摘要|纪要|扩写|缩写|word|ppt/i;
const REASON = /调研|研究|分析|对比|比较|推理|证明|为什么|评估|权衡|策略|战略|规划|方案设计|数学|计算|推导|决策|利弊|深度|^\/团队/;

/**
 * @param {string} text
 * @param {{ images?: number }} [o]
 * @returns {'chat'|'code'|'write'|'reason'|'vision'}
 */
export function classifyTask(text, { images = 0 } = {}) {
  const t = String(text || '');
  if (images > 0) return 'vision';
  if (CODE.test(t)) return 'code';
  if (WRITE.test(t)) return 'write';
  if (REASON.test(t) || t.length > 400) return 'reason';
  return 'chat';
}

/** 按模型名字推荐分工（名字里的常见标记；聚合平台上的模型名各不相同，推荐后请再看一眼） */
const PREFER = {
  chat: [/flash(?!.*thinking)/i, /mini|nano|lite|haiku|turbo|instant|small|air\b/i, /deepseek-(chat|v3)/i, /\b(7|8|14)b\b/i],
  code: [/codex|coder|code/i, /claude.*(sonnet|opus)|(sonnet|opus)/i, /gpt-?[5-9](\.\d)?(?!.*mini)/i, /kimi-k2|glm-4\.[5-9]|qwen3-(max|235b)|deepseek-(v3|chat)/i],
  write: [/claude.*(opus|sonnet)|(opus|sonnet)/i, /gpt-?[5-9](\.\d)?(?!.*mini)|gpt-4\.1(?!-mini|-nano)|gpt-4o(?!-mini)/i, /qwen-max|qwen3-max|kimi|glm-4|doubao.*pro|deepseek-(chat|v3)/i],
  reason: [/\bo[134](-pro)?\b|o3|o4|r1|reasoner|thinking|think/i, /gpt-?[5-9](\.\d)?(?!.*mini)|opus|gemini-?[23](\.\d)?-pro/i],
  vision: [/\bvl\b|-vl|vision/i, /gpt-?4o|gpt-?4\.1|gpt-?[5-9]|gemini|claude|sonnet|opus/i]
};
const NOT_CHAT = /embed|tts|whisper|audio|image|dall|moderation|rerank|transcribe|realtime|search-preview|flux|midjourney|stable-?diffusion|sdxl|seedream|imagen|cogview|kolors|sora|veo|kling|video/i;

/**
 * @param {string[]} ids  服务商提供的模型列表
 * @param {string} fallback  默认模型
 * @returns {Record<string, string>}
 */
export function suggestRoutes(ids, fallback = '') {
  // ids 可以混着“服务商::模型”（多家服务商一起推荐）：按模型名判断
  const name = (id) => parseRoute(id).model;
  const pool = [...new Set(ids.map(String).filter((id) => name(id) && !NOT_CHAT.test(name(id))))];
  const out = {};
  for (const task of Object.keys(TASKS)) {
    let pick = '';
    for (const re of PREFER[task]) {
      const hits = pool.filter((id) => re.test(name(id)));
      if (hits.length) {
        // 同类里挑名字里版本号最高的（如 gpt-5.1 优于 gpt-5）；同名的排在前面的服务商优先
        pick = hits.sort((a, b) => versionOf(name(b)) - versionOf(name(a)) || name(a).length - name(b).length || pool.indexOf(a) - pool.indexOf(b))[0];
        break;
      }
    }
    out[task] = pick || fallback;
  }
  return out;
}
function versionOf(id) {
  const m = String(id).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

/**
 * 这一句话用哪个模型
 * @param {object} cfg  模型配置（含 routing）
 * @returns {{ cfg: object, task: string, model: string, routed: boolean }}
 */
export function routeFor(cfg, task) {
  const r = cfg.routing;
  const on = r?.enabled && (r.provider === cfg.provider || r.multi);
  let { provider, model } = on ? parseRoute(r.routes?.[task]) : { provider: '', model: '' };
  // 只写模型名：是分工设定时那个服务商的（multi 时可能已经换了当前服务商）
  if (model && !provider) provider = r.provider || cfg.provider;
  if (model && provider !== cfg.provider && !keyedProviders(cfg).includes(provider)) model = ''; // 那家没填密钥：用默认模型
  if (!model) return { cfg, task, model: cfg.models?.[cfg.provider] ?? '', provider: cfg.provider, routed: false };
  return { cfg: { ...cfg, provider, models: { ...cfg.models, [provider]: model } }, task, model, provider, routed: true };
}
