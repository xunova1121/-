export function foregroundPolicy({ hidden = false, nativeActive = true, starting = false, systemDialog = false } = {}) {
  const audio = !hidden && nativeActive;
  return { audio, stopInput:!audio && !starting && !systemDialog };
}
/** 返回识别窗口时可见性和原生 onResume 次序不同：音频立即静音，取消录音延后确认一次。 */
export function createVoiceLifecycle({ getState, onAudio, onLeave, delay = 300 }) {
  let timer;
  return { update() { clearTimeout(timer); const policy = foregroundPolicy(getState()); onAudio(policy.audio); if (policy.stopInput) timer = setTimeout(() => { if (foregroundPolicy(getState()).stopInput) onLeave(); },delay); }, dispose() { clearTimeout(timer); } };
}
