import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { normalizeVisualDesign, visualNumber } from '../src/agent/visualSceneInput.js';
import { composeVisualScene } from '../src/agent/visualScene.js';
import { validateVisualSceneSvg } from '../src/agent/visualSceneSvg.js';
import { composePoster } from '../src/agent/posterComposition.js';
import { validatePosterSvg } from '../src/agent/posterSvg.js';

const parse = svg => new DOMParser().parseFromString(svg, 'image/svg+xml');
const all = (svg, tag) => Array.from(parse(svg).getElementsByTagName(tag));
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), ch => ch.charCodeAt(0));

describe('独立视觉设计参数', () => {
  it('默认4K演示设计，JSON可重用且不跟随系统时钟编造当前时间', () => {
    const design = normalizeVisualDesign({});
    expect(design).toMatchObject({ width: 3840, height: 2160, dataMode: 'demo', kind: 'visual_scene', version: 1, theme: 'midnight' });
    expect(design.asOf).toBe('演示时刻 14:30');
    expect(design).toMatchObject({ seriesLabel: '气温', seriesUnit: '℃' });
    expect(normalizeVisualDesign(JSON.parse(JSON.stringify(design)))).toEqual(design);
    expect(normalizeVisualDesign({ preset: 'operations' }).theme).toBe('light');
  });

  it('提供数据必须注明来源，未知值不使用演示默认补齐', () => {
    expect(() => normalizeVisualDesign({ dataMode: 'provided' })).toThrow(/来源/);
    const design = normalizeVisualDesign({ dataMode: 'provided', source: '用户上传观测表' });
    expect([design.metrics, design.series, design.alerts, design.markers]).toEqual([[], [], [], []]);
    expect(design.asOf).toBe('时间未提供');
    expect(design).toMatchObject({ seriesLabel: '', seriesUnit: '' });
    const checked = validateVisualSceneSvg(composeVisualScene(design).svg);
    expect(checked.text).toContain('暂无指标数据');
    expect(checked.text).not.toContain('23.6');
    expect(checked.text).toContain('未独立核验');
  });

  it('数字字符串完整解析，保留指标原字符串', () => {
    const design = normalizeVisualDesign({ width: '３８４０', height: '2,160', metrics: [{ label: '数量', value: '1,234.50', unit: '项' }], series: [{ label: '一', value: '1,234.50' }], markers: [{ name: '站点', lon: '116.40', lat: '39.9', value: 21.5 }] });
    expect(design.metrics[0].value).toBe('1,234.50');
    expect(design.series[0].value).toBe(1234.5);
    expect(design.markers[0]).toMatchObject({ lon: 116.4, lat: 39.9, value: '21.5' });
    for (const value of ['1–2', '1,23', '未知', '', '12mm', Infinity, null, {}]) expect(() => visualNumber(value, '数据')).toThrow();
  });

  it.each([['red', 'critical'], ['红色预警', 'critical'], ['黄色', 'warning'], ['orange', 'warning'], ['蓝色', 'info']])('预警级别%s可自然归一', (level, expected) => {
    expect(normalizeVisualDesign({ alerts: [{ title: '预警', level }] }).alerts[0].level).toBe(expected);
  });

  it('限制数据量、超范围坐标、无效字符与画布大小，不静默截断', () => {
    for (const input of [{ metrics: Array.from({ length: 5 }, () => ({})) }, { markers: [{ lon: 181, lat: 40 }] }, { series: [{ value: NaN }] }, { title: '长'.repeat(37) }, { title: '文字\u0001' }, { title: '\ud800' }, { width: 5000 }, { width: 3840, height: 1000 }, { kind: 'other' }, { version: 2 }]) expect(() => normalizeVisualDesign(input)).toThrow();
  });
});

describe('同一设计生成可复用静态场景', () => {
  it.each(['weather', 'operations'])('%s预设同设计同SVG，中文完整且有明确演示标记', preset => {
    const design = normalizeVisualDesign({ preset }), before = JSON.stringify(design);
    const scene = composeVisualScene(design), checked = validateVisualSceneSvg(scene.svg);
    expect(composeVisualScene(design).svg).toBe(scene.svg);
    expect(JSON.stringify(design)).toBe(before);
    expect(checked).toMatchObject({ width: 3840, height: 2160 });
    expect(checked.text).toBe(scene.texts.join(''));
    expect(checked.text).toContain('演示数据 · 非实时气象或业务信息');
    expect(checked.text).toContain('Natural Earth · 地理示意');
    expect(checked.text).toContain('雷达图层为视觉示意');
    expect(checked.families).toContain('Noto Sans CJK SC');
    expect(all(scene.svg, 'path').length).toBeGreaterThanOrEqual(6);
  });

  it('每个交互元素都有稳定类型与索引，选择状态不改原数据', () => {
    const design = normalizeVisualDesign({});
    const scene = composeVisualScene(design, { state: { markerIndex: 1, seriesIndex: 2 } });
    const doc = parse(scene.svg), elements = Array.from(doc.getElementsByTagName('*'));
    expect(doc.documentElement.getAttribute('id')).toBe('visual-scene');
    for (const [kind, amount] of [['metric', 4], ['marker', 6], ['series-point', 8], ['alert', 3], ['radar', 1], ['grid', 1], ['time-label', 1]]) {
      const selected = elements.filter(node => node.getAttribute('data-viz') === kind);
      expect(selected).toHaveLength(amount);
      if (!['radar', 'grid'].includes(kind)) expect(selected.map(node => node.getAttribute('data-index'))).toEqual(Array.from({ length: amount }, (_, index) => String(index)));
    }
    expect(validateVisualSceneSvg(scene.svg).text).toBe(validateVisualSceneSvg(composeVisualScene(design).svg).text);
  });

  it('长来源、动态正文和时间完整保留，恶意样式文本只作字体文字', () => {
    const source = '用户上传的统计表'.repeat(10);
    const detail = '这是完整的关注详情'.repeat(6);
    const design = normalizeVisualDesign({ dataMode: 'provided', source, title: '文字<script>不是代码', alerts: [{ title: '完整动态标题', detail, time: '2026年十一月十二日北京时间十四点三十分' }] });
    const scene = composeVisualScene(design), checked = validateVisualSceneSvg(scene.svg);
    expect(checked.text).toContain(source);
    expect(checked.text).toContain(detail);
    expect(checked.text).toContain(design.alerts[0].time);
    expect(checked.text).toContain('文字<script>不是代码');
    expect(scene.svg).not.toContain('<script>');
  });

  it('背景保留原位图字节与原输出尺寸，不混入HTML或外链', () => {
    const scene = composeVisualScene({}, { background: { bytes: PNG, mime: 'image/png' } });
    expect(all(scene.svg, 'image')).toHaveLength(1);
    expect(all(scene.svg, 'image')[0].getAttribute('href')).toBe('data:image/png;base64,' + btoa(String.fromCharCode(...PNG)));
    expect(all(scene.svg, 'image')[0].getAttribute('x')).toBe('68');
    expect(all(scene.svg, 'image')[0].getAttribute('width')).toBe('1124');
    expect(scene.backgroundPlacement).toMatchObject({ mode: 'map', fit: 'cover', x: 136, y: 760, width: 2248, height: 1000, sourceWidth: 1, sourceHeight: 1, overlayOpacity: 0.28 });
    expect(validateVisualSceneSvg(scene.svg)).toMatchObject({ width: 3840, height: 2160 });
    expect(() => composeVisualScene({}, { background: { bytes: new Uint8Array([1, 2]), mime: 'image/png' } })).toThrow();
  });

  it('海报原SVG可供HTML复用，新场景不会扩大原海报校验', async () => {
    const poster = await composePoster({ title: '中文海报', width: 960, height: 540, background: { bytes: PNG, mime: 'image/png' } });
    expect(validateVisualSceneSvg(poster.svg)).toMatchObject({ width: 960, height: 540, text: '中文海报' });
    expect(validatePosterSvg(poster.svg).text).toBe('中文海报');
    expect(() => validatePosterSvg(composeVisualScene({}).svg)).toThrow();
  });

  it('长指标标签与详情分行，最大数字和单位共用卡内宽度，完整保留中文', () => {
    const metric = { label: '全区域每日累计有效观测站点总数', value: '123456789012345678', unit: '毫克每立方米每秒', detail: '本项统计覆盖全区域全部有效观测站点采用最近二十四小时数据' };
    const scene = composeVisualScene({ metrics: Array.from({ length: 4 }, () => metric) });
    const groups = all(scene.svg, 'g').filter(node => node.getAttribute('data-viz') === 'metric');
    groups.forEach(group => {
      const text = Array.from(group.getElementsByTagName('text'));
      expect(text.map(node => node.textContent).join('')).toBe(metric.label + metric.value + metric.unit + metric.detail);
      const label = text[0], value = text[1], unit = text[2], details = text.slice(3);
      expect(Number(label.getAttribute('y'))).toBeLessThan(Number(value.getAttribute('y')) - Number(value.getAttribute('font-size')));
      expect(Number(unit.getAttribute('font-size'))).toBeLessThan(15);
      expect(Number(value.getAttribute('font-size'))).toBeLessThan(25);
      expect(details.every(node => Number(node.getAttribute('y')) > Number(value.getAttribute('y')) + 10)).toBe(true);
    });
    expect(validateVisualSceneSvg(scene.svg).text).toContain(metric.label);
  });
});

describe('独立视觉SVG的有界静态输入', () => {
  const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">${body}<text x="10" y="30" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="20" fill="#fff">安全中文</text></svg>`;
  it('允许有界路径/折线/渐变，原尺寸与字体权重可审查', () => {
    const checked = validateVisualSceneSvg(svg('<defs><linearGradient id="sky"><stop offset="0" stop-color="#123"/><stop offset="100%" stop-color="#abcdef"/></linearGradient></defs><g transform="translate(1 2) scale(1.2)"><rect width="20" height="30" fill="url(#sky)"/><path d="M0 0 L10 20 Q20 30 40 20 Z" fill="none" stroke="#fff"/><polyline points="0,0 1,2 3,4" fill="none"/></g>'));
    expect(checked).toMatchObject({ width: 640, height: 360, weights: ['400'] });
  });

  it.each([
    '<script>alert(1)</script>', '<foreignObject/>', '<rect width="20" height="20" onclick="alert(1)"/>', '<rect width="20" height="20" style="fill:red"/>',
    '<image href="https://example.com/a.png" width="20" height="20"/>', '<image href="file:///etc/passwd" width="20" height="20"/>', '<image href="data:image/svg+xml;base64,PHN2Zz4=" width="20" height="20"/>',
    '<rect width="20" height="20" fill="url(https://example.com/x)"/>', '<rect width="20" height="20" fill="url(#missing)"/>', '<rect id="loop" width="20" height="20" fill="url(#loop)"/>',
    '<defs><linearGradient id="same"/><radialGradient id="same"/></defs>', '<g transform="translate(NaN 0)"/>', '<g transform="scale(1000)"/>', '<path d="M0 0 L1e20 0"/>', '<path d="M0 0 garbage"/>',
    '<circle r="-1"/>', '<rect width="20" height="20" fill-opacity="2"/>', '<rect width="20" height="20" unknown="1"/>', '<text font-family="remote">其他字</text>', '<text font-family="Noto Sans CJK SC"><tspan font-family="Noto Serif CJK SC">字体绕过</tspan></text>',
    '<g><g><g><g><g><g><g><g><g><g><g><rect width="1" height="1"/></g></g></g></g></g></g></g></g></g></g></g>'
  ])('拒绝活动/外链/循环/无界图形 %s', body => {
    expect(() => validateVisualSceneSvg(svg(body))).toThrow();
  });

  it('拒绝实体、超大源、超多节点、尺寸偷换与空文字', () => {
    expect(() => validateVisualSceneSvg(svg('<!DOCTYPE x [<!ENTITY x "boom">]>'))).toThrow();
    expect(() => validateVisualSceneSvg(' '.repeat(16e6 + 1))).toThrow(/16MB/);
    expect(() => validateVisualSceneSvg(svg('<circle r="1"/>'.repeat(6001)))).toThrow();
    expect(() => validateVisualSceneSvg(svg('').replace('viewBox="0 0 640 360"', 'viewBox="0 0 1280 720"'))).toThrow();
    expect(() => validateVisualSceneSvg(svg('').replace('安全中文', ''))).toThrow();
  });
});
