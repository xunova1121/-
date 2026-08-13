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
   * 能力路由：每种能力单独选厂商 + 模型。
   * 拆开而不是"选一家全包"，是因为各家强项差别很大 ——
   * 剧本用 DeepSeek/Qwen 便宜好用，出图火山 Seedream 稳，
   * 视频看谁家额度多，一致性复核必须挑带视觉的。
   */
  chatProvider: 'volcengine',
  chatModel: 'doubao-pro-32k',
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
  theme: 'dark',
  port: 5178
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
  cache = { ...DEFAULTS, ...disk, baseUrls: { ...DEFAULTS.baseUrls, ...(disk.baseUrls || {}) } };
  return cache;
}

export function get(key) {
  return all()[key];
}

export function patch(changes = {}) {
  const next = { ...all(), ...changes };
  if (changes.baseUrls) next.baseUrls = { ...all().baseUrls, ...changes.baseUrls };
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
