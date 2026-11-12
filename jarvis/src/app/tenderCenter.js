import { userStorageSuffix } from '../core/userStorage.js';
import { createTenderCenterView } from '../ui/tenderCenter.js';

/** 运行端、账号和草稿身份锁定；旧请求不得将个人订阅填到另一账号。 */
export function mountTenderCenter(app, target, onFill) {
  const server = app.server,
    identity = userStorageSuffix(),
    session = app.session;
  const valid = () => server === app.server && identity === userStorageSuffix() && session === app.session;
  const call =
    server &&
    (async (method, ...args) => {
      if (!valid()) throw new Error('账号或对话已切换，请重新打开');
      if (!server.tenders) throw new Error('请更新客户端和服务器');
      const value = await server.tenders[method](...args);
      if (!valid()) throw new Error('账号或对话已切换，请重新打开');
      return value;
    });
  const view = createTenderCenterView({ call, onFill, valid });
  target.classList.toggle('wy-tender-connected', Boolean(server));
  target.querySelector('.wy-studio-subhero').after(view.root);
  return view;
}
