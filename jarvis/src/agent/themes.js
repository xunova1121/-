/**
 * 文档主题：Word / PPT / 网页 / PDF 共用一套配色和字体。
 *
 * 10 套配色来自 Anthropic 的开源技能 theme-factory（Copyright Anthropic, PBC，Apache License 2.0，
 * 许可原文见 jarvis/licenses/theme-factory-LICENSE.txt）。这里只取了配色和字体风格，
 * 按未央的用法分配了角色（标题色、强调色、浅底色），字体换成中文常用字体，另加“公文”和默认样式。
 *
 *   primary  深色：标题、PPT 深色背景
 *   accent   强调色：表头、分隔线、要点符号
 *   soft     浅色：表格隔行底色、引用块底色、PPT 浅色块
 *   bg       最浅的底色
 *   extra    第二强调色（图表、对比页的另一边）
 */

/** 字体风格 → 实际字体（latin 西文，eastAsia 中文） */
export const FONTS = {
  sans: { latin: 'Calibri', eastAsia: '微软雅黑' },
  serif: { latin: 'Cambria', eastAsia: '宋体' },
  hei: { latin: 'Arial', eastAsia: '黑体' },
  kai: { latin: 'Times New Roman', eastAsia: '楷体' },
  fangsong: { latin: 'Times New Roman', eastAsia: '仿宋' },
  xiaobiaosong: { latin: 'Times New Roman', eastAsia: '方正小标宋简体' }
};

const T = (id, name, colors, heading, keywords, use) => ({ id, name, colors: { ink: '1F2328', ...colors }, fonts: { heading, body: 'sans' }, keywords, use });

export const THEMES = {
  // 默认：沉稳的商务蓝，适合大多数报告
  business: T('business', '商务蓝', { primary: '1F3A5F', accent: '2E6DA4', soft: 'E8F0F8', bg: 'F7FAFC', extra: 'D9822B' }, 'sans',
    [], '通用报告、工作总结、方案'),
  'ocean-depths': T('ocean-depths', '深海', { primary: '1A2332', accent: '2D8B8B', soft: 'DCEFEF', bg: 'F1FAEE', extra: 'A8DADC' }, 'sans',
    ['财务', '金融', '咨询', '投资', '审计', '年报', '季报', '营收', '企业'], '企业汇报、财务报告、咨询'),
  'modern-minimalist': T('modern-minimalist', '现代极简', { primary: '36454F', accent: '708090', soft: 'EEEEEE', bg: 'FFFFFF', extra: 'A9A9A9' }, 'sans',
    ['建筑', '设计', '作品集', '极简', '数据可视化', '架构'], '技术方案、设计作品、数据展示'),
  'tech-innovation': T('tech-innovation', '科技创新', { primary: '1E1E1E', accent: '0066FF', soft: 'E5F0FF', bg: 'FFFFFF', extra: '00B8D9' }, 'sans',
    ['人工智能', 'AI', '大模型', '软件', '互联网', '数字化', '创业', '产品发布', '科技', '算法', '芯片'], '科技产品、AI、软件发布'),
  'arctic-frost': T('arctic-frost', '北极霜', { primary: '2F4F7F', accent: '4A6FA5', soft: 'D4E4F7', bg: 'FAFAFA', extra: 'A0A0A0' }, 'sans',
    ['医疗', '医院', '医药', '健康', '药品', '临床', '清洁能源', '冬季'], '医疗健康、清洁科技'),
  'forest-canopy': T('forest-canopy', '森林', { primary: '2D4A2B', accent: '7D8471', soft: 'E6E9DC', bg: 'FAF9F6', extra: 'A4AC86' }, 'serif',
    ['环保', '可持续', 'ESG', '碳中和', '生态', '户外', '有机', '绿色'], '环保、可持续发展、户外'),
  'botanical-garden': T('botanical-garden', '植物园', { primary: '4A7C59', accent: 'B7472A', soft: 'F5F3ED', bg: 'FBFAF6', extra: 'F9A620' }, 'serif',
    ['农业', '园艺', '食品', '农场', '植物', '花卉', '乡村'], '农业、食品、自然主题'),
  'golden-hour': T('golden-hour', '黄金时刻', { primary: '4A403A', accent: 'C1666B', soft: 'F3EADF', bg: 'FBF7F2', extra: 'F4A900' }, 'sans',
    ['餐厅', '餐饮', '酒店', '民宿', '咖啡', '烘焙', '手工', '秋季'], '餐饮酒店、生活方式'),
  'desert-rose': T('desert-rose', '沙漠玫瑰', { primary: '5D2E46', accent: 'B87D6D', soft: 'F3E7DD', bg: 'FBF6F2', extra: 'D4A5A5' }, 'sans',
    ['时尚', '美妆', '婚礼', '婚庆', '室内设计', '服装', '珠宝'], '时尚美妆、婚礼、室内设计'),
  'sunset-boulevard': T('sunset-boulevard', '日落大道', { primary: '264653', accent: 'E76F51', soft: 'FBEBD9', bg: 'FFFAF3', extra: 'E9C46A' }, 'serif',
    ['营销', '推广', '活动', '品牌', '策划', '市场', '广告', '创意'], '营销策划、品牌活动'),
  'midnight-galaxy': T('midnight-galaxy', '午夜星河', { primary: '2B1E3E', accent: '4A4E8F', soft: 'E9E4F2', bg: 'F7F5FB', extra: 'A490C2' }, 'sans',
    ['游戏', '娱乐', '电竞', '音乐', '演出', '夜', '奢侈品'], '娱乐游戏、创意机构'),
  // 墨玉：未央自有配色（不是 theme-factory 的）：墨色、青玉、金，适合仙侠古风、传统文化、剧情故事
  'ink-jade': T('ink-jade', '墨玉', { primary: '1B2A2F', accent: '5E8C7A', soft: 'E8E4D8', bg: 'F7F5EF', extra: 'C9A45C' }, 'serif',
    ['仙侠', '修仙', '武侠', '玄幻', '古风', '国风', '仙逆', '动漫', '动画', '番剧', '小说', '剧情', '诗词', '传统文化', '非遗', '神话'], '仙侠古风、传统文化、剧情故事'),
  // 公文：党政机关公文格式（GB/T 9704—2012）：仿宋正文、黑体 / 楷体标题、小标宋大标题、红色分隔线
  gongwen: {
    id: 'gongwen', name: '公文',
    colors: { ink: '000000', primary: '000000', accent: 'C00000', soft: 'FFFFFF', bg: 'FFFFFF', extra: 'C00000' },
    fonts: { heading: 'hei', body: 'fangsong', title: 'xiaobiaosong', h2: 'kai', h3: 'fangsong' },
    keywords: ['通知', '请示', '报告', '批复', '函', '纪要', '意见', '决定', '通报', '公文', '红头'],
    use: '党政机关、事业单位公文',
    official: true
  }
};

export const THEME_IDS = Object.keys(THEMES);

/** 按 id 或中文名找主题；找不到返回 null */
export function findTheme(name) {
  const s = String(name ?? '').trim();
  if (!s) return null;
  return THEMES[s] ?? Object.values(THEMES).find((t) => t.name === s || s.includes(t.name)) ?? null;
}

/**
 * 没指定主题时按内容选：公文格式要明确（标题像“关于……的通知”或提到公文），其余按关键词计分；都不命中用商务蓝
 * @param {string} text  标题 + 正文
 */
export function pickTheme(text) {
  const s = String(text ?? '');
  // 标题：文中第一个“# 标题”，没有就取第一行
  const title = (s.match(/^#\s+(.+)$/m)?.[1] ?? s.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? '').trim();
  const titles = [title, ...s.split('\n').slice(0, 2).map((l) => l.replace(/^#+\s*/, '').trim())];
  if (/公文格式|红头文件|按公文/.test(s) || titles.some((t) => /^关于.{2,40}的(通知|请示|报告|批复|函|意见|决定|通报)$/.test(t))) return THEMES.gongwen;
  let best = THEMES.business;
  let bestScore = 0;
  for (const t of Object.values(THEMES)) {
    if (t.official) continue;
    const score = t.keywords.reduce((n, k) => n + (s.split(k).length - 1) * (title.includes(k) ? 3 : 1), 0);
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

/** 指定了就用指定的（可以是 id 或中文名），否则按内容选 */
export const resolveTheme = (name, text) => {
  const chosen = findTheme(name);
  const auto = pickTheme(text);
  // 标题明显是公文（“关于……的通知”）却选了默认的商务蓝：按公文排（模型常顺手填默认主题）
  if (auto.official && (!chosen || chosen.id === 'business')) return auto;
  return chosen ?? auto;
};

/** 给模型看的主题列表 */
export const themeList = () => Object.values(THEMES).map((t) => `${t.id}（${t.name}：${t.use}）`).join('；');
