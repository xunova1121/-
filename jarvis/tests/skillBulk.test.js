import { describe, it, expect } from 'vitest';
import { searchText, matches } from '../src/ui/skillBulk.js';

describe('搜索已安装技能', () => {
  it('名字、中文标题、说明、来源都能搜；几个词都要命中；不分大小写', () => {
    const t = searchText({ name: 'football-data', description: 'Football (soccer) standings', source: 'github.com/machina-sports/sports-skills' }, '足球数据');
    expect(matches(t, '足球')).toBe(true);
    expect(matches(t, 'SOCCER')).toBe(true);
    expect(matches(t, 'machina football')).toBe(true);
    expect(matches(t, 'nba')).toBe(false);
    expect(matches(t, '  ')).toBe(true);
  });
});
