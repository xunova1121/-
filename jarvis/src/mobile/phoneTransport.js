import { phoneCommand, PHONE_COMMAND_MS, phoneError } from '../../shared/phoneControl.js';
/** 本机工具也必须经过原生窗口/应用范围校验；停止后不得接收迟到回执。 */
export function localPhoneTransport(native, valid = () => true) {
  return {
    async list() { if (!valid()) throw phoneError('PHONE_SCOPE', '账号已变化，请重新开启手机操控'); const s = await native.status(); if (!valid()) throw phoneError('PHONE_SCOPE', '账号已变化，请重新开启手机操控'); return s.enabled ? [{ id: 'local', name: s.deviceName || '这台安卓手机', online: true, paused: !!s.paused, busy: !!s.busy }] : []; },
    async execute(deviceId, args, { signal } = {}) {
      if (!valid() || deviceId !== 'local') throw phoneError('PHONE_SCOPE', '目标设备或账号已变化');
      if (signal?.aborted) throw signal.reason || Object.assign(new Error('已停止'), { name: 'AbortError' });
      const id = crypto.randomUUID(), command = { ...phoneCommand(args), id, deadline: Date.now() + PHONE_COMMAND_MS };
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(result); };
        const abort = () => { native.cancel({ id }).catch(() => {}); finish(signal.reason || Object.assign(new Error('已停止，未确认的操作结果请核对手机'), { name: 'AbortError' })); };
        const timer = setTimeout(() => { native.cancel({ id }).catch(() => {}); finish(phoneError('PHONE_RESULT_UNKNOWN', '手机回执超时，结果未知；不能重复执行')); }, PHONE_COMMAND_MS + 1000);
        signal?.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { if (!settled) return native.execute(command); }).then(result => finish(valid() ? null : phoneError('PHONE_SCOPE', '账号已切换，已丢弃旧设备回执'), result), error => finish(error));
      });
    }
  };
}
