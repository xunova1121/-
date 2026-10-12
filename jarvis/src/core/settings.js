/**
 * 设置项与 localStorage 持久化（需求 9.4）。localStorage 不可用（隐私模式等）时退化为内存存储。
 */
export const DEFAULT_SETTINGS = {
  faceFollow: false,
  directVoice: false,
  wakeWord: false, // 直接对话时只在听到“贾维斯”后响应
  speechOutput: true,
  vadSensitivity: '中',
  emotionOverride: 'auto',
  focusView: false,
  reducedMotion: 'system', // system | on | off
  look: 'orb', // orb 光核 | holo 全息胸像 | wire 线框胸像
  quality: 'auto', // auto | high | standard | eco
  persistMemory: false, // 旧版：单条对话流存 localStorage（启动时迁移成会话）
  saveSessions: true, // 对话历史保存到本机（多会话）
  autoMemory: true // 对话停下后自动整理记忆（抽取事实、写摘要）
};

const KEY = 'jarvis.settings.v1';

export function loadSettings(storage = safeStorage()) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const out = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (k in parsed && typeof parsed[k] === typeof DEFAULT_SETTINGS[k]) out[k] = parsed[k];
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings, storage = safeStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* 存储满或被禁用：本次会话内仍然生效 */
  }
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 是否应走减少动画模式：手动覆盖优先，否则跟随系统偏好 */
export function wantsReducedMotion(settings, mql = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')) {
  if (settings.reducedMotion === 'on') return true;
  if (settings.reducedMotion === 'off') return false;
  return Boolean(mql?.matches);
}
