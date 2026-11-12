import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CHINA_MAP_LICENSE,
  CHINA_MAP_SOURCE,
  CHINA_MAP_VIEWBOX,
  chinaMapPaths,
  projectChina,
} from '../src/agent/visualChinaMap.js';

const points = d => [...d.matchAll(/[ML](-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(match => [Number(match[1]), Number(match[2])]);

// 按真实陆地形状检查代表城市，避免只验证“生成了一个路径”而漏掉关键岛屿。
function contains(d, lon, lat) {
  const { x, y } = projectChina(lon, lat);
  return d.split('Z').filter(Boolean).some(ring => {
    const vertices = points(ring);
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const [xi, yi] = vertices[i];
      const [xj, yj] = vertices[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}

describe('视觉场景地图：固定来源、范围和可用地理形状', () => {
  it('城市与轮廓共用960×720投影；东西和南北顺序正确', () => {
    expect(CHINA_MAP_VIEWBOX).toEqual({ width: 960, height: 720, west: 70, east: 140, south: 15, north: 55 });
    expect(projectChina(70, 55)).toEqual({ x: 0, y: 0 });
    expect(projectChina(140, 15)).toEqual({ x: 960, y: 720 });
    expect(projectChina(105, 35)).toEqual({ x: 480, y: 360 });
    expect(projectChina(116.4074, 39.9042).x).toBeGreaterThan(projectChina(104.0665, 30.5723).x);
    expect(projectChina(116.4074, 39.9042).y).toBeLessThan(projectChina(104.0665, 30.5723).y);
  });

  it('不把非法坐标渲染为NaN，也不把视图外合法城市钳到边缘', () => {
    for (const coordinate of [[NaN, 30], [100, Infinity], [181, 30], [100, 91], ['100', 30], [100, null]]) {
      expect(() => projectChina(...coordinate)).toThrowError(expect.objectContaining({ code: 'VISUAL_MAP_COORDINATE_INVALID' }));
    }
    expect(projectChina(103.8198, 1.3521).y).toBeGreaterThan(720);
    expect(projectChina(0, 40).x).toBeLessThan(0);
  });

  it('84个源多边形保留且所有坐标有界，静态数据无脚本/外部引用', () => {
    const paths = chinaMapPaths();
    expect(paths).toHaveLength(4);
    expect(paths.map(path => path.d.match(/Z/g).length)).toEqual([70, 8, 4, 2]);
    let count = 0;
    for (const { id, name, d } of paths) {
      expect(id).toMatch(/^[a-z-]{1,30}$/);
      expect(name.length).toBeLessThan(16);
      expect(d).toMatch(/^(?:M\d+(?:\.\d{1,2})?,\d+(?:\.\d{1,2})?(?:L\d+(?:\.\d{1,2})?,\d+(?:\.\d{1,2})?){2,}Z)+$/);
      for (const [x, y] of points(d)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(960);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(720);
        count++;
      }
    }
    expect(count).toBeGreaterThan(1000);
    expect(count).toBeLessThan(7000);
    expect(Buffer.byteLength(JSON.stringify(paths))).toBeLessThan(250000);
  });

  it('大陆、海南、台湾、香港及澳门均有实际陆地覆盖，海上没有整块假轮廓', () => {
    const paths = Object.fromEntries(chinaMapPaths().map(path => [path.id, path.d]));
    for (const [lon, lat] of [[116.4074, 39.9042], [104.0665, 30.5723], [87.6168, 43.8256], [109.5, 19.2]]) {
      expect(contains(paths['mainland-islands'], lon, lat), `${lon},${lat}`).toBe(true);
    }
    expect(contains(paths['taiwan-islands'], 121.5654, 25.033)).toBe(true);
    expect(contains(paths['hong-kong'], 114.177, 22.34)).toBe(true);
    expect(contains(paths.macao, 113.5439, 22.1987)).toBe(true);
    for (const d of Object.values(paths)) expect(contains(d, 130, 20)).toBe(false);
  });

  it('来源固定到完整提交和摘要，许可证据随模块保留且声明局部示意', () => {
    expect(CHINA_MAP_LICENSE).toBe('Public domain');
    expect(CHINA_MAP_SOURCE.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(CHINA_MAP_SOURCE.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(CHINA_MAP_SOURCE.url).toContain(`/${CHINA_MAP_SOURCE.revision}/geojson/`);
    expect(CHINA_MAP_SOURCE.notice).toMatch(/非官方审定地图.*北纬15°—55°/);
    const license = readFileSync(new URL('../licenses/natural-earth-LICENSE.txt', import.meta.url), 'utf8');
    expect(license).toContain(CHINA_MAP_SOURCE.sha256);
    expect(license).toContain(CHINA_MAP_SOURCE.revision);
    expect(license).toContain('are in the public domain');
    expect(license).toContain('北纬 15°以南范围不在该视口内');
  });

  it('调用方改动返回值不会污染后续交付图', () => {
    const paths = chinaMapPaths();
    const original = paths[0].d;
    paths[0].d = 'M0,0L1,1L0,1Z';
    paths.push({ id: 'fake', name: 'fake', d: '' });
    expect(chinaMapPaths()).toHaveLength(4);
    expect(chinaMapPaths()[0].d).toBe(original);
  });
});
