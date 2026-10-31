import { newsDate } from '../newsSources.js';
import { relevantRecoverySearch } from './recoverySearch.js';
import { withWebDeadline } from './request.js';
import { lastGoodKey } from './lastGood.js';
import { failureKind, failureSentence, usefulReceipt, receiptLinks, recoveryText, QUERY_LABELS } from './recoveryData.js';

/** 程序负责有界自救；全部操作共用调用方的时钟、次数账本和取消信号。 */
export async function recoverLookup(intent, plan, options) {
  const { signal, text = '', execute, getTool, lastGood, clock, retrieval } = options;
  const now = options.nowFn || Date.now;
  const attempts = [];
  const key = lastGoodKey(intent, plan, text);
  const left = () => Math.min(clock?.retrievalRemaining() ?? Infinity, retrieval?.remaining ?? Infinity);
  const check = () => { if (signal?.aborted) throw signal.reason || Object.assign(new Error('已停止'), { name: 'AbortError' }); };
  async function attempt(call, label, timeoutMs) {
    check();
    if (!getTool(call.name) || left() <= 250) return null;
    try {
      const [row] = await withWebDeadline(s => execute([{ id: `lookup-recovery-${attempts.length}`, ...call }], s), { signal, timeoutMs: Math.min(timeoutMs, left()) });
      check();
      if (!row?.ok) throw Object.assign(new Error('来源未取得结果'), row?.failure || {});
      const found = { tool: call.name, args: call.args, query: call.args.query || '', output: String(row.output || '') };
      if (call.name === 'web_search' && attempts.length) found.output = relevantRecoverySearch(found.output, intent, plan.args, text);
      if (!usefulReceipt(found)) throw Object.assign(new Error('来源没有有效条目'), { code: 'LOOKUP_EMPTY' });
      attempts.push({ label, state: 'ok' });
      return found;
    } catch (error) {
      check();
      if (error.code === 'RETRIEVAL_BUDGET') { attempts.push({ label, failure: 'budget' }); return null; }
      const failure = failureKind(error);
      attempts.push({ label, failure });
      if (failure === 'input') return { tool: plan.name, args: plan.args, output: intent.kind === 'weather' ? '你想查哪个城市或区县的天气？' : '请告诉我证券代码和要查询的价格口径。', recovery: { state: 'input', attempts } };
      return null;
    }
  }
  async function finish(found) {
    check();
    const changed = attempts.some(a => a.failure) || found.tool !== plan.name;
    const auth = attempts.some(a => a.failure === 'auth');
    found.recovery ||= { state: changed ? 'recovered' : 'fresh', attempts,
      note: changed ? `原${QUERY_LABELS[intent.kind] || '查询来源'}暂时没有结果，已改用${attempts.at(-1)?.label || '其他来源'}取得以下内容${auth ? '；原来源授权或额度有问题，请在设置中检查' : ''}。` : '' };
    await lastGood?.put(key, intent.kind, found, { signal });
    return found;
  }
  const label = QUERY_LABELS[intent.kind] || '查询来源';
  let found = await attempt({ name: plan.name, args: plan.args }, label, plan.timeoutMs);
  if (found) return found.recovery?.state === 'input' ? found : finish(found);
  // 原天气/行情/搜索已含逐源重试与后备，不重新跑整条链；其他偶发只短重试一次。
  if (!['get_weather', 'get_stock_kline', 'web_search'].includes(plan.name) && attempts.at(-1)?.failure === 'transient') {
    found = await attempt({ name: plan.name, args: plan.args }, label + '短重试', 2000);
    if (found) return finish(found);
  }
  // 专用源全失败才搜索；词中保留用户原始范围，不把体育资讯改为比分。
  const query = intent.kind === 'weather' ? `${plan.args.place} ${text || '今天天气'}` : text;
  if (getTool('web_search') && query.trim()) {
    found = await attempt({ name: 'web_search', args: { query: plan.name === 'web_search' ? query.replace(/[？?。！!]/g, '').trim() + ' 官方资料' : query } }, '公开搜索', 5000);
    if (!found && left() > 250) {
      const topic = { weather: '天气预报', sports_live: /篮球|NBA|CBA/i.test(text) ? '篮球赛程 对阵' : '足球赛程 对阵 直播吧', sports_news: '体育新闻报道', news: '新闻报道', market: '股票收盘价', general: '官方信息' }[intent.kind];
      const date = plan.args.date || newsDate(now());
      found = await attempt({ name: 'web_search', args: { query: `${query} ${date} ${topic}`.slice(0, 300) } }, '换词搜索', 3000);
    }
    if (found) {
      // 摘要不冒充原文。读取至多两个真实链接，仍经原安全网关/白名单。
      const search = found;
      const links = receiptLinks(search.output);
      search.output = recoveryText(search);
      for (const url of links) {
        const name = /\.json(?:\?|$)/i.test(url) && getTool('fetch_json') ? 'fetch_json' : 'fetch_url';
        const page = await attempt({ name, args: { url } }, name === 'fetch_json' ? '受信公开接口' : '来源原文', 3000);
        if (page) {
          // 保留原搜索结果及来源链接；不替换或拼接不同来源的结构化数值。
          search.output += `\n\n来源原文：${url}\n${page.output.slice(0, 6000)}`;
          break;
        }
      }
      return finish(search);
    }
  }
  // 没有搜索结果时仅能读取原问题已有链接；绝不猜接口或绕过域名白名单。
  for (const url of receiptLinks(text)) {
    const name = /\.json(?:\?|$)/i.test(url) && getTool('fetch_json') ? 'fetch_json' : 'fetch_url';
    found = await attempt({ name, args: { url } }, name === 'fetch_json' ? '受信公开接口' : '指定网页', 3000);
    if (found) return finish(found);
  }
  check();
  const cached = await lastGood?.get(key, intent.kind, { signal });
  check();
  if (cached) {
    const time = new Date(cached.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    return { ...cached.found, recovery: { state: 'cached', attempts, fetchedAt: cached.at,
      note: `现查没成功，这是北京时间${time}查到的数据${intent.kind === 'sports_live' ? `（${Math.max(0, Math.floor((now() - cached.at) / 60000))}分钟前的状态，并非实时比分）` : '，不是本次实时更新'}。` } };
  }
  return { tool: plan.name, args: plan.args, output: failureSentence(intent.kind, attempts), recovery: { state: 'failed', attempts } };
}
