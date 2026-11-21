import { createPhoneControlPanel } from '../ui/phoneControlPanel.js';
import { localPhoneTransport } from '../mobile/phoneTransport.js';
import { loadServerSettings } from '../core/serverClient.js';
import { toast } from './env.js';

/** 开启时捕获账号与服务器，切换即停止；凭据只交原生内存，不保存到设置或对话。 */
export function createPhoneControl(app, { native = globalThis.__jarvisPhoneControl } = {}) {
  let binding = null;
  let epoch = 0;
  const ready = native ? Promise.resolve().then(() => native.stop()) : Promise.resolve();
  ready.catch(() => toast('手机操控初始化未完成，请重新打开应用'));
  const identity = () => {
    const s = loadServerSettings();
    return JSON.stringify([s.url, s.userId || 'owner', !!s.enabled]);
  };
  const capture = () => {
    const server = app.server,
      account = identity(),
      version = epoch;
    return { server, account, valid: () => server === app.server && account === identity() && version === epoch };
  };
  async function stop() {
    epoch++;
    const previous = binding;
    binding = null;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => native?.stop()),
      previous?.server && previous.id ? previous.server.phone.disconnect(previous.id) : Promise.resolve()
    ]);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
  const actions = {
    async view() {
      await ready;
      const scope = capture();
      const status = native ? await native.status() : null;
      const apps = native && !status.enabled ? (await native.apps()).apps || [] : [];
      const devices = scope.server ? await scope.server.phone.list() : [];
      if (!scope.valid()) throw new Error('账号或服务器已切换，请重新打开手机操控');
      return { native: !!native, status, apps, devices, server: !!scope.server };
    },
    settings: () => native.settings(),
    async enable({ name, packages }) {
      await ready;
      if (!native) throw new Error('请在安卓APK中开启');
      if (!packages.length || packages.length > 12) throw new Error('请选择1到12个允许操作的应用');
      const scope = capture(),
        info = await native.status();
      if (!info.accessibility) throw new Error('请先打开系统无障碍设置，开启未央手机操控');
      if (!scope.valid()) throw new Error('账号已切换，未开启操控');
      let registered;
      try {
        registered = scope.server ? await scope.server.phone.register({ name, installationId: info.installationId }) : null;
        if (!scope.valid()) throw new Error('账号已切换，未绑定旧设备');
        await native.enable({ packages, ...(registered && { base: scope.server.base, deviceId: registered.id, token: registered.token }) });
        if (!scope.valid()) {
          await native.stop();
          throw new Error('账号已切换，已停止操控');
        }
        binding = { server: scope.server, account: scope.account, id: registered?.id || 'local' };
      } catch (error) {
        if (registered) await scope.server.phone.disconnect(registered.id).catch(() => {});
        throw error;
      }
    },
    pause: async (paused) => {
      await native.pause({ paused });
    },
    stop,
    async disconnect(id) {
      if (binding?.id === id) return stop();
      const scope = capture();
      await scope.server.phone.disconnect(id);
      if (!scope.valid()) throw new Error('账号已切换，请刷新');
    }
  };
  const panel = createPhoneControlPanel(actions);
  const entry = document.querySelector('#btn-phone-control');
  entry?.addEventListener('click', () => panel.open());
  // WebView重载不能继承旧的本机授权窗口；云端绑定也重新确认。
  const checkScope = () => {
    if (binding && (binding.server !== app.server || binding.account !== identity())) stop().catch(() => toast('手机操控已停止；旧连接将自动过期'));
  };
  if (native) setInterval(checkScope, 1000);
  addEventListener('jarvis:foreground', checkScope);
  return {
    phoneControl: {
      panel,
      stop,
      transport() {
        if (!native || app.server) return null;
        const scope = capture();
        return localPhoneTransport(native, scope.valid);
      }
    }
  };
}
