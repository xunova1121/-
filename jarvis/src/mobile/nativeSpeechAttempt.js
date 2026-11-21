/** 系统声称可用不代表已开始采集；旧APK无回调/厂商不回结果都必须有界退出。 */
export function nativeSpeechAttempt(plugin, options) {
  let rejectAttempt;
  let startTimer, resultTimer;
  const clear = () => { clearTimeout(startTimer); clearTimeout(resultTimer); };
  const promise = new Promise((resolve, reject) => {
    rejectAttempt = reject;
    const timeout = (message, code) => {
      clear();
      reject(Object.assign(new Error(message), { code }));
      Promise.resolve().then(() => plugin.stop()).catch(() => {});
    };
    if (!options.popup) startTimer = setTimeout(() => timeout('系统语音没有开始收音，请检查麦克风或切换识别方式', 'SPEECH_START_TIMEOUT'), 8000);
    resultTimer = setTimeout(() => timeout('系统语音没有返回识别结果', 'SPEECH_RESULT_TIMEOUT'), 35000);
    Promise.resolve().then(() => plugin.start(options)).then(resolve, reject);
  }).finally(clear);
  return {
    promise,
    ready() { clearTimeout(startTimer); },
    cancel() { clear(); rejectAttempt(new DOMException('Aborted', 'AbortError')); }
  };
}
