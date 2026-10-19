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
    if (p.custom) return Boolean(cfg.baseURLs?.[id]?.trim() && cfg.keys?.[id]?.trim());
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

/** 简单寒暄（你好、谢谢、好的、晚安……）：不用工具，直接短答 */
export const isSmallTalk = (text) => /^(你好|您好|嗨|哈喽|hello|hi|hey|在吗|在不在|在么|早|早安|早上好|中午好|下午好|晚上好|晚安|谢谢|谢谢你|多谢|感谢|好的|好|好吧|嗯|嗯嗯|ok|okay|收到|明白|知道了|了解|辛苦了|辛苦|再见|拜拜|哈+|呵呵|你是谁|你叫什么)[呀啊吖呢哦哈啦嘛！!。.~～，,\s]*$/i.test(String(text || '').trim());
/** 要动这台电脑的事（桌面、文件夹、打开软件、某个盘……）：服务器模式下电脑版留在本机做，服务器碰不到你的电脑 */
export const NEEDS_COMPUTER = /桌面|文件夹|我的电脑|这台电脑|本机|电脑上|[c-hC-H]\s*盘|打开.{0,10}(软件|程序|应用|浏览器|微信|QQ|钉钉|记事本|文件|网页|网站)|截屏|截个图|屏幕上|鼠标|键盘|运行命令|命令行|终端|关机|重启电脑|回收站|下载(文件夹|目录)|安装.{0,6}软件/i;
// 已上传/刚生成的文件优先沿用工作区；显式的本机目的地仍在PC执行。
const LOCAL_PLACE = /桌面|文件夹|我的电脑|这台电脑|本机|电脑上|本地(?:磁盘|硬盘|文件|文档)|当前(?:程序|软件|应用|窗口|桌面|屏幕)|[a-z]\s*盘|[a-z]:[\\/]|回收站|下载(?:文件夹|目录)/i;
const WORKSPACE_FILE = /工作区|附件|已上传|上传(?:的|给你)|发给你|(?:刚才?|你)(?:生成|制作|做|写)(?:的|好)|对话(?:里|中)|(?:这张|那张)(?:截图|图片|照片)|截图(?:里|中)|图片(?:里|中)/;
// 文件名可能很长，不能只检查“打开”后十个字，也不要求用户写扩展名。
const OPEN_DOCUMENT = /(?:打开|找一下|找找|找到|寻找|查找|搜索).{0,200}(?:文件|文档|表格|工作簿|考核表|任务表|报告|方案|合同|清单|台账|计划表|\.docx?\b|\.xlsx?\b|\.pptx?\b|\.pdf\b)|(?:打开|找一下|查找|搜索).{0,200}(?:这个|那个)(?:表|文档)/i;
const GUI_ACTION = /点击|双击|右键|拖动|拖拽|滚动|鼠标|键盘|快捷键|截屏|截图|屏幕|当前窗口|这个窗口|切换窗口|最小化|最大化|(?:关闭|切换到).{0,40}(?:窗口|软件|程序|微信|QQ|钉钉|记事本|浏览器|WPS|Excel|Word)|(?:在|把|给).{0,20}(?:微信|钉钉|记事本|浏览器|WPS|Excel|Word).{0,80}(?:输入|填写|粘贴|发送|操作|点击|编辑)/i;
const APP_ACTION = /(?:打开|启动|关闭|切换到|最小化|最大化|退出|操作).{0,60}(?:软件|程序|应用|浏览器|微信|QQ|钉钉|记事本|计算器|WPS|Excel|Word|PowerPoint|Chrome|Edge)|(?:整理|移动|复制|重命名|删除).{0,120}(?:文件|文档|表格|照片|图片|文件夹)/i;
const lastComputerTools = history => [...history].reverse().find(m=>m.role==='assistant')?.tools?.filter(t=>typeof t==='string'&&t.startsWith('computer_')) || [];
export function needsComputer(text, { history = [] } = {}) {
  const t = String(text || '').trim();
  if (LOCAL_PLACE.test(t)) return true;
  if (WORKSPACE_FILE.test(t) || /^(?:请问[，,\s]*)?(?:怎么|如何|怎样|为什么)/.test(t)) return false;
  return NEEDS_COMPUTER.test(t) || OPEN_DOCUMENT.test(t) || GUI_ACTION.test(t) || APP_ACTION.test(t) || /^(?:请|帮我|麻烦你|给我|替我)?打开\s*[^?？]{1,200}$/.test(t) ||
    (t.length<=80 && /^(继续|接着|下一步|然后|往下|往上|点开|点那个|点右边|点左边|把它|保存它|打开它|就这个|撤销|恢复|还原)/.test(t) && !/新闻|天气|搜索|联网|电视剧/.test(t) && lastComputerTools(history).length>0) ||
    (lastComputerTools(history).length>0&&/(这个|这份|刚才的|它|里面)/.test(t)&&/(修改|编辑|填写|计算|求和|保存)/.test(t));
}
/** GUI任务优先走看图模型，文件和命令操作无需无故切模型；只在PC本机路由使用。 */
export function computerTaskKind(text, { history = [] } = {}) {
  if (!needsComputer(text,{history})) return null;
  return GUI_ACTION.test(String(text)) || /^(继续|接着|下一步|然后|点)/.test(String(text)) && lastComputerTools(history).some(t=>/^computer_(look|click|type|key|scroll|drag)$/.test(t)) ? 'gui' : 'files';
}
/** 要查证、分析、算结果的话：日常对话里也不能少想 */
export const NEEDS_THOUGHT = /查|搜|核实|验证|结果|赛果|比分|中没中|中奖|最新|价格|行情|新闻|分析|计算|算一下|对比|图片|截图|图里/;
/** 日常闲聊让推理模型少想一点（首字更快）；其余用默认档位 */
export const effortFor = (task, text, cfg = {}) => (task === 'chat' && cfg.fastChat !== false && !NEEDS_THOUGHT.test(String(text || '')) ? 'low' : undefined);

/** 按模型名字推荐分工（名字里的常见标记；聚合平台上的模型名各不相同，推荐后请再看一眼） */
const PREFER = {
  chat: [/flash(?!.*thinking)/i, /mini|nano|lite|haiku|turbo|instant|small|air\b/i, /deepseek-(chat|v3)/i, /\b(7|8|14)b\b/i],
  code: [/codex|coder|code/i, /claude.*(sonnet|opus)|(sonnet|opus)/i, /gpt-?[5-9](\.\d)?(?!.*mini)/i, /kimi-k2|glm-4\.[5-9]|qwen3-(max|235b)|deepseek-(v3|chat)/i],
  write: [/claude.*(opus|sonnet)|(opus|sonnet)/i, /gpt-?[5-9](\.\d)?(?!.*mini)|gpt-4\.1(?!-mini|-nano)|gpt-4o(?!-mini)/i, /qwen-max|qwen3-max|kimi|glm-4|doubao.*pro|deepseek-(chat|v3)/i],
  reason: [/\bo[134](-pro)?\b|o3|o4|r1|reasoner|thinking|think/i, /gpt-?[5-9](\.\d)?(?!.*mini)|opus|gemini-?[23](\.\d)?-pro/i],
  vision: [/\bvl\b|-vl|vision/i, /gpt-?4o|gpt-?4\.1|gpt-?[5-9]|gemini|claude|sonnet|opus/i]
};
/** 这个模型能不能看图（按模型名判断，聚合平台上的名字五花八门，判断不了的当不能看） */
export function seesImages(model) {
  const m = String(model || '');
  return PREFER.vision.some((re) => re.test(m)) || /qwen.*vl|glm-4v|doubao.*vision|llava|gemma-?3/i.test(m);
}
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

/**
 * 备用模型：当前模型出错（中转站超时、限流、模型下线、余额不足）时按顺序换着用。
 * 先取分工里设过的其他模型（同一家换个模型常常就能用），再取填了密钥的其他服务商的默认模型；最多 max 个。
 * @returns {Array<{ cfg: object, provider: string, model: string }>}
 */
export function fallbackRoutes(cfg, current = {}, max = 2) {
  const out = [];
  const keyed = keyedProviders(cfg);
  const add = (provider, model) => {
    if (!provider || !model || out.length >= max || !keyed.includes(provider)) return;
    if (provider === current.provider && model === current.model) return;
    if (out.some((x) => x.provider === provider && x.model === model)) return;
    out.push({ cfg: { ...cfg, provider, models: { ...cfg.models, [provider]: model } }, provider, model });
  };
  const r = cfg.routing;
  if (r?.enabled) {
    for (const v of Object.values(r.routes || {})) {
      const p = parseRoute(v);
      add(p.provider || r.provider || cfg.provider, p.model);
    }
  }
  add(cfg.provider, cfg.models?.[cfg.provider]);
  for (const id of keyed) add(id, cfg.models?.[id]);
  return out;
}

/** 这个错误换个模型可能就好了（临时故障、限流、模型不存在、余额或额度不够）；用户点停止、参数写错这类不换 */
export function canFallback(err) {
  if (!err || err.name === 'AbortError') return false;
  if ([402, 403, 404, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(err.status)) return true;
  return err.name === 'TypeError' || Boolean(err.stalled) || /connection reset|connection error|econnreset|socket hang up|network ?error|failed to fetch|load failed|timeout|超时|overloaded|余额|额度|quota|insufficient|无可用渠道|no available channel|model.{0,20}(not.{0,10}(found|exist|available|supported))|模型.{0,6}(不存在|不可用|下线)/i.test(String(err.message));
}

