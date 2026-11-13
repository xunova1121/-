/** 视觉设计稿只保留有界 JSON；演示数据与用户提供的数据分开，不把缺测补成真实读数。 */
export const VISUAL_LIMITS = Object.freeze({ bytes: 16e6, nodes: 6000, side: 4096, pixels: 16e6, text: 16000, metrics: 4, series: 24, alerts: 3, markers: 12 });
export const visualError = (message, code = 'VISUAL_INPUT') => Object.assign(new Error(message), { code, kind: 'input' });

const record = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, fallback, maximum, field) {
  const result = value == null ? fallback : typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof result !== 'string' || [...result].length > maximum || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(result)) throw visualError(`${field}须为${maximum}字以内的单行文字`);
  for (const ch of result) {
    const point = ch.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff || point === 0xfffe || point === 0xffff) throw visualError(`${field}含无效字符`);
  }
  return result.trim();
}

/** 接受模型常给出的数字字符串，但完整匹配；区间、负号后的碎片不截取为一个数。 */
export function visualNumber(value, field, minimum = -1e9, maximum = 1e9) {
  let normalized = value;
  if (typeof normalized === 'string') {
    normalized = normalized.trim().replace(/[０-９]/g, ch => String(ch.charCodeAt(0) - 0xff10)).replace(/−/g, '-').replace(/，/g, ',');
    if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(normalized)) throw visualError(`${field}必须是完整数字，不能是范围或未知值`);
    normalized = Number(normalized.replace(/,/g, ''));
  }
  if (typeof normalized !== 'number' || !Number.isFinite(normalized) || normalized < minimum || normalized > maximum) throw visualError(`${field}数字超出允许范围`);
  return normalized;
}

function choice(value, fallback, allowed, field) {
  const selected = value ?? fallback;
  if (!allowed.includes(selected)) throw visualError(`${field}只支持${allowed.join('、')}`);
  return selected;
}

const alertLevel = value => {
  const aliases = { red: 'critical', 红: 'critical', 红色: 'critical', 红色预警: 'critical', 严重: 'critical', 紧急: 'critical', orange: 'warning', yellow: 'warning', 橙: 'warning', 橙色: 'warning', 橙色预警: 'warning', 黄: 'warning', 黄色: 'warning', 黄色预警: 'warning', 注意: 'warning', 警告: 'warning', blue: 'info', 蓝: 'info', 蓝色: 'info', 蓝色预警: 'info', 提示: 'info', 信息: 'info' };
  const selected = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return choice(Object.hasOwn(aliases, selected) ? aliases[selected] : selected, 'info', ['info', 'warning', 'critical'], '动态级别');
};

const WEATHER = Object.freeze({
  metrics: [{ label: '平均气温', value: '23.6', unit: '℃', detail: '多站点示例均值' }, { label: '相对湿度', value: '68', unit: '%', detail: '舒适度示例指标' }, { label: '累计降水', value: '12.8', unit: 'mm', detail: '示例统计周期 24 h' }, { label: '平均风速', value: '3.2', unit: 'm/s', detail: '东南风 · 示例观测' }],
  series: [{ label: '00:00', value: 19 }, { label: '03:00', value: 18 }, { label: '06:00', value: 20 }, { label: '09:00', value: 24 }, { label: '12:00', value: 27 }, { label: '15:00', value: 26 }, { label: '18:00', value: 23 }, { label: '21:00', value: 21 }],
  alerts: [{ title: '强对流关注区域', detail: '南部站点示例，演示预警交互', time: '14:30', level: 'warning' }, { title: '降水趋势变化', detail: '东部区域示例，关注雨带移动', time: '14:10', level: 'info' }, { title: '观测数据摘要', detail: '这是演示内容，不用于气象决策', time: '13:50', level: 'info' }],
  markers: [{ name: '北京', lon: 116.4, lat: 39.9, value: '22℃' }, { name: '上海', lon: 121.47, lat: 31.23, value: '25℃' }, { name: '成都', lon: 104.07, lat: 30.67, value: '23℃' }, { name: '广州', lon: 113.26, lat: 23.13, value: '29℃' }, { name: '武汉', lon: 114.3, lat: 30.59, value: '26℃' }, { name: '西安', lon: 108.94, lat: 34.34, value: '24℃' }]
});
const OPERATIONS = Object.freeze({
  metrics: [{ label: '服务事项', value: '12,480', unit: '项', detail: '示例累计处理量' }, { label: '按时完成率', value: '98.6', unit: '%', detail: '示例服务质量指标' }, { label: '协同节点', value: '126', unit: '个', detail: '示例网络覆盖' }, { label: '平均响应', value: '2.4', unit: 'h', detail: '示例响应时长' }],
  series: [{ label: '周一', value: 148 }, { label: '周二', value: 196 }, { label: '周三', value: 172 }, { label: '周四', value: 248 }, { label: '周五', value: 286 }, { label: '周六', value: 232 }, { label: '周日', value: 264 }],
  alerts: [{ title: '协同任务进展', detail: '华东区域示例事项已完成', time: '14:30', level: 'info' }, { title: '重点任务关注', detail: '跨区域协作示例，等待确认', time: '14:10', level: 'warning' }, { title: '运营情况摘要', detail: '这是演示数据，不代表实际业务', time: '13:50', level: 'info' }],
  markers: WEATHER.markers.map(item => ({ ...item, value: '示例节点' }))
});

function items(value, defaults, maximum, field, normalize) {
  const selected = value ?? defaults;
  if (!Array.isArray(selected) || selected.length > maximum) throw visualError(`${field}最多${maximum}项`);
  return selected.map((item, index) => {
    if (!record(item)) throw visualError(`${field}第${index + 1}项必须是对象`);
    return normalize(item, index);
  });
}

export function normalizeVisualDesign(input = {}) {
  if (!record(input)) throw visualError('视觉设计参数必须是对象');
  if (input.kind != null && input.kind !== 'visual_scene' || input.version != null && input.version !== 1) throw visualError('不支持的视觉设计版本');
  const preset = choice(input.preset, 'weather', ['weather', 'operations'], '预设');
  const theme = choice(input.theme, preset === 'operations' ? 'light' : 'midnight', ['midnight', 'light'], '主题');
  const dataMode = choice(input.dataMode, 'demo', ['demo', 'provided'], '数据模式');
  const width = visualNumber(input.width ?? 3840, '宽度', 960, VISUAL_LIMITS.side);
  const height = visualNumber(input.height ?? 2160, '高度', 540, VISUAL_LIMITS.side);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > VISUAL_LIMITS.pixels || width / height < 1.5 || width / height > 2.1) throw visualError('大屏须为横版整数像素，宽高比1.5至2.1且不超过1600万像素');
  const source = text(input.source, dataMode === 'demo' ? '未央演示数据' : '', 120, '来源');
  if (dataMode === 'provided' && !source) throw visualError('使用提供的数据时必须填写来源，不能把演示数据称为实时数据', 'VISUAL_SOURCE_REQUIRED');
  const defaults = dataMode === 'demo' ? preset === 'weather' ? WEATHER : OPERATIONS : { metrics: [], series: [], alerts: [], markers: [] };
  return {
    version: 1, kind: 'visual_scene', preset,
    title: text(input.title, preset === 'weather' ? '区域气象观测中心' : '区域协同运营中心', 36, '标题'),
    subtitle: text(input.subtitle, preset === 'weather' ? '多维观测 · 区域态势 · 趋势分析' : '全域协同 · 运营洞察 · 服务进展', 72, '副标题'),
    width, height, theme, dataMode, source,
    asOf: text(input.asOf, dataMode === 'demo' ? '演示时刻 14:30' : '时间未提供', 64, '数据时间'),
    seriesLabel: text(input.seriesLabel, dataMode === 'demo' ? preset === 'weather' ? '气温' : '事项' : '', 24, '趋势指标'),
    seriesUnit: text(input.seriesUnit, dataMode === 'demo' ? preset === 'weather' ? '℃' : '项' : '', 8, '趋势单位'),
    metrics: items(input.metrics, defaults.metrics, VISUAL_LIMITS.metrics, '指标', item => ({ label: text(item.label, '', 16, '指标名称'), value: text(item.value, '—', 18, '指标数值'), unit: text(item.unit, '', 8, '指标单位'), detail: text(item.detail, '', 40, '指标说明') })),
    series: items(input.series, defaults.series, VISUAL_LIMITS.series, '趋势', item => ({ label: text(item.label, '', 14, '趋势标签'), value: visualNumber(item.value, '趋势数值') })),
    alerts: items(input.alerts, defaults.alerts, VISUAL_LIMITS.alerts, '动态', item => ({ title: text(item.title, '', 24, '动态标题'), detail: text(item.detail, '', 60, '动态详情'), time: text(item.time, '', 24, '动态时间'), level: alertLevel(item.level) })),
    markers: items(input.markers, defaults.markers, VISUAL_LIMITS.markers, '地图点位', item => ({ name: text(item.name, '', 16, '点位名称'), lon: visualNumber(item.lon, '经度', 70, 140), lat: visualNumber(item.lat, '纬度', 15, 55), value: text(item.value, '—', 24, '点位数值') }))
  };
}
