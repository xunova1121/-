import { describe, it, expect } from 'vitest';
import { addSample, emptyStats, insightsFrom, hintFor, normalizeApp } from '../src/agent/habits.js';
import { parseLsappinfo, winScript } from '../desktop/activity.mjs';

/** 模拟 n 天：每天 9:00–12:00 用 VS Code，14:00–17:00 用 Excel，每天先开 VS Code */
function week(n = 5) {
  const s = emptyStats();
  for (let d = 0; d < n; d++) {
    const day = new Date(2026, 9, 5 + d); // 10/5 是周一
    for (let m = 9 * 60; m < 12 * 60; m += 1) addSample(s, { app: 'Code.exe', ts: day.getTime() + m * 60000 + (m % 3) * 20000 });
    for (let m = 14 * 60; m < 17 * 60; m += 1) addSample(s, { app: 'EXCEL', ts: day.getTime() + m * 60000 });
    addSample(s, { app: 'Jarvis', ts: day.getTime() + 18 * 3600000 });
  }
  return s;
}

describe('操作习惯', () => {
  it('程序名规范化，未央自己不算', () => {
    expect(normalizeApp('Code.exe')).toBe('VS Code');
    expect(normalizeApp('WeChat')).toBe('微信');
    expect(normalizeApp('Jarvis')).toBe('');
    expect(normalizeApp('Blender')).toBe('Blender');
  });
  it('不到 3 天不下结论', () => {
    const r = insightsFrom(week(2));
    expect(r.ready).toBe(false);
    expect(r.days).toBe(2);
  });
  it('得出开始时间、常用程序、时段和开机先开的程序', () => {
    const r = insightsFrom(week(5));
    expect(r.ready).toBe(true);
    expect(r.insights).toContain('工作日通常 09:00 左右开始用电脑，16:59 左右结束');
    expect(r.insights.find((t) => t.startsWith('最常用的程序'))).toMatch(/VS Code（50%）、Excel（50%）/);
    expect(r.insights).toContain('上午主要在用 VS Code');
    expect(r.insights).toContain('下午主要在用 Excel');
    expect(r.insights).toContain('开始用电脑时通常先打开 VS Code');
  });
  it('此刻的建议', () => {
    const s = week(5);
    expect(hintFor(s, new Date(2026, 9, 12, 10, 0))).toEqual(['这个时间你通常会用 VS Code，需要的话我帮你打开']);
    expect(hintFor(s, new Date(2026, 9, 12, 20, 0))).toEqual([]);
  });
  it('采样器的平台细节', () => {
    expect(parseLsappinfo('"LSDisplayName"="Safari"')).toBe('Safari');
    expect(winScript(20)).toContain('Start-Sleep -Seconds 20');
    expect(winScript(1)).toContain('Start-Sleep -Seconds 5');
  });
});
