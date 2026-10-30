import { describe, it, expect } from 'vitest';
import { weatherOverview, weatherMetrics, weatherTravelAdvice } from '../src/ui/weatherDetails.js';

describe('天气卡片真实数据展示', () => {
  it('有效预警优先于普通好天气建议，过期预警不冒充实时', () => {
    const data = { code: 0, temp: 21, days: [], extra: { alerts: [{ title: '大风蓝色预警' }] } };
    expect(weatherTravelAdvice(data)).toContain('预警');
    expect(weatherTravelAdvice(data)).not.toContain('天气还不错');
    expect(weatherTravelAdvice(data, { stale: true })).toContain('暂未更新');
  });
  it('缺失和异常值不变成零、undefined或NaN，真实零度和零降水保留', () => {
    expect(weatherMetrics({ extra: { feels: undefined, humidity: null, vis: NaN, pressure: Infinity, precip: 0 } })).toEqual([['近1小时降水', '0 mm']]);
    expect(weatherOverview({ temp: 0, code: 0, days: [{ low: null, high: 12 }] })).toBe('晴');
    expect(weatherMetrics({ extra: { feels: 0, humidity: 0, air: { aqi: 0, category: '优' } } })).toEqual([
      ['体感温度', '0°'],
      ['相对湿度', '0%'],
      ['空气质量', '0 · 优']
    ]);
  });
  it('温度范围和缓存标记展示，Open-Meteo不伪造和风专属指标', () => {
    const data = { code: 61, text: '小雨', days: [{ low: 14, high: 21 }] };
    expect(weatherOverview(data, { stale: true })).toBe('缓存 · 小雨 14° / 21°');
    expect(weatherMetrics(data)).toEqual([]);
    expect(weatherOverview(null)).toBe('查看天气');
  });
  it('和风指标保留单位、风力和日出日落，不丢生活数据', () => {
    const data = { days: [{ uv: 3, sunrise: '06:10', sunset: '17:25' }], extra: { wind: '东北风 3级（15 km/h）', vis: 8, pressure: 1012, humidity: 88 } };
    expect(weatherMetrics(data)).toEqual([
      ['相对湿度', '88%'],
      ['风向风力', '东北风 3级'],
      ['紫外线指数', '3'],
      ['能见度', '8 km'],
      ['气压', '1012 hPa'],
      ['日出 / 日落', '06:10 / 17:25']
    ]);
  });
});
