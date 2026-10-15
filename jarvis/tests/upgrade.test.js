import { describe, it, expect } from 'vitest';
import { resolveQuality } from '../src/core/quality.js';
import { loadMemory, saveMemory, groupByDay, MAX_ENTRIES } from '../src/core/memoryStore.js';
import { parseMarkdown } from '../src/core/markdown.js';

describe('画质档位', () => {
  it('auto：桌面高端开泛光，移动/低端不开', () => {
    expect(resolveQuality('auto')).toMatchObject({ tier: 'high', bloom: true, fps: 60 });
    expect(resolveQuality('auto', { lowEnd: true })).toMatchObject({ tier: 'standard', bloom: false });
    expect(resolveQuality('auto', { isMobile: true })).toMatchObject({ tier: 'standard', fps: 30 });
  });
  it('软件渲染自动使用标准档，同时保留手动高画质', () => {
    expect(resolveQuality('auto', { softwareRenderer: true })).toMatchObject({ tier: 'standard', bloom: false, fps: 60 });
    expect(resolveQuality('high', { softwareRenderer: true })).toMatchObject({ tier: 'high', bloom: true, fps: 60 });
  });
  it('省电档：无泛光、无星尘、24fps', () => {
    expect(resolveQuality('eco')).toMatchObject({ bloom: false, stars: false, fps: 24 });
  });
  it('专注视图上限 20fps，移动端上限 30fps', () => {
    expect(resolveQuality('high', { focusView: true }).fps).toBe(20);
    expect(resolveQuality('high', { isMobile: true }).fps).toBe(30);
  });
});

describe('记忆', () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

  it('往返、过滤脏数据、截断到上限', () => {
    const s = mem();
    const many = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => ({ role: 'user', content: `m${i}`, ts: i }));
    saveMemory(many, s);
    const back = loadMemory(s);
    expect(back).toHaveLength(MAX_ENTRIES);
    expect(back.at(-1).content).toBe(`m${MAX_ENTRIES + 9}`);
    s.setItem('jarvis.memory.v1', JSON.stringify([{ role: 'system', content: 'x', ts: 1 }, { role: 'user', content: 'ok', ts: 2 }, { role: 'user', ts: 3 }]));
    expect(loadMemory(s)).toEqual([{ role: 'user', content: 'ok', ts: 2 }]);
    s.setItem('jarvis.memory.v1', '{bad');
    expect(loadMemory(s)).toEqual([]);
  });

  it('按天分组：今天 / 昨天 / 日期，新的在前', () => {
    const now = new Date(2026, 9, 11, 15).getTime();
    const g = groupByDay([
      { role: 'user', content: 'a', ts: new Date(2026, 9, 9, 10).getTime() },
      { role: 'user', content: 'b', ts: new Date(2026, 9, 10, 23).getTime() },
      { role: 'user', content: 'c', ts: new Date(2026, 9, 11, 1).getTime() }
    ], now);
    expect(g.map((x) => x.label)).toEqual(['今天', '昨天', '10月9日']);
  });
});

describe('极简 Markdown', () => {
  it('段落、粗体、行内代码', () => {
    expect(parseMarkdown('这是**重点**和`code`。')).toEqual([
      { type: 'p', spans: [{ text: '这是' }, { text: '重点', bold: true }, { text: '和' }, { text: 'code', code: true }, { text: '。' }] }
    ]);
  });
  it('列表与代码块', () => {
    const b = parseMarkdown('步骤：\n1. 打开\n2. 关闭\n\n```\n<script>alert(1)</script>\n```\n- 甲\n- 乙');
    expect(b.map((x) => x.type)).toEqual(['p', 'list', 'code', 'list']);
    expect(b[1]).toMatchObject({ ordered: true });
    expect(b[1].items).toHaveLength(2);
    expect(b[2].text).toBe('<script>alert(1)</script>');
    expect(b[3]).toMatchObject({ ordered: false });
  });
  it('HTML 只当纯文本', () => {
    expect(parseMarkdown('<img src=x onerror=1>')[0].spans[0].text).toBe('<img src=x onerror=1>');
  });
});

describe('Markdown 标题与表格', () => {
  it('解析 1–3 级标题', () => {
    const b = parseMarkdown('# 一\n## 二\n### 三\n#### 不是');
    expect(b.slice(0, 3).map((x) => [x.type, x.level])).toEqual([['heading', 1], ['heading', 2], ['heading', 3]]);
    expect(b[3].type).toBe('p');
  });
  it('解析表格并跳过分隔行', () => {
    const b = parseMarkdown('| 名称 | 数量 |\n| --- | :-: |\n| 苹果 | 3 |\n| 梨 | 5 |\n\n结尾');
    expect(b[0]).toEqual({ type: 'table', rows: [['名称', '数量'], ['苹果', '3'], ['梨', '5']] });
    expect(b[1].type).toBe('p');
  });
});

import { inline as mdInline } from '../src/core/markdown.js';
describe('回答里的网址做成可以点的链接', () => {
  it('“([域名](网址))”变成来源链接，去掉外面的括号和 utm 跟踪参数', () => {
    expect(mdInline('支持。([cuobiezi.net](https://www.cuobiezi.net/day/2026-10-13?utm_source=openai))')).toEqual([
      { text: '支持。' }, { text: 'cuobiezi.net', link: 'https://www.cuobiezi.net/day/2026-10-13' }
    ]);
  });
  it('裸网址也能点，句号不算进网址；只有一边括号时括号留在正文', () => {
    expect(mdInline('见 https://top.baidu.com/board?tab=realtime。')).toEqual([
      { text: '见 ' }, { text: 'https://top.baidu.com/board?tab=realtime', link: 'https://top.baidu.com/board?tab=realtime' }, { text: '。' }
    ]);
    expect(mdInline('[a.com](https://a.com))右').at(-1)).toEqual({ text: ')右' });
  });
});

import { shortTime, groupSessions } from '../src/ui/drawer.js';
describe('手机左边栏的历史对话', () => {
  it('今天的显示几点，更早的显示月/日', () => {
    const now = new Date(2026, 9, 15, 19, 40).getTime();
    expect(shortTime(new Date(2026, 9, 15, 9, 5).getTime(), now)).toBe('09:05');
    expect(shortTime(new Date(2026, 9, 3, 9, 5).getTime(), now)).toBe('10/3');
    expect(groupSessions([{ updatedAt: now }, { updatedAt: now - 30 * 864e5 }], now).map(([g]) => g)).toEqual(['今天', '更早']);
  });
});
