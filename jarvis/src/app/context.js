/**
 * 应用上下文 app：各模块共用的状态和彼此的函数都挂在它上面。
 *
 *   const app = createApp({ settings });
 *   mount(app, createStage(app));   // 模块返回的函数挂到 app 上，别的模块用 app.xxx 调用
 *
 * 规则：
 * - 模块里只在“用到的时候”读 app.xxx，不要在创建模块时就把别的模块的东西取出来存着（那时可能还没创建）
 * - 会变的共享状态直接放在 app 上（如 app.session、app.active），谁都可以读，改的地方尽量少
 * - app.history 永远是 app.session.messages（换对话只改 app.session）
 */
export function createApp(fields = {}) {
  const app = {
    session: null,
    active: null, // 正在回答的这一轮 { ctrl, streamDone, bubble, session, ... }
    liveBubble: null, // 正在回答的气泡（画图工具把图片放进去）
    gateway: null, // 完整版：{ origin, keys, ... }；单文件版没连上本机网关时为 null
    llmConfig: null,
    ...fields
  };
  Object.defineProperty(app, 'history', { get: () => app.session.messages, enumerable: true });
  return app;
}

/** 把模块返回的函数 / getter 挂到 app 上（getter 保持实时，不会被复制成当时的值）；重名直接报错 */
export function mount(app, api) {
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(api))) {
    if (k in app) throw new Error(`app.${k} 重名`);
    Object.defineProperty(app, k, { ...d, enumerable: true, configurable: true });
  }
  return api;
}
