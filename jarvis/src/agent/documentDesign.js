/**
 * 让任务决定设计：按用户原话、用途和内容选 PPT 风格、Word 文种、Excel 表的用途。
 * 优先级：调用时指定的 > 用户原话里明说的（“简约一点”“做成数据报告”）> 按内容判断 > 默认。
 * 只做判断，不画东西；画法分别在 pptStyles.js、docxWriter.js、xlsxWriter.js。
 */
import { STYLE_IDS, STYLE_NAMES } from './pptStyles.js';

/** PPT 风格：用户原话里的说法 */
const STYLE_ASK = [
  ['minimal', /简约|简洁|极简|留白|干净一点|苹果风/],
  ['story', /故事感|叙事|氛围感|古风|国风|电影感|有氛围/],
  ['data', /数据报告|数据风|图表为主|多用图表|仪表盘/],
  ['business', /商务风|正式一点|稳重|政务|汇报风/]
];
/** PPT 风格：内容是什么 */
const STYLE_TOPIC = [
  ['story', /剧情|动漫|动画|小说|电视剧|电影|番剧|仙侠|修仙|武侠|玄幻|人物传|传记|历史故事|游记|旅行|旅游|攻略|读书笔记|诗词|传统文化|非遗|神话|典故|角色/],
  ['data', /经营分析|财务|营收|利润|销售额|同比|环比|报表|指标|数据分析|统计|KPI|预算执行|业绩/i],
  ['minimal', /产品发布|发布会|作品集|设计稿|品牌|新品|设计方案|摄影|艺术/],
  ['business', /汇报|方案|立项|决策|述职|总结|计划|建设|项目|工作/]
];

export const DOC_KINDS = { notice: '通知 / 函', minutes: '会议纪要', policy: '制度 / 办法', proposal: '方案 / 建议书', report: '报告 / 总结', poster: '单页告示（招租、招聘、启事、海报，一页大字铺满）', general: '一般文档' };
const DOC_KIND_RULES = [
  ['minutes', /会议纪要|会议记录|纪要/],
  ['notice', /通知|通告|公告|请示|批复|函$|邀请函|告知书/],
  ['policy', /制度|管理办法|实施细则|细则|规定|守则|章程|管理规范|规程/],
  ['proposal', /方案|建议书|计划书|策划|可行性|申报书/],
  ['report', /报告|总结|调研|分析|述职|简报|评估/]
];

export const SHEET_KINDS = { settlement: '结算 / 对账表', ledger: '台账 / 清单', budget: '预算 / 测算表', analysis: '分析报表', general: '一般表格' };
const POSTER = /招租|出租|求租|转让|招聘|招工|启事|寻物|寻人|失物招领|海报|宣传单|传单|告示|广告/;

const SHEET_KIND_RULES = [
  ['settlement', /结算|对账|结账|称重|收购|收款|付款|账单|货款|工资表|提成/],
  ['budget', /预算|测算|投资估算|成本测算|报价|概算/],
  ['ledger', /台账|登记|清单|跟踪表|名录|档案|花名册|库存|进销存/],
  ['analysis', /分析|同比|环比|趋势|统计|经营数据|销售数据|报表/]
];

const firstHit = (rules, text) => rules.find(([, re]) => re.test(text))?.[0] ?? '';
const tableCount = (md) => (String(md).match(/^\s*\|?\s*:?-{2,}/gm) ?? []).length;

/**
 * @param {{ format: string, title?: string, content?: string, requirements?: string, style?: string, kind?: string }} o
 * @returns {{ style?: string, kind?: string, label: string, reason: string }}
 */
export function chooseDesign({ format, title = '', content = '', requirements = '', style = '', kind = '' }) {
  const ask = String(requirements ?? '');
  const head = `${title}\n${String(content).slice(0, 3000)}`;
  if (format === 'pptx') {
    if (STYLE_IDS.includes(style)) return { style, label: STYLE_NAMES[style], reason: '按指定的风格' };
    const asked = firstHit(STYLE_ASK, ask);
    if (asked) return { style: asked, label: STYLE_NAMES[asked], reason: '按你说的要求' };
    // 表格多、数字密：数据报告
    if (tableCount(content) >= 2) return { style: 'data', label: STYLE_NAMES.data, reason: '内容里表格和数字多' };
    const topic = firstHit(STYLE_TOPIC, `${ask}\n${head}`) || 'business';
    return { style: topic, label: STYLE_NAMES[topic], reason: topic === 'story' ? '内容是故事、剧情、人物类' : topic === 'data' ? '内容是经营、财务、统计类' : topic === 'minimal' ? '内容是产品、设计、品牌类' : '内容是工作汇报、方案类' };
  }
  if (['docx', 'pdf', 'html'].includes(format)) {
    if (DOC_KINDS[kind]) return { kind, label: DOC_KINDS[kind], reason: '按指定的文种' };
    // 先看标题，再看要求，最后看正文开头
    // 单页告示：标题或要求像告示、内容短（一页放得下），且不是“招聘方案 / 招租工作总结”这类文书
    if (POSTER.test(`${title}\n${ask}`) && !firstHit(DOC_KIND_RULES.filter(([id]) => id !== 'notice'), title) && String(content).replace(/\s/g, '').length <= 400)
      return { kind: 'poster', label: DOC_KINDS.poster, reason: '是一页贴出去的告示' };
    const k = firstHit(DOC_KIND_RULES, title) || firstHit(DOC_KIND_RULES, ask) || firstHit(DOC_KIND_RULES, String(content).slice(0, 300)) || 'general';
    return { kind: k, label: DOC_KINDS[k], reason: k === 'general' ? '没看出是哪种公文 / 文书' : '按标题和要求判断' };
  }
  if (format === 'xlsx') {
    if (SHEET_KINDS[kind]) return { kind, label: SHEET_KINDS[kind], reason: '按指定的用途' };
    const k = firstHit(SHEET_KIND_RULES, `${title}\n${ask}`) || firstHit(SHEET_KIND_RULES, String(content).slice(0, 600)) || 'general';
    return { kind: k, label: SHEET_KINDS[k], reason: k === 'general' ? '没看出是哪种用途' : '按标题和要求判断' };
  }
  return { label: '', reason: '' };
}
