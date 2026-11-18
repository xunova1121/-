/**
 * 对话列表读取（2026-11-18 用户：电脑老是掉线、对话全没了）。
 *
 * 电脑左栏原来每 3 秒向服务器要一次全部对话，只要一次超过 5 秒没拿到就把列表整个清空，
 * 显示“历史对话暂不可用”，看起来像对话全丢了；手机抽屉一直是读不到就保留上次的列表。
 * 这里统一成手机的做法：读不到时用上次显示的或本机副本里的列表，只加一行提示；
 * 只有登录失效（401）才换成重新登录的提示。刷新也从 3 秒一次改成 30 秒一次，切回窗口、回答做完时再立刻刷新。
 */
export const HISTORY_REFRESH_MS = 30000;
export const STALE_HINT = '暂时连不上服务器，显示的是上次的对话列表';
export const LOGIN_HINT = '登录已失效，请到设置重新登录。';
export const EMPTY_HINT = '暂时读不到对话列表（网络不好？），稍后会自动重试';

/**
 * @param {{ list: () => Promise<any[]>, cached?: () => any[] | null, shown?: () => any[] | null }} o
 * @returns {Promise<{ rows: any[] | null, stale: boolean, hint: string }>}
 *   rows=null 表示手上什么都没有，只显示 hint；stale=true 表示显示的是旧列表
 */
export async function loadHistory({ list, cached = () => null, shown = () => null }) {
  try {
    return { rows: await list(), stale: false, hint: '' };
  } catch (error) {
    if (error?.status === 401) return { rows: null, stale: false, hint: LOGIN_HINT };
    const old = shown?.()?.length ? shown() : cached?.();
    return old?.length ? { rows: old, stale: true, hint: STALE_HINT } : { rows: null, stale: false, hint: EMPTY_HINT };
  }
}
