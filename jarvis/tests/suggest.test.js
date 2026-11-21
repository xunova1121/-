import { describe, it, expect } from 'vitest';
import { openingSuggestions, followUpSuggestions, calloutLayout } from '../src/core/suggest.js';

describe('光核旁的建议', () => {
  it('开场：三条，按时段与桌面版区分', () => {
    expect(openingSuggestions({ hour: 9 })).toHaveLength(3);
    expect(openingSuggestions({ hour: 9 })[0].title).toMatch(/今天/);
    expect(openingSuggestions({ hour: 21 })[0].title).toMatch(/明天/);
    expect(openingSuggestions({ desktop: true })[0].prompt).toBe('列出桌面');
  });
  it('跟进：根据刚用过的工具给出下一步', () => {
    expect(followUpSuggestions({ tools: ['write_file', 'preview'], userText: '写网页' })[0].title).toMatch(/暗色/);
    expect(followUpSuggestions({ tools: ['create_document'], userText: '做一个PPT' })[0].title).toMatch(/演讲备注/);
    expect(followUpSuggestions({ tools: ['create_document'], userText: '周报', desktop: true })[2].title).toBe('保存到桌面');
    expect(followUpSuggestions({ tools: ['create_document'], userText: '周报' })[2].panel).toBe('workspace');
    expect(followUpSuggestions({ tools: ['mcp_echo__echo'] })[0].title).toMatch(/表格/);
    expect(followUpSuggestions({ tools: [] })).toHaveLength(3);
    const err = followUpSuggestions({ error: true, userText: '你好' });
    expect(err[0]).toEqual({ title: '再试一次', prompt: '你好' });
    expect(err[2].panel).toBe('models');
    for (const list of [followUpSuggestions({ tools: ['kb_search'] }), followUpSuggestions({ tools: ['computer_run'] })]) {
      for (const s of list) expect(Boolean(s.prompt) !== Boolean(s.panel)).toBe(true);
    }
  });
  it('布局：宽屏围在光核两侧且不越界；窄屏排成一行', () => {
    const wide = calloutLayout({ width: 1000, height: 340, orb: { x: 500, y: 150, r: 60 } });
    expect(wide.mode).toBe('wide');
    for (const b of wide.boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1000);
      expect(b.y).toBeGreaterThanOrEqual(56);
    }
    expect(wide.boxes[0].x).toBeGreaterThan(560);
    expect(wide.boxes[2].x + wide.boxes[2].w).toBeLessThan(440);
    const row = calloutLayout({ width: 390, height: 300, orb: { x: 195, y: 120, r: 50 } });
    expect(row.mode).toBe('row');
    expect(row.boxes[2].x + row.boxes[2].w).toBeLessThanOrEqual(390 - 16);
    expect(row.boxes[0].x).toBeGreaterThanOrEqual(16);
  });
});
