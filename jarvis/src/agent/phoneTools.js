import { PHONE_ACTIONS, PHONE_GUIDANCE, phoneCommand, phoneResult } from '../../shared/phoneControl.js';
const str = description => ({ type: 'string', description });
export function createPhoneTools(transport) {
  if (!transport) return [];
  const attempted = new Set();
  return [{
    name: 'phone_devices', description: '查看本人已连接的安卓手机、在线/暂停状态；操控手机先查此工具，多个设备须按用户指定选择。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => JSON.stringify({ devices: await transport.list(), note: PHONE_GUIDANCE })
  }, {
    name: 'phone_action', description: '操控已启用的安卓手机：读取屏幕/截图，打开应用，点击、输入、滑动、返回，设置闹钟、导航、拨号或分享文字。每步真实读回；敏感操作在手机确认。',
    input_schema: { type: 'object', properties: {
      deviceId: str('phone_devices返回的本人设备编号'), action: { type: 'string', enum: PHONE_ACTIONS },
      packageName: str('list_apps返回的应用包名'), snapshotId: str('read_screen/截图或上一步返回的最新屏幕编号'), nodeId: str('该屏幕返回的元素编号，输入必须指定'),
      x: { type: 'number', minimum: 0, maximum: 1, description: '坐标点击时横向比例，需手机确认' }, y: { type: 'number', minimum: 0, maximum: 1 },
      text: str('输入或分享文字，最多2000字'), direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 }, label: str('闹钟名称'), destination: str('导航目的地'), number: str('拨号号码，只打开拨号页面')
    }, required: ['deviceId', 'action'], additionalProperties: false },
    run: async (args, { signal } = {}) => {
      const command = phoneCommand(args);
      const changes = !['list_apps', 'read_screen', 'screenshot', 'open_app', 'home'].includes(command.action);
      const key = JSON.stringify([args.deviceId, command]);
      if (changes && attempted.has(key)) throw Object.assign(new Error('这个手机动作已提交过；先核对新屏幕，不能重放旧点击或输入'), { code: 'PHONE_DUPLICATE' });
      if (changes) attempted.add(key);
      const r = phoneResult(await transport.execute(args.deviceId, command, { signal }));
      if (!r.ok) throw Object.assign(new Error(r.message || '手机操作未完成'), { code: r.code || 'PHONE_FAILED' });
      const { image, ...receipt } = r;
      return image ? { text: JSON.stringify(receipt), images: [image] } : JSON.stringify(receipt);
    }
  }];
}
