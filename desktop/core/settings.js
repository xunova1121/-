/**
 * 应用设置（非机密）。机密一律走 vault.js，两者分家是刻意的：
 * settings.json 明文可读、可以直接手改、可以贴给同事复现问题；
 * credentials.enc 加密、不外传。
 */
import fs from 'node:fs';
import { SETTINGS_FILE, DATA_DIR } from './paths.js';

const DEFAULTS = {
  /** 各服务商的 baseUrl 覆盖：{ dashscope: 'https://…' } —— 走内网网关时改这里 */
  baseUrls: {},
  /**
   * 单个接口地址的覆盖，键是 `<服务商>.<接口名>`，例如
   * `{ 'metaso.videoQuery': 'https://metaso.cn/api/minimax/v2/query/xxx' }`。
   *
   * 为什么需要这个：中转平台常常只公开"提交"那一步的地址，查任务的路径要靠猜。
   * 猜错了就会出现"厂商那边早就出片了，这边还在轮询"。
   * 与其等我改目录，不如让你在界面上把查到的地址直接填进来 —— 填完立刻生效。
   */
  endpointOverrides: {},
  /**
   * 能力路由：每种能力单独选厂商 + 模型。
   * 拆开而不是"选一家全包"，是因为各家强项差别很大 ——
   * 剧本用 DeepSeek/Qwen 便宜好用，出图火山 Seedream 稳，
   * 视频看谁家额度多，一致性复核必须挑带视觉的。
   */
  chatProvider: 'volcengine',
  chatModel: 'doubao-1-5-pro-32k-250115',
  visionProvider: 'volcengine',
  visionModel: 'doubao-seed-1-6-250615',
  imageProvider: 'volcengine',
  imageModel: 'doubao-seedream-3-0-t2i-250415',
  /** 出角色设定图之后的镜头图，优先走图生图以保住人设 */
  imageEditModel: 'doubao-seededit-3-0-i2i-250628',
  videoProvider: 'volcengine',
  videoModel: 'doubao-seedance-1-0-pro-250528',
  ttsProvider: 'dashscope',
  ttsModel: 'qwen3-tts-flash',

  // ───── 时长 ─────
  /**
   * 成片时长策略。
   *   trim  按分镜时长裁剪，能精确命中目标；代价是可能切在动作中途
   *   keep  保留模型给的完整片段，运动自然；代价是成片比计划长
   * 默认 trim —— 用户设了目标时长，多半就是要卡住这个数。
   */
  durationPolicy: 'trim',
  /** 新项目的默认目标时长（秒） */
  defaultTargetDuration: 60,

  // ───── 画面规格 ─────
  /**
   * 视频分辨率档位。'auto' = 跟随所选服务商的默认档。
   * 存的是"用户选的那个词"而不是每家一份配置：各家拼写不统一（720p / 720P / 2K），
   * 发送前由 catalog.resolveResolution 按大小写不敏感匹配翻译成该家的原样写法，
   * 换服务商也不会因为写法对不上而整条流水线报错。
   */
  videoResolution: 'auto',
  /** 画幅。视频和出图共用一个，免得成片里图和视频比例打架。 */
  aspectRatio: '16:9',

  // ───── 一致性引擎 ─────
  /** 关掉就是纯"提示词 + 种子"，省一次视觉调用，但崩了不会自动发现 */
  consistencyVerify: true,
  /** 复核低于这个分数就重试 */
  consistencyThreshold: 75,
  /** 单镜最多重试几次 */
  consistencyMaxRetries: 2,
  /** 出镜头图时是否把角色设定图作为参考图带上（最关键的一层，别关） */
  useReferenceImages: true,
  requestTimeoutMs: 120000,
  pollIntervalMs: 3000,
  pollTimeoutMs: 600000,
  /**
   * 图生视频要求首帧图是公网可达的 URL，本地文件不行。
   * 这里填一个"收 multipart 上传、返回 {url}"的接口即可（OSS 直传网关 / 自建图床）。
   */
  uploadGateway: '',
  /** 留空则自动探测：先看 desktop/bin，再看 PATH */
  ffmpegPath: '',
  /**
   * 走 Windows 的系统代理（只有桌面版有这个能力）。
   *
   * Node 自带的 fetch 不读系统代理，一律直连 —— 公司网络下就是连不上，
   * 报 UND_ERR_CONNECT_TIMEOUT。打开这个开关会改用 Electron 的网络栈，
   * 它跟浏览器一样读系统代理。默认关：换网络栈有风险，不该悄悄替所有人换。
   */
  useSystemProxy: false,
  theme: 'dark',
  port: 5178,

  // ───── 手机遥控（未完成，界面还没接上）─────
  /**
   * 允许手机从局域网连进来。默认关，而且是**另开一个端口**监听 ——
   * 这条口子后面是 API 密钥和额度，规矩必须和本机那条分开写死。见 core/server.js。
   */
  lanAccess: false,
  /** 配对码。开启时自动生成，手机连进来必须带上它。 */
  lanToken: ''
};

let cache = null;

export function all() {
  if (cache) return cache;
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    disk = {};
  }
  cache = {
    ...DEFAULTS,
    ...disk,
    baseUrls: { ...DEFAULTS.baseUrls, ...(disk.baseUrls || {}) },
    endpointOverrides: { ...DEFAULTS.endpointOverrides, ...(disk.endpointOverrides || {}) }
  };
  return cache;
}

export function get(key) {
  return all()[key];
}

export function patch(changes = {}) {
  const next = { ...all(), ...changes };
  if (changes.baseUrls) next.baseUrls = { ...all().baseUrls, ...changes.baseUrls };
  if (changes.endpointOverrides) {
    next.endpointOverrides = { ...all().endpointOverrides, ...changes.endpointOverrides };
    // 填了空字符串等于"清掉这条覆盖，回到自动探测"
    for (const [k, v] of Object.entries(next.endpointOverrides)) if (!v) delete next.endpointOverrides[k];
  }
  cache = next;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  return next;
}

export function reset() {
  cache = { ...DEFAULTS };
  patch({});
  return cache;
}

export { DEFAULTS };
