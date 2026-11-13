import { describe, it, expect, beforeEach } from 'vitest';
import { reviewPeriod, periodBlock } from '../src/agent/periodReview.js';
import * as sessions from '../src/agent/sessions.js';
import * as memory from '../src/agent/memory.js';
import { collection } from '../src/agent/store.js';
import { buildContext } from '../src/agent/agent.js';

// 北京时间 2026-10-24 20:00（周六）
const NOW = Date.UTC(2026, 9, 24, 12, 0);
const BJ_TODAY = Date.UTC(2026, 9, 23, 16, 0); // 北京时间 10-24 0 点

describe('问“今天 / 昨天 / 这周干了什么”', () => {
  it('认得出是在问某段时间做了什么，时间按北京时间算', () => {
    expect(reviewPeriod('我今天干嘛了', NOW)).toMatchObject({ from: BJ_TODAY, label: '今天' });
    expect(reviewPeriod('今天都聊了什么', NOW).label).toBe('今天');
    expect(reviewPeriod('昨天我问了你哪些事', NOW)).toMatchObject({ from: BJ_TODAY - 86_400_000, to: BJ_TODAY, label: '昨天' });
    expect(reviewPeriod('这周忙了啥', NOW)).toMatchObject({ from: BJ_TODAY - 5 * 86_400_000, label: '这周' });
    expect(reviewPeriod('最近我们聊过什么', NOW).label).toBe('最近三天');
  });

  it('不是在问自己做了什么的不算', () => {
    for (const q of ['今天天气怎么样', '你好', '今天新闻', '帮我写今天的周报'.repeat(10)]) expect(reviewPeriod(q, NOW), q).toBeNull();
  });

  it('列出这段时间所有对话（别的对话框也算），按时间排，标出当前这段，评测对话不算', () => {
    const at = (h, m = 0) => BJ_TODAY + (h * 60 + m) * 60_000;
    const all = [
      { id: 'b', title: '成都蓉城比分', messages: [{ role: 'user', content: '现在成都蓉城比分是多少', ts: at(15, 59) }, { role: 'assistant', content: '0比0', ts: at(16) }] },
      { id: 'a', title: '仙逆PPT', messages: [{ role: 'user', content: '做一个仙逆的PPT', ts: at(9, 30) }, { role: 'assistant', content: '好了', ts: at(9, 40), files: ['仙逆.pptx'] }] },
      { id: 'c', title: '你好', messages: [{ role: 'user', content: '今天干嘛了', ts: at(19, 50) }] },
      { id: 'old', title: '昨天的', messages: [{ role: 'user', content: '昨天的事', ts: at(-3) }] },
      { id: 'e', title: '评测', evaluationId: 'x', messages: [{ role: 'user', content: '评测题', ts: at(10) }] }
    ];
    const text = periodBlock(all, reviewPeriod('今天干嘛了', NOW), { currentId: 'c' });
    expect(text).toContain('共 3 段');
    expect(text.indexOf('仙逆PPT')).toBeLessThan(text.indexOf('成都蓉城比分'));
    expect(text).toContain('09:30–09:30「仙逆PPT」');
    expect(text).toContain('仙逆.pptx');
    expect(text).toMatch(/「你好」（就是当前这段）/);
    expect(text).not.toContain('昨天的事');
    expect(text).not.toContain('评测题');
    expect(text).toContain('不要只讲当前这段对话');
  });

  it('那段时间什么都没有：照实说没有', () => {
    expect(periodBlock([], reviewPeriod('昨天干嘛了', NOW))).toContain('没有找到任何对话记录');
  });
});

describe('实际上下文', () => {
  beforeEach(async () => {
    for (const c of ['sessions', 'memories', 'episodes', 'lessons', 'skills', 'events']) {
      const col = collection(c);
      for (const x of await col.all()) await col.delete(x.id);
    }
    memory.configureMemory({});
  });

  it('在一段已经聊了很久的对话里问“今天干嘛了”，也带上今天其他对话框的内容', async () => {
    const now = Date.now();
    const other = sessions.create();
    other.title = '山东泰山比分';
    other.titleSet = true;
    other.messages.push({ role: 'user', content: '现在山东比分多少了', ts: now - 60_000 }, { role: 'assistant', content: '3比1', ts: now - 59_000 });
    other.updatedAt = now - 59_000;
    await sessions.save(other);
    const cur = sessions.create();
    for (let i = 0; i < 6; i++) cur.messages.push({ role: 'user', content: `第${i}句`, ts: now - 30_000 + i }, { role: 'assistant', content: '嗯', ts: now - 30_000 + i });
    await sessions.save(cur);
    const ctx = await buildContext('我今天干嘛了', { sessionId: cur.id, turns: 12 });
    expect(ctx.dynamic).toContain('今天的所有对话');
    expect(ctx.dynamic).toContain('山东泰山比分');
    expect(ctx.dynamic).toContain('现在山东比分多少了');
  });
});
