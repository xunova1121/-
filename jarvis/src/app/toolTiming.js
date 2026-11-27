/**
 * 回答下面那行用时里的“工具”一段：用了几次工具，花时最多的两个各用了多久，等用户点确认的时间单独写。
 * 排查“回答慢”时一眼看出是慢在模型、慢在某个工具（比如联网搜索），还是在等人点确认。
 * 数据来自工具结束事件（tool_end 的 ms、waitMs，见 agent/agentToolExecution.js）；按工具名合并，最多记 50 种。
 */
const MAX_NAMES = 50;
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

export function createToolTiming() {
  const byName = new Map();
  let waitMs = 0;
  return {
    add(e) {
      if (!e?.name || e.name === 'update_plan') return;
      const wait = Math.max(0, Number(e.waitMs) || 0);
      waitMs += wait;
      if (!byName.has(e.name) && byName.size >= MAX_NAMES) return;
      const u = byName.get(e.name) ?? { n: 0, ms: 0 };
      u.n++;
      u.ms += Math.max(0, (Number(e.ms) || 0) - wait);
      byName.set(e.name, u);
    },
    /** @param {number} count 本轮工具调用次数（智能体返回的） @param {(name: string) => string} label 工具显示名 */
    tag(count, label = (n) => n) {
      const total = count || [...byName.values()].reduce((a, u) => a + u.n, 0);
      if (!total) return '';
      const slow = [...byName]
        .filter(([, u]) => u.ms >= 1000)
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 2)
        .map(([name, u]) => `${label(name)}${u.n > 1 ? ` ${u.n} 次` : ''} ${sec(u.ms)}`);
      return ` · 工具 ${total} 次${slow.length ? `（${slow.join('，')}）` : ''}${waitMs >= 1000 ? ` · 等确认 ${sec(waitMs)}` : ''}`;
    }
  };
}
