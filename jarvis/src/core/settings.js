/**
 * 设置项与 localStorage 持久化（需求 9.4）。localStorage 不可用（隐私模式等）时退化为内存存储。
 */
export const DEFAULT_SETTINGS = {
  faceFollow: false,
  directVoice: false,
  wakeWord: false, // 直接对话时只在听到“未央”后响应
  speechOutput: true,
  readTyped: false, // 打字提问也朗读回答（默认只在语音对话、说话提问时念）
  vadSensitivity: '中',
  emotionOverride: 'auto',
  focusView: false,
  stageOpen: false, // 桌面版：有对话时也保持大舞台（默认收成迷你状态条）
  reducedMotion: 'system', // system | on | off
  screenAwake: 'smart', // 屏幕常亮：smart 说话时不灭、久不碰调暗 | always 一直常亮 | system 跟随系统
  look: 'orb', // orb 光核 | holo 全息胸像 | wire 线框胸像
  quality: 'auto', // auto | high | standard | eco
  persistMemory: false, // 旧版：单条对话流存 localStorage（启动时迁移成会话）
  saveSessions: true, // 对话历史保存到本机（多会话）
  autoMemory: true, // 对话停下后自动整理记忆（抽取事实、写摘要）
  theme: 'day', // 手机 App 默认淡紫的白天配色；界面明暗：time 白天亮夜里暗（7:00–19:00 为白天）| system 跟随系统 | day 白天 | night 夜间
  greetOnReturn: true, // 离开电脑一段时间后回来时主动问好
  teamMode: 'auto' // 多助手分工：auto 复杂任务自动组团 | on 总是 | off 关闭（任何时候都可用“/团队 …”强制）
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
