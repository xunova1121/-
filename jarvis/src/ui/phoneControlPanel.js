import './phoneControl.css';
const el = (tag, text, props = {}) => Object.assign(document.createElement(tag), { textContent: text, ...props });
/** 入口常驻设置；只在打开面板时读取设备和应用，不后台抓取屏幕。 */
export function createPhoneControlPanel(actions) {
  const dialog = el('dialog', '', { className: 'wy-phone' });
  const title = el('h2', '手机操控');
  const close = el('button', '关闭', { type: 'button' }); close.onclick = () => dialog.close();
  const head = el('header', ''); head.append(title, close);
  const body = el('div', '', { className: 'wy-phone-body' });
  const message = el('p', '', { className: 'wy-phone-message', role: 'status' });
  dialog.append(head, body, message); document.body.append(dialog);
  let generation = 0;
  dialog.addEventListener('close', () => { generation++; });
  const button = (label, fn) => { const b = el('button', label, { type: 'button' }); b.onclick = async () => { const epoch = generation; b.disabled = true; try { await fn(); } catch (e) { if (epoch === generation) message.textContent = e.message; } finally { b.disabled = false; } }; return b; };
  async function render() {
    const epoch = ++generation; body.replaceChildren(); message.textContent = '正在读取设备状态…';
    try {
      const view = await actions.view(); if (epoch !== generation || !dialog.open) return;
      message.textContent = '';
      body.append(el('p', '让未央替你打开应用、查看页面、点击和输入。每次开启有效15分钟，锁屏或停止后结束。', { className: 'wy-phone-intro' }));
      if (view.native) {
        body.append(el('p', view.status.enabled ? `这台手机：${view.status.paused ? '已暂停' : '已开启'} · 剩余${Math.ceil(view.status.remainingMs / 60000)}分钟` : '这台手机：未开启', { className: 'wy-phone-state' }));
        if (!view.status.accessibility) body.append(button('打开系统无障碍设置', actions.settings));
        body.append(el('p', '开启后，仅读取你选定应用的页面文字；截图需由任务明确请求。云端模式经本人服务器交给当前模型处理。密码和验证码本人输入，敏感或无法判断的点击需在手机确认。'));
        if (view.status.enabled) {
          body.append(button(view.status.paused ? '恢复操控' : '暂停操控', async () => { await actions.pause(!view.status.paused); await render(); }), button('停止并断开', async () => { await actions.stop(); await render(); }));
        } else {
          const name = el('input', '', { placeholder: '设备名称', value: view.status.deviceName || '我的安卓手机', maxLength: 60 }); name.setAttribute('aria-label', '设备名称'); body.append(name);
          const choices = el('div', '', { className: 'wy-phone-apps' });
          body.append(el('h3', '本次允许操作的应用（最多12个）'), choices);
          for (const app of view.apps) { const label = el('label', ''), input = el('input', '', { type: 'checkbox', value: app.packageName }); label.append(input, el('span', app.label)); choices.append(label); }
          body.append(button(view.server ? '绑定本人账号并开启15分钟' : '开启本机操控15分钟', async () => { const packages = [...choices.querySelectorAll('input:checked')].map(x => x.value); await actions.enable({ name: name.value, packages }); await render(); }));
        }
      } else body.append(el('p', '请在安卓 APK 的「设置 → 手机操控」中开启并绑定此账号；网页和电脑可以向已连接手机派任务。'));
      body.append(el('h3', view.server ? '本人已连接的手机' : '使用示例'));
      for (const device of view.devices) { const row = el('div', '', { className: 'wy-phone-device' }); row.append(el('strong', device.name), el('small', `${device.online ? '在线' : '离线'}${device.paused ? ' · 暂停' : ''}${device.busy ? ' · 操作中' : ''}`), button('断开设备', async () => { await actions.disconnect(device.id); await render(); })); body.append(row); }
      if (view.server && !view.devices.length) body.append(el('p', '暂未连接手机。连接只在本次开启期间有效，重启后需重新开启。'));
      body.append(el('p', '可直接说：“打开微信”“读取我手机当前页面”“设置明早七点的闹钟”。发送消息前会显示手机确认。'));
      body.append(button('刷新状态', render));
    } catch (e) { if (epoch === generation) message.textContent = e.message; }
  }
  return { open() { if (!dialog.open) dialog.showModal(); return render(); }, close() { dialog.close(); }, dialog };
}
