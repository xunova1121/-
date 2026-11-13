/** 广场只保存短偏好与文件引用，不保存文件正文；列表上限保持可预测。 */
export const STUDIO_LIMITS = { favorites: 100, recent: 12, templates: 60, works: 200, fileBytes: 20 * 1024 * 1024 };
export const STUDIO_EXTENSIONS = /\.(docx|pptx|xlsx|pdf|png|jpe?g|webp|svg|md|txt)$/i;
export const studioFileTitle = (path) =>
  String(path)
    .split('/')
    .pop()
    .replace(/-([a-f0-9]{8})-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?=\.[^.]+$)/i, '-$1');
const short = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const ids = (value, max) =>
  [...new Set((Array.isArray(value) ? value : []).filter((x) => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x)))].slice(0, max);
export function cleanBrand(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    name: short(value.name, 80),
    color: /^#[a-f0-9]{6}$/i.test(value.color || '') ? value.color : '#315EEF',
    font: short(value.font, 60),
    footer: short(value.footer, 160),
    logo: short(value.logo, 500)
  };
}
export function cleanStudio(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    favorites: ids(value.favorites, STUDIO_LIMITS.favorites),
    recent: ids(value.recent, STUDIO_LIMITS.recent),
    brand: cleanBrand(value.brand),
    templates: (Array.isArray(value.templates) ? value.templates : [])
      .filter((x) => x && typeof x.path === 'string' && STUDIO_EXTENSIONS.test(x.path))
      .slice(0, STUDIO_LIMITS.templates)
      .map((x) => ({ path: short(x.path, 500), title: short(x.title, 100), at: Number(x.at) || 0 }))
  };
}
const ALIASES = {
  'business-intelligence': '企业 公司 工商 股东 股权 对外投资 招投标 招标 中标 采购 项目 公告 企百科',
  'ppt-maker': '演示 幻灯片 汇报 述职 路演 方案',
  'gongwen-writer': '报告 材料 请示 周报 总结 公文 润色',
  'poster-designer': '海报 广告 宣传 抠图 修图 图片',
  'image-reader': '识字 扫描 票据 OCR 表格 提取',
  'deep-researcher': '调研 研究 资料 新闻 分析',
  'travel-weather': '出行 旅行 天气',
  'market-quotes': '股票 股价 金价 汇率 行情',
  'health-advisor': '健康 运动 健身 饮食'
};
export function matchesAgent(profile, query) {
  const words = short(query, 100).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [profile.name, profile.intro, ...(profile.starters || []), ALIASES[profile.id] || ''].join(' ').toLocaleLowerCase();
  return words.every((word) => {
    if (haystack.includes(word)) return true;
    const reduced = word.replace(/帮我|帮忙|我想|需要|做一份|做一个|生成|制作|请|一份|一个/g, '');
    if (reduced && haystack.includes(reduced)) return true;
    const terms = [...new Set(('ppt word ' + Object.values(ALIASES).join(' ')).toLowerCase().split(/\s+/))].filter((term) => word.includes(term));
    return terms.length > 0 && terms.every((term) => haystack.includes(term));
  });
}
export function agentReadiness(profile, report) {
  if (!report) return { label: '能力未检查', state: 'unknown' };
  const needed = [
    'chat',
    ...(['ppt-maker', 'gongwen-writer'].includes(profile.id)
      ? ['office', 'fonts']
      : profile.id === 'poster-designer'
        ? ['image']
        : profile.id === 'image-reader'
          ? ['vision']
          : [])
  ];
  const checks = needed.map((id) => report.checks?.find((row) => row.id === id));
  if (checks.some((row) => ['missing', 'unavailable', 'demo'].includes(row?.status))) return { label: '需要完善配置', state: 'missing' };
  if (checks.some((row) => !row || row.status === 'unknown')) return { label: '部分能力未检查', state: 'unknown' };
  return { label: '配置已就绪 · 效果待实测', state: 'configured' };
}
export function brandInstruction(brand) {
  const b = cleanBrand(brand);
  return [`单位/品牌：${b.name || '未指定'}`, `主色：${b.color}`, b.font && `字体：${b.font}`, b.footer && `页脚：${b.footer}`, b.logo && `标识文件：${b.logo}`]
    .filter(Boolean)
    .join('；');
}
export function revisionRequest({ path, selection = '', instruction = '', brand }) {
  if (!STUDIO_EXTENSIONS.test(path || '') || !instruction.trim()) throw new Error('请选择作品并填写修改要求');
  return `请修改工作区文件：${short(path, 500)}\n修改范围：${short(selection, 300) || '按下面要求定位，范围不明确先确认'}\n具体要求：${short(instruction, 2000)}\n先读取原文件结构，仅修改指定部分，保留其他文字、数字、图片和页面顺序。另存一个可识别的新版本，不覆盖原件；完成后读回核对并提供实际预览，不把未执行的编辑说成完成。${brand ? '\n版式要求：' + brandInstruction(brand) : ''}`;
}
