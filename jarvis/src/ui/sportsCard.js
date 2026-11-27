import { SPORTS_CARD_LIMIT, withoutRetiredSports } from '../agent/sportsSnapshot.js';
import './sportsCard.css';

const clock = value => {
  const date = new Date(value + 28800000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(5, 16).replace('T', ' ') : '时间未提供';
};
const node = (tag, cls, words) => Object.assign(document.createElement(tag), { className: cls, textContent: String(words ?? '') });
/** 赛程来自程序回执，全部按文本渲染，绝不执行模型/上游HTML。卡片最多12场。 */
export function createSportsCard(initial, refresh) {
  const box = node('section', 'sports-card');
  box.setAttribute('aria-label', '赛程卡');
  let value = withoutRetiredSports(initial), busy = false, lastRefresh = 0;
  const paint = (error = '') => {
    const head = node('div', 'sports-card-head');
    head.append(node('strong', '', '赛程速览'), node('span', 'sports-card-zone', '北京时间'));
    const button = node('button', 'sports-card-refresh', busy ? '刷新中…' : '刷新');
    button.type = 'button'; button.disabled = busy || !refresh;
    button.onclick = async () => {
      if (busy) return;
      if (Date.now() - lastRefresh < 5000) { paint('请稍候几秒再刷新'); return; }
      busy = true; lastRefresh = Date.now(); paint();
      try {
        const fresh = await refresh(value.query, AbortSignal.timeout(20000));
        if (!fresh || fresh.version !== 1 || !Array.isArray(fresh.events)) throw Error('赛程返回无效，未替换旧结果');
        value = withoutRetiredSports(fresh); busy = false; paint();
      } catch (e) { busy = false; paint(`刷新失败，保留上次结果：${String(e.message).slice(0, 100)}`); }
    };
    head.append(button);
    const details = node('p', 'sports-card-window', value.label || '所查日期赛程');
    const list = node('div', 'sports-card-list');
    const extra = node('details', 'sports-card-more');
    const remaining = Math.max(0, Math.min(value.events?.length || 0, SPORTS_CARD_LIMIT) - 6);
    if (remaining) extra.append(node('summary', '', `展开其余 ${remaining} 场`));
    let visibleCount = 0;
    for (const e of (value.events || []).slice(0, SPORTS_CARD_LIMIT)) {
      const row = node('article', 'sports-card-match' + (e.state === 'in' ? ' is-live' : ''));
      const meta = node('div', 'sports-match-meta');
      meta.append(node('span', '', String(e.league || '联赛名未提供').slice(0, 64)), node('time', '', Number.isFinite(e.time) ? clock(e.time) : '时间未提供'));
      const teams = node('div', 'sports-match-teams');
      teams.append(node('span', '', String(e.home).slice(0, 64)), node('b', 'sports-match-score', e.score), node('span', '', String(e.away).slice(0, 64)));
      const statusLine = node('div', 'sports-match-status');
      statusLine.append(node('span', '', e.status));
      if ((value.sources || []).length > 1 || e.jingcai) statusLine.append(node('span', '', (value.sources || []).length > 1 ? e.source : '来源标记竞彩'));
      row.append(meta, teams, statusLine);
      (visibleCount++ < 6 ? list : extra).append(row);
    }
    if (!list.children.length) list.append(node('p', 'sports-card-empty', '本次窗口未返回符合条件的比赛，不代表没有比赛。'));
    if (remaining) list.append(extra);
    const source = node('p', 'sports-card-source', (value.sources || []).slice(0, 2).map(s => `${s.name}返回${s.count}场`).join('；') + (value.truncated ? '；卡片仅列前12场，可按球队/联赛缩小查询' : ''));
    const updated = node('p', 'sports-card-updated', Number.isFinite(value.fetchedAt) ? `查询于 ${clock(value.fetchedAt)}；比分以查询时为准` : '查询时间未知');
    box.replaceChildren(head, details, list, source, updated);
    if (value.notice) box.append(node('p', 'sports-card-notice', value.notice));
    box.append(node('p', 'sports-card-lottery', value.lotteryNote));
    if (error) { const alert = node('p', 'sports-card-error', error); alert.setAttribute('role', 'status'); box.append(alert); }
  };
  paint();
  return box;
}
