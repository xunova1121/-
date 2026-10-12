import { describe, it, expect, beforeEach } from 'vitest';
import * as sessions from '../src/agent/sessions.js';
import { collection } from '../src/agent/store.js';

beforeEach(async () => { for (const s of await collection('sessions').all()) await collection('sessions').delete(s.id); });

describe('多会话', () => {
  it('第一句话做标题；空对话不保存', async () => {
    const empty = sessions.create();
    await sessions.save(empty);
    expect(await sessions.list()).toHaveLength(0);
    const s = sessions.create();
    s.messages.push({ role: 'user', content: '帮我写一份关于二零二六年第三季度新能源汽车市场竞争格局的分析报告', ts: 1 }, { role: 'assistant', content: '好的', ts: 2 });
    await sessions.save(s);
    const [saved] = await sessions.list();
    expect(saved.title).toBe('帮我写一份关于二零二六年第三季度新能源汽车市场竞争格局的分析报告'.slice(0, 24) + '…');
    expect(sessions.autoTitle('看看这个\n\n[已上传到工作区：a.pdf]')).toBe('看看这个');
  });

  it('重命名后不再被自动标题覆盖；钉住的排在前面', async () => {
    const a = sessions.create(); a.messages.push({ role: 'user', content: 'A', ts: 1 }); a.updatedAt = 1;
    const b = sessions.create(); b.messages.push({ role: 'user', content: 'B', ts: 2 }); b.updatedAt = 2;
    await sessions.save(a); await sessions.save(b);
    await sessions.rename(a.id, '我的标题');
    const a2 = await sessions.get(a.id);
    a2.messages.push({ role: 'user', content: '更多', ts: 3 });
    await sessions.save(a2);
    expect((await sessions.get(a.id)).title).toBe('我的标题');
    expect((await sessions.list())[0].id).toBe(b.id);
    await sessions.setPinned(a.id, true);
    expect((await sessions.list())[0].id).toBe(a.id);
  });

  it('搜索标题与内容，带命中片段；导出 Markdown；删除', async () => {
    const s = sessions.create();
    s.messages.push({ role: 'user', content: '帮我规划去成都的旅行', ts: 1 }, { role: 'assistant', content: '第一天去宽窄巷子，第二天看大熊猫', ts: 2 });
    await sessions.save(s);
    const other = sessions.create(); other.messages.push({ role: 'user', content: '写周报', ts: 3 });
    await sessions.save(other);
    const r = await sessions.search('大熊猫');
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain('大熊猫');
    expect(sessions.toMarkdown(s)).toMatch(/^# 帮我规划去成都的旅行[\s\S]*### 贾维斯[\s\S]*大熊猫/);
    await sessions.remove(s.id);
    expect((await sessions.list()).map((x) => x.id)).toEqual([other.id]);
  });

  it('旧版单条对话流迁移成一个会话（只迁移一次）', async () => {
    const m = await sessions.migrateLegacy([{ role: 'user', content: '你好', ts: 10 }, { role: 'assistant', content: '你好！', ts: 11 }]);
    expect(m.title).toBe('你好');
    expect(await sessions.migrateLegacy([{ role: 'user', content: 'x', ts: 1 }])).toBeNull();
  });
});
