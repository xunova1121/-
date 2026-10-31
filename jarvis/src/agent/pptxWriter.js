import { presentationMarkdown } from './presentationMarkdown.js';
import { PPT_ICON_CATALOG } from './pptIconCatalog.js';
import { planTablePages, combineExplanationPages, tidyPresentationPunctuation } from './presentationLayoutPlan.js';
import { summarizeTable, decorationData } from './presentationLocalVisuals.js';
import { reserveImageColumn, placeSlideImages } from './presentationImages.js';
import { throwControl } from '../core/networkRequest.js';
import { applyPresentationTypography } from './officeTypography.js';
import { slideBudget } from './documentPageBudget.js';
/**
 * Markdown → PPT（.pptx），用 PptxGenJS（MIT）。16:9，配色用主题（themes.js）。
 *
 * 写法：“# 标题”或“## 标题”开始一页，也可以用 --- 分页；页内的列表、段落、表格、图片决定版式。
 * 版式按内容自动选：
 *   cover     封面：文档标题、副标题、日期（深色底）
 *   section   章节页：只有标题（或标题 + 一句话），或标题像“第二部分 …”
 *   stats     大数字：2–6 条要点，每条以数字开头（如“1,236 万元 销售额”“0/12：雷达安装数”）
 *   cards     卡片：3–8 条“标签：说明”（列表或段落都行），多出的一两句不带标签的话放进底部深色横条
 *   steps     步骤：卡片的标题像“流程 / 步骤 / 阶段”时排成一排箭头
 *   timeline  时间线：3–7 条以日期开头（“10-19 支架到货”“11月1日：初验”）
 *   progress  进度条：3–8 条“名称：百分比”，或表格里只有百分比数字列（完成率、占比）
 *   statement 重点句：一两句话；或一句话 + 一两条“标签：说明”（放进深色横条）
 *   bullets   要点：列表 / 段落；超过 7 条自动拆成两页（续）
 *   imageText 左文右图：有图片也有文字
 *   image     大图：只有图片
 *   compare   对比：页内有两个 ### 小标题，左右两栏
 *   chart     数据：表格里有数字列 → 柱状图（数据少于等于 8 行）
 *   table     表格：其他表格
 *   end       结尾：标题是“谢谢 / 感谢 / Q&A / 结束”
 * 以“备注：”开头的段落放进演讲者备注，不上屏。
 * 页内写一行“版式：卡片”（大数字 / 卡片 / 步骤 / 时间线 / 流程 / 对比 / 图表 / 进度 / 表格 / 重点句 / 章节 / 要点）可以指定版式，
 * 内容排不成指定的版式时仍按内容自动选。
 */
import { parseDoc, plain } from './docModel.js';
import { imageInfo } from './imageInfo.js';
import { recordSlide, layoutIssues, fitText } from './slidePreview.js';
import { styleTokens, chapterMark, mix as mix2 } from './pptStyles.js';

const W = 13.333;
const H = 7.5;
const FONT = '微软雅黑';
const NUM_ITEM = /^(?:\*\*)?([-+]?\d[\d,.]*(?:\s*[/／]\s*\d[\d,.]*)?\s*(?:%|万亿元|亿元|万元|千元|万亿|亿|万|千|元|个|家|人次|人|倍|天|小时|分钟|项|台|套|支|次|集|章|回|段|件|部|篇|位|名|条|座|种|场)?)(?:\*\*)?(?:\s*[：:]\s*|\s+|(?<=[场支个家人倍项台套次件部篇位名条座种元万亿千])(?=[\u4e00-\u9fff]))(.+)$/;
/** 以日期开头的一条：“10-19 支架到货”“11月1日：初验”“2026年3月 上线”“第 3 周：联调” */
const DATE_ITEM = /^(?:\*\*)?(\d{1,2}\s*[-月]\s*\d{1,2}\s*日?|\d{4}\s*[-./年]\s*\d{1,2}(?:\s*[-./月]\s*\d{1,2}\s*日?)?\s*月?|\d{1,2}\s*月(?:上旬|中旬|下旬|底|初)?|第\s*\d+\s*(?:周|月|季度))(?:\*\*)?(?:\s*[：:]\s*|\s+)(.{2,})$/;
/** “名称：85%”“集成测试 83.3%（回归）”：进度条 */
const PCT_ITEM = /^(?:\*\*)?([^：:\n\d]{1,16}?)(?:\*\*)?\s*[：:]?\s*(\d+(?:\.\d+)?)\s*%\s*(.{0,30})$/;
/** 页内的版式指令：“版式：卡片” */
const DIRECTIVE = /^(?:<!--\s*)?版式\s*[:：]\s*([^\s<>-]{1,6})\s*(?:-->)?$/;
const LAYOUT_NAMES = { 大数字: 'stats', 数字: 'stats', 数据: 'stats', 卡片: 'cards', 步骤: 'steps', 时间线: 'timeline', 时间轴: 'timeline', 里程碑: 'timeline', 流程: 'flow', 流程图: 'flow', 对比: 'compare', 图表: 'chart', 柱状图: 'chart', 进度: 'progress', 进度条: 'progress', 表格: 'table', 重点句: 'statement', 重点: 'statement', 金句: 'statement', 章节: 'section', 要点: 'bullets', 列表: 'bullets', 关系图: 'relation', 关系: 'relation', 结构图: 'relation', 叙事: 'bullets', 饼图: 'chart', 折线图: 'chart', 趋势: 'chart' };
const END = /^(谢谢|感谢|谢谢观看|感谢聆听|汇报完毕|请批评指正|请指示|thanks|thank you|q\s*&\s*a|结束)/i;
const SECTION = /^(第[一二三四五六七八九十\d]+(部分|章|篇)|part\s*\d+)/i;
/** “标签：说明”式的要点（如“预警研判智能体：多源证据汇聚……”） */
const LABEL = /^(?:\*\*)?([^：:\n]{1,14}?)(?:\*\*)?\s*[：:]\s*(.{2,})$/;
/** 总结类的标签：放进重点横条，不当卡片 */
const SUMMARY = /^(总体判断|总体|结论|判断|小结|总结|定位|方案定位|核心观点|一句话|总的来看)$/;
/** 一句话里的流程链：A→B→C */
const ARROW = /\s*(?:→|->|⟶|➜|=>)\s*/;
const isChain = (t) => String(t).split(ARROW).filter((x) => x.trim()).length >= 3;
/** 标题像流程 / 步骤：带标签的要点画成一排步骤 */
const STEP_TITLE = /流程|场景|步骤|链路|闭环|路径|环节|过程|阶段|计划|安排/;
/** 标题像关系 / 结构：带标签的要点围着中心画成关系图 */
/** 按时间排的行名：1月、2026年、Q3、第3季度、10-19 */
const PERIOD = /^.{0,6}(\d{1,2}\s*月|\d{4}\s*年|Q[1-4]|季度|\d{4}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}|第\s*\d+\s*周|上半年|下半年).{0,4}$/i;
const RELATION_TITLE = /关系|人物|阵营|势力|构成|组成|体系|架构|生态|分工|角色/;
/** 合计行：不进柱状图 */
const TOTAL_ROW = /^(合计|总计|小计|总额|共计|total)/i;
/** 单位：同一张图里单位不同的数据列不能放在一起比 */
const UNIT = /(万元|亿元|千元|元|人天|人月|人|天|小时|%|个|台|套|次|项|家|km|公里|吨)/;

/** 按文字意思配图标（图标见 pptIcons.js）；同一页尽量不重复 */
const ICON_RULES = [
  [/足球|球场|比赛|赛程|赛事/, 'volleyball'], [/餐饮|餐厅|食堂|美食/, 'utensils'], [/医疗|诊疗|医院/, 'stethoscope'], [/交通|汽车|车流/, 'car'],
  [/风险|问题|隐患|短板|卡点|挑战|不足|瓶颈/, 'triangle-alert'], [/回款|现金|支付|金融|贷款|账期/, 'banknote'],
  [/营收|收入|资金|预算|投资|成本|费用|经费|利润/, 'wallet'], [/目标|定位|方向|聚焦|愿景/, 'target'],
  [/政策|指示|精神|引领|党建|方针|领导/, 'flag'], [/规划|计划|方案|部署|清单|任务|安排/, 'clipboard-list'],
  [/政府|省级|国家|机关|监管|治理|政务/, 'landmark'], [/占比|份额|构成|结构/, 'chart-pie'],
  [/数据|指标|统计|分析|报表|业绩/, 'chart-column'], [/增长|增速|提升|上升|增量|发展|突破/, 'trending-up'],
  [/客户|用户|人员|团队|人才|社员|会员|群众|农民|员工/, 'users'], [/组织|机构|企业|公司|办事处|基层|网点|编制|社/, 'building-2'],
  [/考核|评估|验收|检查|督导|核查|审核/, 'clipboard-check'], [/安全|保障|保护|合规|风控/, 'shield-check'],
  [/智能|AI|人工智能|算法|模型|芯片/i, 'cpu'], [/数字|信息化|系统|平台|数据库|云/, 'database'],
  [/冷链|冷库|保鲜|冷藏/, 'snowflake'], [/物流|配送|运输|流通|快递|仓/, 'truck'],
  [/农业|农产品|种植|农资|乡村|田|粮/, 'sprout'], [/绿色|环保|生态|低碳|减排|节能/, 'leaf'],
  [/市场|销售|营销|门店|零售|商超|集市/, 'store'], [/品牌|荣誉|奖|标杆|示范/, 'award'],
  [/宣传|推广|传播|媒体|舆论/, 'megaphone'], [/培训|教育|学习|培养|学院|课程/, 'graduation-cap'],
  [/合作|协同|联动|共建|对接|伙伴|融合/, 'handshake'], [/时间|进度|周期|期限|节点|天|月/, 'clock'],
  [/创新|改革|新模式|试点/, 'lightbulb'], [/服务|帮扶|民生|关怀|助/, 'heart-handshake'],
  [/网络|体系|联网|网/, 'network'], [/文件|制度|规范|标准|章程/, 'file-text'],
  [/会议|活动|日程/, 'calendar'], [/区域|地区|华东|华南|华北|华中|西南|城市|县|省/, 'map-pin'],
  [/工程|建设|设施|改造|维修/, 'wrench'], [/资源|整合|层级|叠加/, 'layers'],
  [/质量|品质|达标|认证/, 'badge-check'], [/效率|提速|提效|快速|高效/, 'zap'],
  [/回收|循环|再生/, 'recycle'], [/消费|购物|采购|电商|订单/, 'shopping-cart'],
  [/启动|上线|发布|起步|开局/, 'rocket'], [/国际|全球|海外|开放/, 'globe'],
  [/法律|法规|公平|平衡|权益/, 'scale'], [/机制|管理|运营|流程|制度化/, 'settings'],
  [/知识|研究|调研|阅读|理论/, 'book-open'], [/查找|识别|排查|监测|发现/, 'search']
];
const ICON_FALLBACK = ['sparkles', 'layers', 'target', 'lightbulb', 'badge-check', 'rocket'];
export function iconPicker(preferred = []) {
  const used = new Set();
  return (text) => {
    const t = String(text ?? '');
    const hit = preferred.find(name => Object.hasOwn(PPT_ICON_CATALOG, name) && !used.has(name)) ?? ICON_RULES.find(([re, name]) => re.test(t) && !used.has(name))?.[1]
      ?? ICON_FALLBACK.find((name) => !used.has(name)) ?? Object.keys(PPT_ICON_CATALOG).find(name => !used.has(name)) ?? 'sparkles';
    used.add(hit);
    return hit;
  };
}

/** 一段话或一条里夹着“版式：卡片”这一行（后面紧跟正文、没空行）：把这一行摘出来，其余照旧 */
function takeDirective(inlines) {
  const lines = [[]];
  for (const s of inlines) {
    String(s.text).split('\n').forEach((t, k) => { if (k) lines.push([]); if (t) lines.at(-1).push({ ...s, text: t }); });
  }
  let layout = '';
  let word = '';
  const rest = lines.filter((ln) => {
    const w = DIRECTIVE.exec(plain(ln).trim())?.[1];
    const hit = LAYOUT_NAMES[w];
    if (hit && !layout) { layout = hit; word = w; }
    return !hit;
  });
  if (!layout) return null;
  return { layout, word, inlines: rest.flatMap((ln, k) => (k ? [{ text: '\n' }, ...ln] : ln)) };
}

/** 按页拆开，每页保留原始块，供选版式 */
export function parseSlides(title, md) {
  const blocks = parseDoc(md).flatMap(block => {
    if (block.type === 'paragraph' && !block.inlines.some(run => run.image || run.link || run.code)) {
      const parts = plain(block.inlines).split(/\u3000+| {2,}/).map(text => text.trim()).filter(Boolean);
      if (parts.length >= 2 && parts.length <= 6 && parts.every(text => NUM_ITEM.test(text) && !DATE_ITEM.test(text))) {
        return [{ type: 'list', ordered: false, items: parts.map(text => ({ inlines: [{ text }], children: [] })) }];
      }
    }
    if (block.type !== 'paragraph' || !block.inlines.some(run => run.image)) return [block];
    const parts=[]; let text=[];
    const flush=()=>{if(text.some(run=>run.text.trim())) parts.push({type:'paragraph',inlines:text});text=[];};
    for(const run of block.inlines){if(run.image){flush();parts.push({type:'image',src:run.image,alt:run.text});}else text.push(run);}
    flush(); return parts;
  });
  const clean = block => {
    if (block.inlines) block.inlines = block.inlines.map(run => ({ ...run, text: tidyPresentationPunctuation(run.text) }));
    for (const child of block.blocks || []) clean(child);
    for (const item of block.items || []) { clean(item); for (const child of item.children || []) clean(child); }
    for (const row of block.type === 'table' ? [block.header, ...block.rows] : []) for (let i = 0; i < row.length; i++) row[i] = row[i].map(run => ({ ...run, text: tidyPresentationPunctuation(run.text) }));
  };
  blocks.forEach(clean);
  const explicitPages = blocks.some(block => block.type === 'hr');
  const slides = [];
  let cur = null;
  const start = (t) => { cur = { title: t, blocks: [], notes: [] }; slides.push(cur); };
  for (let b of blocks) {
    if (b.type === 'heading' && b.level <= 2) {
      // 显式分页时，页内副标题不是第二张幻灯片；保留文字而非删除来凑页数。
      if (!explicitPages || !cur) { start(plain(b.inlines)); continue; }
      b = { ...b, level: 3 };
    }
    if (b.type === 'hr') { cur = null; continue; }
    if (!cur) start(slides.length ? '' : title);
    if (b.type === 'paragraph' && /^图标[:：]/.test(plain(b.inlines))) {
      cur.iconNames = plain(b.inlines).replace(/^图标[:：]\s*/, '').split(/[,，、\s]+/).filter(name => Object.hasOwn(PPT_ICON_CATALOG, name)).slice(0, 8);
      continue;
    }
    if (b.type === 'paragraph' && /^备注[:：]/.test(plain(b.inlines))) { cur.notes.push(plain(b.inlines).replace(/^备注[:：]\s*/, '')); continue; }
    // “版式：卡片”：记下来，不上屏（写成列表的一条、或和正文挤在一段里也认）
    if (b.type === 'paragraph') {
      const d = takeDirective(b.inlines);
      if (d) { if (!cur.layout) { cur.layout = d.layout; cur.wish = d.word; } if (!plain(d.inlines).trim()) continue; b = { ...b, inlines: d.inlines }; }
    }
    if (b.type === 'list') {
      let found = false;
      const items = b.items.map((it) => {
        const d = takeDirective(it.inlines);
        if (!d) return it;
        found = true;
        if (!cur.layout) { cur.layout = d.layout; cur.wish = d.word; }
        return plain(d.inlines).trim() ? { ...it, inlines: d.inlines } : null;
      });
      if (found) {
        b = { ...b, items: items.filter(Boolean) };
        if (!b.items.length) continue;
      }
    }
    // 只有标签的一行（“分批方案：”）后面跟一段话：并成一条“标签：说明”
    const prev = cur.blocks.at(-1);
    if (b.type === 'paragraph' && prev?.type === 'paragraph' && /^[^：:\n]{1,14}[：:]$/.test(plain(prev.inlines).trim())) {
      cur.blocks[cur.blocks.length - 1] = { ...prev, inlines: [{ text: plain(prev.inlines).trim() }, ...b.inlines] };
      continue;
    }
    cur.blocks.push(b);
  }
  return slides;
}

/** 页内的每一条（列表的每一项、每段话都算一条） */
const entriesOf = (bs) => bs.flatMap((b) => (b.type === 'list' ? b.items : b.type === 'paragraph' ? [{ inlines: b.inlines, children: [] }] : [])).flatMap(splitLines);
/** 一条里换了行（列表最后一项后面紧跟一段话、两句话写在相邻两行）：按行拆成几条 */
function splitLines(it) {
  const t = plain(it.inlines);
  if (!t.includes('\n')) return [it];
  return t.split('\n').map((x) => x.trim()).filter(Boolean).map((x, k) => ({ inlines: [{ text: x }], children: k ? [] : it.children }));
}
const numMatch = (t) => NUM_ITEM.exec(t) ?? DATE_ITEM.exec(t);
/** 表格里能画成进度条的列：数字列都是百分比（完成率、占比），值在 0–100 */
function progressColumn(table) {
  const cols = numericColumns(table);
  const pct = (c) => /率|占比|比例|进度|%/.test(plain(table.header[c])) || table.rows.every((r) => /%\s*$/.test(plain(r[c] ?? [])));
  if (!cols.length || !cols.every(pct) || table.rows.length < 2 || table.rows.length > 8) return null;
  return table.rows.every((r) => { const v = num(plain(r[cols[0]] ?? [])); return v >= 0 && v <= 100; }) ? cols[0] : null;
}
/** 柱状图画出来看得清吗：同一张图里最大值是最小值的几十倍时，小的柱子几乎看不见，不如用表格 */
function chartReadable(table, cols) {
  const rows = table.rows.filter((r) => !TOTAL_ROW.test(plain(r[0] ?? [])));
  const vals = cols.flatMap((c) => rows.map((r) => num(plain(r[c] ?? [])))).filter((v) => v !== null);
  const pos = vals.filter((v) => v > 0);
  // 同一列每行的单位不一样（“23 万人”“156 人”）也不能画在一起
  const units = cols.map((c) => new Set(rows.map((r) => plain(r[c] ?? []).replace(/[\d,.\s+-]/g, '')).filter(Boolean)).size);
  return pos.length === vals.length && (pos.length < 2 || Math.max(...pos) / Math.min(...pos) <= 40) && units.every((n) => n <= 1);
}

/** 兼容旧接口：{ title, lines } */
export function splitSlides(title, md) {
  return parseSlides(title, md).map((s) => ({ title: s.title, lines: s.blocks.flatMap(blockLines) }));
}
function blockLines(b) {
  if (b.type === 'paragraph') return [plain(b.inlines)];
  if (b.type === 'list') return b.items.flatMap((it) => [plain(it.inlines), ...it.children.flatMap(blockLines)]);
  if (b.type === 'heading') return [plain(b.inlines)];
  if (b.type === 'quote') return b.blocks.flatMap(blockLines);
  if (b.type === 'code') return b.text.split('\n');
  return [];
}

/** 选版式：页内写了“版式：……”且内容排得成就按它，否则按内容自动选 */
export function layoutOf(slide, o = {}) {
  const auto = autoLayout(slide, o);
  const want = slide.layout;
  return want && want !== auto && fitsLayout(slide, want) ? want : auto;
}

function fitsLayout(slide, want) {
  const bs = slide.blocks;
  const items = entriesOf(bs);
  const texts = items.map((it) => plain(it.inlines));
  const table = bs.find((b) => b.type === 'table');
  const labeled = texts.filter((t) => LABEL.test(t)).length;
  switch (want) {
    case 'stats': { const k = texts.filter((t) => numMatch(t)).length; return k >= 2 && k <= 6; }
    case 'cards': return labeled >= 2 && labeled <= 8;
    case 'steps': return labeled >= 3 && labeled <= 7;
    case 'timeline': { const k = texts.filter((t) => DATE_ITEM.test(t)).length; return k >= 3 && k <= 7; }
    case 'flow': return texts.some(isChain);
    case 'compare': return bs.filter((b) => b.type === 'heading' && b.level >= 3).length === 2;
    case 'chart': return Boolean(table && chartColumns(table).length);
    case 'progress': return table ? progressColumn(table) !== null : texts.filter((t) => PCT_ITEM.test(t)).length >= 2;
    case 'table': return Boolean(table);
    case 'statement': return items.length >= 1 && items.length <= 3 && texts.join('').length <= 200 && !table;
    case 'section': return bs.flatMap(blockLines).filter(Boolean).length <= 2;
    case 'bullets': return items.length >= 1;
    case 'relation': return labeled >= 3 && labeled <= 6;
    default: return false;
  }
}

const LAYOUT_LABEL = Object.fromEntries(Object.entries(LAYOUT_NAMES).reverse().map(([k, v]) => [v, k]));
/** 指定的版式排不成时，告诉模型差在哪（以前悄悄换回自动选的，模型以为照办了） */
const LAYOUT_NEEDS = {
  stats: '2–6 条以数字开头的要点（如“67 万元：总投资”）',
  cards: '2–8 条“标签：说明”',
  steps: '3–7 条“标签：说明”',
  timeline: '3–7 条以日期开头的要点（如“11月1日：初验”）',
  flow: '一句“A→B→C”的链路',
  compare: '两个 ### 小标题',
  chart: '带数字列的表格',
  progress: '“名称：百分比”或只有百分比列的表格',
  table: '一张表格',
  statement: '一到三句、共 200 字以内的话',
  section: '只有标题或标题加一句话',
  relation: '3–6 条“名称：说明”（可以再加一句不带标签的话当中心）'
};
export function ignoredLayout(slide, kind) {
  const want = slide.layout;
  if (!want || want === kind || !LAYOUT_NEEDS[want]) return '';
  return `「${slide.title || '无标题'}」写了“版式：${LAYOUT_LABEL[want]}”，但${LAYOUT_LABEL[want]}要 ${LAYOUT_NEEDS[want]}，这页内容对不上，已按${LAYOUT_LABEL[kind] ?? '要点'}排；要用${LAYOUT_LABEL[want]}就把内容改成这种写法`;
}

function autoLayout(slide, { first = false, last = false } = {}) {
  const bs = slide.blocks;
  const has = (t) => bs.some((b) => b.type === t);
  const lines = bs.flatMap(blockLines).flatMap((l) => l.split('\n')).map((l) => l.trim()).filter(Boolean);
  if (first && !bs.length) return 'cover';
  if (END.test(slide.title.trim()) && (last || lines.length <= 2)) return 'end';
  if (!bs.length || (SECTION.test(slide.title) && lines.length <= 1)) return 'section';
  const table = bs.find((b) => b.type === 'table');
  if (table) {
    const pc = progressColumn(table);
    // 占比加起来约 100%（构成）：画环形图；完成率之类各自独立的百分比：进度条
    if (pc !== null && /占比|比重|构成|份额/.test(plain(table.header[pc])) && Math.abs(table.rows.reduce((a, r) => a + (num(plain(r[pc] ?? [])) ?? 0), 0) - 100) <= 3) return 'chart';
    if (pc !== null) return 'progress';
    const cols = chartColumns(table);
    return cols.length && table.rows.filter((r) => !TOTAL_ROW.test(plain(r[0] ?? []))).length <= 8 && chartReadable(table, cols) ? 'chart' : 'table';
  }
  const imgs = bs.filter((b) => b.type === 'image');
  if (imgs.length && !lines.length) return 'image';
  if (bs.filter((b) => b.type === 'heading' && b.level >= 3).length === 2) return 'compare';
  // 列表的每一项、每段话都算一条（模型常把要点写成一段一段的话，不带“- ”）
  const entries = entriesOf(bs);
  const items = entries.map((it) => plain(it.inlines));
  const flat = entries.length === lines.length; // 没有下一级要点
  // 多出来的一两句不带标签的话（总结、说明）放进底部深色横条，不影响选版式
  const fewOthers = (k, max = 1) => items.length - k <= max && items.filter((t) => !LABEL.test(t) && !numMatch(t)).every((t) => t.length <= 80);
  const dated = items.filter((t) => DATE_ITEM.test(t)).length;
  if (flat && dated >= 3 && dated <= 7 && fewOthers(dated) && dated >= items.length - 1) return 'timeline';
  const nums = items.filter((t) => numMatch(t)).length;
  const statsFlat = entries.length === bs.filter(b => b.type !== 'heading').flatMap(blockLines).flatMap(line => line.split('\n')).map(line => line.trim()).filter(Boolean).length;
  if (statsFlat && nums >= 2 && nums <= 6 && fewOthers(nums) && bs.filter(b => b.type === 'heading').length <= 1) return 'stats';
  const pcts = items.filter((t) => PCT_ITEM.test(t)).length;
  if (flat && pcts >= 3 && pcts <= 8 && fewOthers(pcts)) return 'progress';
  if (lines.some(isChain)) return 'flow';
  // 3–8 条“标签：说明”
  const labeled = items.filter((t) => LABEL.test(t)).length;
  if (flat && labeled >= 3 && labeled <= 6 && fewOthers(labeled, 1) && RELATION_TITLE.test(slide.title)) return 'relation';
  if (flat && labeled >= 3 && labeled <= 8 && fewOthers(labeled, 2)) {
    return STEP_TITLE.test(slide.title) && labeled >= 4 && labeled <= 7 ? 'steps' : 'cards';
  }
  if (imgs.length) return 'imageText';
  // 一两句话；或一句话 + 一两条“标签：说明”：大字重点页
  const total = items.join('').length;
  if (flat && items.length && ((items.length <= 2 && total <= 90) || (items.length <= 3 && !LABEL.test(items[0]) && items.slice(1).every((t) => LABEL.test(t)) && total <= 170))) return 'statement';
  return 'bullets';
}

const num = (s) => {
  const t = String(s).replace(/[,，\s]/g, '').replace(/[%万亿元个家人次倍天项台套]+$/, '');
  return /^[-+]?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};
function numericColumns(table) {
  return table.header.map((_, i) => i).filter((i) => i > 0 && table.rows.length && table.rows.every((r) => num(plain(r[i] ?? [])) !== null));
}
/** 能画进同一张柱状图的数字列：单位不同（如“人天”和“万元”）时只取第一种单位的列 */
function chartColumns(table) {
  const cols = numericColumns(table);
  const unitOf = (c) => (plain(table.header[c]).match(UNIT) ?? plain(table.rows[0]?.[c] ?? []).match(UNIT) ?? [''])[0];
  const money = cols.find((c) => /元/.test(unitOf(c)));
  const first = money ?? cols[0];
  return first === undefined ? [] : cols.filter((c) => unitOf(c) === unitOf(first));
}

/**
 * @param {{ title: string, content: string, theme: object, subtitle?: string, author?: string, date?: string, loadImage?: (src: string) => Promise<Uint8Array|null> }} o
 * @returns {Promise<{ blob: Blob, info: { slides: number, layouts: string[], missingImages: string[], preview: object[], layoutIssues: object[] } }>}
 */
export async function makePptx({ title, content, theme, subtitle = '', author = '', date = '', loadImage = null, style = 'business', expectedSlides = null, maxSlides = null, requireCover = false, forbidCover = false, typography = {}, renderSvg = null, signal }) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  pptx.author = '未央';
  const C = theme.colors;
  // 设计规范（pptStyles.js）：底色、标题栏、卡片、图标、封面按风格画；颜色仍来自主题
  const T = styleTokens(style, theme);
  const dark = T.strong; // 深色块：重点横条、箭头、表头
  const head = T.head; // 标题、标签文字
  const light = T.bg;
  const muted = T.muted;
  const FONT = T.font;
  const HFONT = T.headFont;
  const missingImages = [];
  const layouts = [];
  // 每页放了什么都记下来：生成后估算字放不放得下、画预览图给模型看（slidePreview.js）
  const records = [];
  const addSlide = (title) => { const r = recordSlide(pptx.addSlide()); applyPresentationTypography(r.slide, typography, title); records.push({ n: records.length + 1, title, items: r.items, slide: r.slide }); return r.slide; };

  let slides = parseSlides(title, content);
  let coverImages = [];
  if (!forbidCover && slides[0]?.title === title && slides[0].blocks.length && slides[0].blocks.every(block => block.type === 'image')) {
    coverImages = slides[0].blocks;
    slides = slides.slice(1);
  }
  // 第一页如果就是文档标题（# 标题后面没有内容），当作封面
  if (slides[0] && !slides[0].blocks.length) { title = slides[0].title || title; slides = slides.slice(1); }
  // 模型常把封面信息（汇报类型、单位、日期）写成第二页的要点：挪回封面
  const s0 = slides[0];
  if (s0 && s0.blocks.length === 1 && s0.blocks[0].type === 'list' && s0.blocks[0].items.length <= 5) {
    const its = s0.blocks[0].items;
    const DATE = /^\d{4}\s*年(\s*\d{1,2}\s*月)?(\s*\d{1,2}\s*日)?$|^\d{4}[-./]\d{1,2}([-./]\d{1,2})?$/;
    const ORG = /(中心|局|厅|委员会|委|办公室|公司|集团|研究院|研究所|大学|学院|医院|部)$/;
    const KIND = /^(项目)?(建议|汇报|报告|方案|总结|述职|宣讲|培训|介绍)(汇报|材料|稿)?$|^.{0,8}(汇报|报告)$/;
    const isMeta = (t) => t.length <= 30 && (DATE.test(t) || ORG.test(t) || KIND.test(t));
    const meta = its.filter((it) => isMeta(plain(it.inlines).trim()));
    if (meta.length >= 2) {
      const txt = meta.map((it) => plain(it.inlines).trim());
      date = date || txt.find((t) => DATE.test(t)) || '';
      author = author || txt.find((t) => ORG.test(t)) || '';
      const kind = txt.filter((t) => !DATE.test(t) && !ORG.test(t));
      subtitle = subtitle || [s0.title, ...kind].filter(Boolean).join('｜');
      const rest = its.filter((it) => !meta.includes(it));
      slides = rest.length ? [{ ...s0, blocks: [{ ...s0.blocks[0], items: rest }] }, ...slides.slice(1)] : slides.slice(1);
    }
  }
  // 第一页只是把封面上的名称、日期又写了一遍（“副封面”）：去掉，没写副标题的挪到封面上
  const c0 = slides[0];
  if (c0 && slides.length > 1 && !SECTION.test(c0.title) && !c0.layout && c0.blocks.every((b) => b.type === 'paragraph')) {
    const ls = c0.blocks.flatMap(blockLines).filter(Boolean);
    const squash = (t) => String(t).replace(/[\s·|｜,，、:：（）()—-]/g, '');
    const known = squash(`${title}${subtitle}${author}${date}`);
    const dup = (t) => squash(t).length >= 4 && known.includes(squash(t));
    // 只有整行是日期或已知封面原文，才允许合并；正文提到月份不代表它是副封面。
    const metadataOnly = ls.every(text => dup(text) || /^[（(]?\s*\d{4}[\d\s年月日—至\-./]+[）)]?\s*$/.test(text));
    if (metadataOnly && ls.length <= 1 && (dup(c0.title) || (ls.length && dup(ls[0])) || (!subtitle && `${c0.title}${ls[0] ?? ''}`.length <= 60 && /\d{4}\s*年|\d{1,2}\s*月|汇报|报告/.test(ls[0] ?? '')))) {
      if (!subtitle) subtitle = [c0.title, ...ls].filter((t) => t && !dup(t)).join(' · ');
      slides = slides.slice(1);
    }
  }
  // 超过 7 条要点拆页
  const expanded = [];
  for (const s of slides) {
    const items = s.blocks.length === 1 && s.blocks[0].type === 'list' ? s.blocks[0].items : null;
    // 7、8 条“标签：说明”排成两行四列的卡片，不拆页
    if (expectedSlides == null && items && items.length > 7 && !(items.length <= 8 && items.every((it) => LABEL.test(plain(it.inlines))))) {
      for (let i = 0; i < items.length; i += 6) expanded.push({ ...s, title: i ? `${s.title}（续）` : s.title, blocks: [{ ...s.blocks[0], items: items.slice(i, i + 6) }], notes: i ? [] : s.notes });
    } else expanded.push(s);
  }
  slides = planTablePages(combineExplanationPages(expanded, { strict: expectedSlides != null }), { strict: expectedSlides != null });
  const budget = slideBudget(slides.length, expectedSlides, requireCover, forbidCover, maxSlides);

  const imageData = async (src) => {
    try {
      const bytes = loadImage ? await loadImage(src) : null;
      const info = bytes && imageInfo(bytes);
      if (!info) { missingImages.push(src); return null; }
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { data: `image/${info.type === 'jpg' ? 'jpeg' : info.type};base64,${btoa(bin)}`, ratio: info.width / info.height };
    } catch (error) { throwControl(error); missingImages.push(src); return null; }
  };

  // ---------- 版式零件（白底、左上标题、右上章节标签、底部页脚；白色卡片带淡阴影和圆形图标）
  const { ICON_PNG, ICON_DARK_PNG } = await import('./pptIcons.js');
  let preferredIcons = [];
  const gold = T.gold; // 点缀色：重点关键词、封面短横线
  const ink2 = T.sub; // 说明文字
  const ink = T.text; // 正文
  const accent = T.accent;
  // 阴影每次给一个新对象：pptxgenjs 会把传进去的阴影就地换算成 EMU，同一个对象复用会一张卡片乘一次，
  // 到后面模糊半径大了上万倍（PowerPoint 里阴影发糊，LibreOffice 转 PDF 时吃到 2GB 内存，服务器被系统杀掉）
  const card = {
    fill: { color: T.surface }, line: { color: T.border, width: 0.75 }, rectRadius: T.radius,
    get shadow() { return T.shadow ? { type: 'outer', color: '1F2D3D', opacity: 0.1, blur: 6, offset: 2, angle: 90 } : undefined; }
  };
  const box = T.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
  const circleColors = theme.official ? [dark] : T.id === 'story' ? [T.strong] : T.id === 'data' ? [accent, C.primary] : [accent, C.primary, C.extra];
  const footTitle = String(title).slice(0, 40);
  let sectionNo = 0;
  let sectionTag = ''; // 右上角：当前在第几部分
  /** 图标：商务是彩色圆 + 白色图标；叙事是细金框圆；数据是方块；留白风格不用图标，写编号 */
  const iconCircle = (sl, x, y, d, name, color, k = 0) => {
    if (T.icon === 'number') {
      const png = ICON_DARK_PNG[name];
      if (png) sl.addImage({ objectName: 'wy-icon-' + name, data: `image/png;base64,${png}`, x, y, w: d, h: d });
      return;
    }
    const shape = T.icon === 'square' ? pptx.ShapeType.rect : pptx.ShapeType.ellipse;
    const line = T.icon === 'ring' ? { color: gold, width: 1.25 } : { color };
    sl.addShape(shape, { x, y, w: d, h: d, fill: { color: T.icon === 'square' ? T.soft : color }, line });
    const png = T.icon === 'square' ? ICON_DARK_PNG[name] : ICON_PNG[name];
    if (png) sl.addImage({ objectName: 'wy-icon-' + name, data: `image/png;base64,${png}`, x: x + d * 0.25, y: y + d * 0.25, w: d * 0.5, h: d * 0.5 });
  };
  /** 标题栏：plain 左上标题；rule 大标题 + 短线；band 顶部色带；story 楷体标题 + 金色细线 + 章节编号 */
  const titleBar = (sl, text) => {
    sl.background = { color: light };
    const w = W - (sectionTag ? 3.9 : 1.8);
    if (T.titleBar === 'band') {
      sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 1.1, fill: { color: C.primary }, line: { color: C.primary } });
      sl.addShape(pptx.ShapeType.rect, { x: 0, y: 1.1, w: W, h: 0.05, fill: { color: accent }, line: { color: accent } });
      sl.addText(text, { x: 0.6, y: 0.15, w, h: 0.8, fontSize: T.titleSize, bold: true, color: 'FFFFFF', fontFace: HFONT, valign: 'middle', fit: 'shrink' });
      if (sectionTag) sl.addText(sectionTag, { x: W - 3.1, y: 0.35, w: 2.0, h: 0.45, fontSize: 10, color: mixSoft, fontFace: FONT, align: 'right', valign: 'middle' });
      return;
    }
    if (T.titleBar === 'story') {
      sl.addText(text, { x: 0.8, y: 0.42, w: w - 0.2, h: 0.8, fontSize: T.titleSize, bold: true, color: head, fontFace: HFONT, valign: 'middle', fit: 'shrink' });
      sl.addShape(pptx.ShapeType.line, { x: 0.8, y: 1.28, w: 1.6, h: 0, line: { color: gold, width: 1.5 } });
      sl.addShape(pptx.ShapeType.line, { x: 2.5, y: 1.28, w: W - 3.3, h: 0, line: { color: T.border, width: 0.5 } });
      if (sectionTag) sl.addText(sectionTag, { x: W - 3.3, y: 0.55, w: 2.0, h: 0.45, fontSize: 11, color: gold, fontFace: HFONT, align: 'right', valign: 'middle' });
      return;
    }
    if (T.titleBar === 'rule') {
      sl.addText(text, { x: 0.6, y: 0.35, w, h: 0.9, fontSize: T.titleSize, bold: true, color: head, fontFace: HFONT, valign: 'middle', fit: 'shrink' });
      sl.addShape(pptx.ShapeType.rect, { x: 0.62, y: 1.3, w: 0.6, h: 0.05, fill: { color: accent }, line: { color: accent } });
      if (sectionTag) sl.addText(sectionTag, { x: W - 3.1, y: 0.6, w: 2.0, h: 0.45, fontSize: 10, color: muted, fontFace: FONT, align: 'right', valign: 'middle' });
      return;
    }
    sl.addText(text, { x: 0.6, y: 0.38, w, h: 0.8, fontSize: T.titleSize, bold: true, color: head, fontFace: HFONT, valign: 'middle', fit: 'shrink' });
    if (sectionTag) sl.addText(sectionTag, { x: W - 3.1, y: 0.55, w: 2.0, h: 0.45, fontSize: 10, color: accent, fontFace: FONT, align: 'right', valign: 'middle' });
  };
  const mixSoft = C.soft;
  const pageNo = (sl, n) => {
    if (T.id === 'story') {
      sl.addShape(pptx.ShapeType.line, { x: 0.8, y: H - 0.5, w: W - 1.6, h: 0, line: { color: T.border, width: 0.5 } });
      sl.addText(footTitle, { x: 0.8, y: H - 0.45, w: 8, h: 0.3, fontSize: 9, color: muted, fontFace: HFONT, valign: 'middle' });
      sl.addText(String(n), { x: W - 1.3, y: H - 0.45, w: 0.5, h: 0.3, fontSize: 10, color: gold, align: 'right', fontFace: FONT, valign: 'middle' });
      return;
    }
    sl.addText(footTitle, { x: 0.6, y: H - 0.42, w: 8, h: 0.28, fontSize: 8, color: muted, fontFace: FONT, valign: 'middle' });
    sl.addText(String(n), { x: W - 1.1, y: H - 0.42, w: 0.5, h: 0.28, fontSize: 9, color: muted, align: 'right', fontFace: FONT, valign: 'middle' });
  };
  /** 重点横条：“标签：内容”的标签用点缀色；留白风格是左边一道色条、不铺底色 */
  const highlight = (sl, text, { x = 0.6, y, w = W - 1.2, h = 0.62 } = {}) => {
    const m = LABEL.exec(text);
    if (T.id === 'minimal') {
      sl.addShape(pptx.ShapeType.rect, { x, y: y + 0.08, w: 0.06, h: h - 0.16, fill: { color: accent }, line: { color: accent } });
      const runs = m ? [{ text: `${m[1].trim()}　`, options: { bold: true, color: accent } }, { text: m[2].trim(), options: { color: ink } }] : [{ text, options: { color: ink } }];
      sl.addText(runs, { x: x + 0.25, y, w: w - 0.3, h, fontSize: 15, fontFace: FONT, valign: 'middle', fit: 'shrink' });
      return;
    }
    sl.addShape(box, { x, y, w, h, fill: { color: dark }, line: { color: T.id === 'story' ? gold : dark, width: 0.75 }, rectRadius: 0.05 });
    const runs = m ? [{ text: `${m[1].trim()}　`, options: { bold: true, color: gold } }, { text: m[2].trim(), options: { color: T.onStrong } }] : [{ text, options: { color: T.onStrong } }];
    sl.addText(runs, { x: x + 0.3, y, w: w - 0.6, h, fontSize: 15, fontFace: FONT, valign: 'middle', fit: 'shrink' });
  };
  /** 右侧装饰：商务是几个半透明的圆；叙事是金色细线框和大字章节号；其他风格不加 */
  const ornament = (sl, x0, onDark = false, mark = '') => {
    if (T.id === 'story') {
      sl.addShape(pptx.ShapeType.rect, { x: 0.35, y: 0.35, w: W - 0.7, h: H - 0.7, fill: { color: light, transparency: 100 }, line: { color: gold, width: 0.75 } });
      sl.addShape(pptx.ShapeType.rect, { x: 0.45, y: 0.45, w: W - 0.9, h: H - 0.9, fill: { color: light, transparency: 100 }, line: { color: T.border, width: 0.5 } });
      if (mark) sl.addText(mark, { deco: true, x: W - 4.6, y: 1.2, w: 3.8, h: 4.6, fontSize: 200, color: mix2(light, gold, 0.16), fontFace: HFONT, align: 'center', valign: 'middle' });
      return;
    }
    if (!T.ornament) return;
    const ring = (x, y, d, color, t) => sl.addShape(pptx.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color, transparency: t }, line: { color, transparency: t } });
    ring(x0 + 1.2, 0.9, 4.4, onDark ? 'FFFFFF' : accent, onDark ? 92 : 78);
    ring(x0 + 3.0, 3.5, 3.2, onDark ? accent : gold, onDark ? 60 : 72);
    ring(x0 + 0.5, 4.4, 2.0, onDark ? 'FFFFFF' : dark, onDark ? 94 : 85);
  };
  const bulletRuns = (items, size) => items.flatMap((it, i) => {
    const run = (s) => ({ text: s.text, options: { bold: s.bold, italic: s.italic, color: s.link ? '0563C1' : undefined } });
    let first = it.inlines.map(run);
    // “标签：说明”的标签加粗，一眼能扫到重点
    const m = !it.inlines.some((x) => x.bold) && LABEL.exec(plain(it.inlines));
    if (m) first = [{ text: `${m[1]}：`, options: { bold: true, color: head } }, { text: m[2], options: {} }];
    first[0] = { ...first[0], options: { ...first[0]?.options, bullet: { code: '25CF', indent: 22 }, paraSpaceBefore: i ? Math.round(size * 0.6) : 0 } };
    first[first.length - 1].options.breakLine = true;
    const subs = it.children.filter((c) => c.type === 'list').flatMap((c) => c.items.map((sub) => ({ text: plain(sub.inlines), options: { bullet: { indent: 22 }, indentLevel: 1, fontSize: size - 4, color: ink2, breakLine: true } })));
    return [...first, ...subs];
  });
  const textOf = (bs) => bs.flatMap((b) => (b.type === 'list' ? [b] : b.type === 'paragraph' ? [{ type: 'list', items: [{ inlines: b.inlines, children: [] }] }] : []));
  // 字号按文字量定：字少就大，把页面用起来，不要小字挤在左上角
  const fontFor = (n, chars) => {
    const c = chars + n * 12;
    const size = c < 140 ? 24 : c < 220 ? 22 : c < 320 ? 20 : c < 440 ? 19 : c < 580 ? 17 : 16;
    return n > 6 ? Math.min(size, 18) : size;
  };
  const labelOf = (it) => { const m = LABEL.exec(plain(it.inlines)); return m ? { label: m[1].trim(), text: m[2].trim() } : { label: '', text: plain(it.inlines) }; };
  /** 卡片网格：3 个一行；4 个两行两列；5、6 个两行三列。白底卡片 + 圆形图标 + 标题 + 说明 */
  const cardGrid = (sl, items, { top = 1.55, bottom = 6.85, left = 0.6, width = W - 1.2 } = {}) => {
    const n = items.length;
    const cols = n === 4 ? 2 : n >= 7 ? 4 : Math.min(3, n);
    const rows = Math.ceil(n / cols);
    const gap = 0.3;
    const w = (width - gap * (cols - 1)) / cols;
    let h = (bottom - top - gap * (rows - 1)) / rows;
    // 只有一行时卡片不拉满整页（下面会空一大块），收矮一些、上下居中
    if (rows === 1 && h > 3.6) { top += (h - 3.6) / 2; h = 3.6; }
    const inline = h < 2.9; // 矮卡片：图标和标题放同一行，给说明留出地方
    const d = inline ? 0.5 : 0.62;
    const descTop = inline ? 0.95 : 1.62;
    const descH = Math.max(0.5, h - descTop - 0.18);
    const pick = iconPicker(preferredIcons);
    const parsed = items.map(labelOf);
    // 同一页的卡片说明用同一个字号（取放得下的最小值），不要一张大一张小
    const descSize = Math.min(...parsed.map(({ text }) => {
      const guess = Math.max(13, Math.min(18, Math.floor(Math.sqrt(((w - 0.56) * descH * 5200) / Math.max(20, text.length * 1.3)))));
      return fitText(text, { w: w - 0.56, h: descH, fontSize: guess, lineSpacingMultiple: 1.3 }).o.fontSize;
    }));
    parsed.forEach(({ label, text }, k) => {
      const x = left + (k % cols) * (w + gap);
      const y = top + Math.floor(k / cols) * (h + gap);
      sl.addShape(box, { x, y, w, h, ...card });
      iconCircle(sl, x + 0.28, y + 0.28, d, pick(`${label} ${text}`), circleColors[k % circleColors.length], k);
      if (inline) sl.addText(label || text, { x: x + 0.28 + d + 0.18, y: y + 0.28, w: w - d - 0.74, h: d, fontSize: 18, bold: true, color: head, fontFace: FONT, valign: 'middle', fit: 'shrink' });
      else sl.addText(label || text, { x: x + 0.28, y: y + 1.04, w: w - 0.56, h: 0.5, fontSize: 19, bold: true, color: head, fontFace: FONT, valign: 'middle', fit: 'shrink' });
      if (label) sl.addText(text, { x: x + 0.28, y: y + descTop, w: w - 0.56, h: descH, fontSize: descSize, color: ink2, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.3, fit: 'shrink' });
    });
  };
  /** 一排大圆：标签写在圆里，说明在下面（标签都很短时用，如“提质 / 提档 / 提效”） */
  const circleRow = (sl, items) => {
    const n = items.length;
    const slot = (W - 1.2) / n;
    const d = Math.min(1.7, slot - 0.5);
    const descH = 6.85 - (1.75 + d + 0.35);
    const descSize = Math.min(...items.map(({ text }) => fitText(text, { w: slot - 0.4, h: descH, fontSize: 17, lineSpacingMultiple: 1.3 }).o.fontSize));
    items.forEach(({ label, text }, k) => {
      const cx = 0.6 + k * slot + slot / 2;
      const color = T.id === 'story' ? dark : k % 2 ? accent : dark;
      sl.addShape(pptx.ShapeType.ellipse, { x: cx - d / 2, y: 1.75, w: d, h: d, fill: { color }, line: { color: T.id === 'story' ? gold : light, width: T.id === 'story' ? 1.25 : 3 }, shadow: card.shadow });
      sl.addText(label, { x: cx - d / 2, y: 1.75, w: d, h: d, fontSize: 22, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT, fit: 'shrink' });
      sl.addText(text, { x: cx - slot / 2 + 0.2, y: 1.75 + d + 0.35, w: slot - 0.4, h: descH, fontSize: descSize, color: ink2, align: 'center', valign: 'top', lineSpacingMultiple: 1.3, fontFace: FONT, fit: 'shrink' });
    });
  };
  /** 一行一条：白色长条卡片，左边图标，标签和说明排在一行（条目少时用） */
  const iconRows = (sl, items, { top = 1.6, bottom = 6.85 } = {}) => {
    const gap = 0.25;
    const h = Math.min(1.25, (bottom - top - gap * (items.length - 1)) / items.length);
    const pick = iconPicker(preferredIcons);
    items.forEach(({ label, text }, k) => {
      const y = top + k * (h + gap);
      sl.addShape(box, { x: 0.6, y, w: W - 1.2, h, ...card });
      iconCircle(sl, 0.9, y + h / 2 - 0.3, 0.6, pick(`${label} ${text}`), circleColors[k % circleColors.length], k);
      sl.addText(label, { x: 1.75, y, w: 2.4, h, fontSize: 19, bold: true, color: head, fontFace: FONT, valign: 'middle', fit: 'shrink' });
      sl.addShape(pptx.ShapeType.line, { x: 4.25, y: y + 0.25, w: 0, h: h - 0.5, line: { color: 'E3E8F0', width: 1 } });
      sl.addText(text, { x: 4.45, y, w: W - 5.35, h, fontSize: 17, color: ink2, fontFace: FONT, valign: 'middle', lineSpacingMultiple: 1.2, fit: 'shrink' });
    });
  };
  /** 左右分栏：左边深色块放第一条（最重要的一条），右边卡片放其余（条目多时用） */
  const splitPanel = (sl, items, raw) => {
    const [first, ...rest] = items;
    const pw2 = 4.3;
    sl.addShape(box, { x: 0.6, y: 1.55, w: pw2, h: 5.3, fill: { color: dark }, line: { color: T.id === 'story' ? gold : dark, width: 0.75 }, rectRadius: 0.06 });
    iconCircle(sl, 0.95, 1.9, 0.62, iconPicker(preferredIcons)(`${first.label} ${first.text}`), accent);
    sl.addText(first.label, { x: 0.95, y: 2.75, w: pw2 - 0.7, h: 0.6, fontSize: 20, bold: true, color: gold, fontFace: FONT, valign: 'middle', fit: 'shrink' });
    sl.addText(first.text, { x: 0.95, y: 3.45, w: pw2 - 0.7, h: 3.1, fontSize: 20, color: T.onStrong, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.35, fit: 'shrink' });
    cardGrid(sl, raw.slice(1), { left: 0.6 + pw2 + 0.3, width: W - 1.2 - pw2 - 0.3 });
    return rest;
  };

  /**
   * 普通要点页（2–6 条短句）按风格换构图，连续几页轮换，不要每页都是“一行一张卡片”：
   *   story    竖线串起来的情节 / 左边大字章节号 + 右边要点
   *   minimal  大编号 + 细分隔线 / 两栏编号
   *   data     左边色条的方块网格 / 斑马纹行
   *   business 一行一张白卡片 + 图标（原来的样子）
   */
  const listPage = (sl, items, k, pageNo) => {
    const n = items.length;
    const runs = (it, color = ink) => it.inlines.map((r) => ({ text: r.text, options: { bold: r.bold, italic: r.italic, color } }));
    const len = Math.max(...items.map((it) => plain(it.inlines).length));
    const size = len > 40 ? 18 : len > 26 ? 20 : 22;
    if (T.id === 'story') {
      if (k % 2 === 0) {
        // 一条竖线，每件事一个金点：像一段情节的推进
        const top = 1.85, bottom = 6.55, gap = (bottom - top) / n;
        sl.addShape(pptx.ShapeType.line, { x: 1.35, y: top + 0.1, w: 0, h: bottom - top - gap + 0.3, line: { color: T.border, width: 1 } });
        items.forEach((it, i) => {
          const y = top + i * gap;
          sl.addShape(pptx.ShapeType.ellipse, { x: 1.24, y: y + 0.12, w: 0.22, h: 0.22, fill: { color: gold }, line: { color: light, width: 2 } });
          sl.addText(runs(it), { x: 1.8, y: y - 0.05, w: W - 6.5, h: Math.min(gap, 1.2), fontSize: size, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.25, fit: 'shrink' });
        });
        ornament(sl, 0, true, chapterMark(T, pageNo - 2));
      } else {
        // 左边大字章节号，右边要点（细线分隔）
        sl.addText(chapterMark(T, pageNo - 2), { x: 0.8, y: 1.7, w: 3.4, h: 3.4, fontSize: 150, color: gold, fontFace: HFONT, align: 'center', valign: 'middle' });
        sl.addShape(pptx.ShapeType.line, { x: 4.5, y: 1.9, w: 0, h: 4.6, line: { color: T.border, width: 1 } });
        const top = 1.8, gap = 4.9 / n;
        items.forEach((it, i) => {
          const y = top + i * gap;
          sl.addText('◆', { x: 4.85, y, w: 0.4, h: 0.5, fontSize: 12, color: gold, fontFace: FONT, valign: 'middle' });
          sl.addText(runs(it), { x: 5.3, y, w: W - 6.2, h: Math.min(gap - 0.1, 1.2), fontSize: size, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.25, fit: 'shrink' });
          if (i < n - 1) sl.addShape(pptx.ShapeType.line, { x: 5.3, y: y + gap - 0.12, w: W - 6.2, h: 0, line: { color: T.grid, width: 0.5 } });
        });
      }
      return;
    }
    if (T.id === 'minimal') {
      if (k % 2 === 0 || n < 4) {
        const top = 1.75, gap = Math.min(1.25, 4.9 / n);
        items.forEach((it, i) => {
          const y = top + i * gap;
          sl.addText(String(i + 1).padStart(2, '0'), { x: 0.6, y, w: 1.0, h: gap - 0.15, fontSize: 30, bold: true, color: accent, fontFace: FONT, valign: 'middle' });
          sl.addText(runs(it), { x: 1.8, y, w: W - 2.6, h: gap - 0.15, fontSize: size, fontFace: FONT, valign: 'middle', fit: 'shrink' });
          sl.addShape(pptx.ShapeType.line, { x: 0.6, y: y + gap - 0.08, w: W - 1.2, h: 0, line: { color: T.border, width: 0.75 } });
        });
      } else {
        const cols = 2, rows = Math.ceil(n / cols), cw = (W - 1.2 - 0.8) / cols, rh = Math.min(2.2, 4.9 / rows);
        items.forEach((it, i) => {
          const x = 0.6 + (i % cols) * (cw + 0.8), y = 1.8 + Math.floor(i / cols) * rh;
          sl.addShape(pptx.ShapeType.line, { x, y, w: cw, h: 0, line: { color: head, width: 1.25 } });
          sl.addText(String(i + 1).padStart(2, '0'), { x, y: y + 0.15, w: 1, h: 0.5, fontSize: 16, bold: true, color: accent, fontFace: FONT });
          sl.addText(runs(it), { x, y: y + 0.65, w: cw, h: rh - 0.85, fontSize: size - 2, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.25, fit: 'shrink' });
        });
      }
      return;
    }
    if (T.id === 'data') {
      if (k % 2 === 0 && n >= 3) {
        const cols = n <= 4 ? 2 : 3, rows = Math.ceil(n / cols), gap = 0.25, cw = (W - 1.2 - gap * (cols - 1)) / cols, ch = Math.min(2.3, (5.2 - gap * (rows - 1)) / rows);
        items.forEach((it, i) => {
          const x = 0.6 + (i % cols) * (cw + gap), y = 1.6 + Math.floor(i / cols) * (ch + gap);
          sl.addShape(pptx.ShapeType.rect, { x, y, w: cw, h: ch, fill: { color: T.surface }, line: { color: T.surface } });
          sl.addShape(pptx.ShapeType.rect, { x, y, w: 0.08, h: ch, fill: { color: i % 2 ? C.primary : accent }, line: { color: i % 2 ? C.primary : accent } });
          sl.addText(String(i + 1).padStart(2, '0'), { x: x + 0.3, y: y + 0.15, w: 1, h: 0.45, fontSize: 14, bold: true, color: accent, fontFace: FONT });
          sl.addText(runs(it), { x: x + 0.3, y: y + 0.6, w: cw - 0.5, h: ch - 0.75, fontSize: size - 2, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.2, fit: 'shrink' });
        });
      } else {
        const top = 1.6, rh = Math.min(1.0, 5.2 / n);
        items.forEach((it, i) => {
          const y = top + i * rh;
          sl.addShape(pptx.ShapeType.rect, { x: 0.6, y, w: W - 1.2, h: rh, fill: { color: i % 2 ? 'FFFFFF' : T.surface }, line: { color: i % 2 ? 'FFFFFF' : T.surface } });
          sl.addShape(pptx.ShapeType.rect, { x: 0.6, y, w: 0.9, h: rh, fill: { color: C.primary }, line: { color: C.primary } });
          sl.addText(String(i + 1), { x: 0.6, y, w: 0.9, h: rh, fontSize: 18, bold: true, color: 'FFFFFF', fontFace: FONT, align: 'center', valign: 'middle' });
          sl.addText(runs(it), { x: 1.75, y, w: W - 2.6, h: rh, fontSize: size - 1, fontFace: FONT, valign: 'middle', fit: 'shrink' });
        });
      }
      return;
    }
    const gap = 0.25, top = 1.6, h = Math.min(1.2, (5.2 - gap * (n - 1)) / n);
    const pick = iconPicker(preferredIcons);
    items.forEach((it, i) => {
      const y = top + i * (h + gap);
      sl.addShape(box, { x: 0.6, y, w: W - 1.2, h, ...card });
      iconCircle(sl, 0.9, y + h / 2 - 0.3, 0.6, pick(plain(it.inlines)), circleColors[i % circleColors.length], i);
      sl.addText(it.inlines.map((r) => ({ text: r.text, options: { bold: r.bold, italic: r.italic } })), { x: 1.75, y, w: W - 2.75, h, fontSize: 21, color: ink, fontFace: FONT, valign: 'middle', fit: 'shrink' });
    });
  };

  /** 一排箭头：流程链或步骤；步骤的说明放在箭头下面的卡片里 */
  const chevrons = (sl, nodes, { y = 1.75, h = 0.85, descs = null, bottom = 6.85, descH = null, descSize = null, nodeSize = null } = {}) => {
    const n = Math.min(nodes.length, 7);
    const w = (W - 1.2) / n;
    nodes.slice(0, n).forEach((t, k) => {
      const x = 0.6 + k * w;
      const color = k % 2 ? dark : accent;
      sl.addShape(k ? pptx.ShapeType.chevron : pptx.ShapeType.homePlate, { x, y, w: w + 0.12, h, fill: { color }, line: { color: light, width: 1 } });
      sl.addText(t, { x: x + (k ? 0.3 : 0.1), y, w: w - 0.35, h, fontSize: nodeSize ?? (n > 5 ? 13 : 15), bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT, fit: 'shrink' });
      if (descs?.[k]) {
        const cy = y + h + 0.3;
        const ch = Math.min(bottom - cy, descH ?? Infinity);
        sl.addShape(box, { x: x + 0.05, y: cy, w: w - 0.1, h: ch, ...card });
        sl.addText(descs[k], { x: x + 0.2, y: cy + 0.15, w: w - 0.4, h: ch - 0.3, fontSize: descSize ?? (n > 5 ? 14 : 16), color: ink2, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.25, fit: 'shrink' });
      }
    });
  };

  let localDecoration = null;
  const localVisualIssues = [];
  try { localDecoration = await decorationData(title + content.slice(0, 500), accent, renderSvg, signal); }
  catch (error) { throwControl(error, signal); localVisualIssues.push({ level: 'warn', text: '本地装饰未生成：' + String(error.message).slice(0, 120) }); }
  // ---------- 封面：商务是左边深色块 + 右边装饰；留白是大字 + 细线；叙事是居中大字 + 金框；数据是顶部色带
  const pw = 7.4;
  if (budget.cover) {
  const cover = addSlide(title);
  // 单位 / 署名里已经带了日期就不再重复写日期
  const coverDate = /\d{4}\s*年|\d{4}[-./]\d{1,2}/.test(author) ? '' : (date || today());
  if (coverImages.length) {
    await placeSlideImages(cover, coverImages, 'cover', { load: imageData, missingImages });
    cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: '101D35', transparency: 35 }, line: { transparency: 100 } });
    cover.addText(title, { x: 0.9, y: 2.1, w: 11.5, h: 1.8, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: HFONT, fit: 'shrink' });
    if (subtitle) cover.addText(subtitle, { x: 0.9, y: 4.15, w: 11.5, h: 1.1, fontSize: 20, color: 'FFFFFF', fontFace: FONT });
    cover.addText([author, coverDate].filter(Boolean).join(' · '), { x: 0.9, y: 6.1, w: 11.5, h: 0.5, fontSize: 14, color: 'FFFFFF', fontFace: FONT });
  } else if (T.cover === 'centered') {
    cover.background = { color: light };
    ornament(cover, pw, true);
    if (author) cover.addText(author, { x: 1.5, y: 1.15, w: W - 3, h: 0.4, fontSize: 13, color: gold, fontFace: HFONT, align: 'center' });
    cover.addText(title, { x: 1.2, y: 1.8, w: W - 2.4, h: 2.0, fontSize: 40, bold: true, color: head, fontFace: HFONT, align: 'center', valign: 'bottom', fit: 'shrink' });
    cover.addShape(pptx.ShapeType.line, { x: W / 2 - 2.2, y: 4.05, w: 1.6, h: 0, line: { color: gold, width: 1 } });
    cover.addShape(pptx.ShapeType.ellipse, { x: W / 2 - 0.09, y: 3.96, w: 0.18, h: 0.18, fill: { color: gold }, line: { color: gold } });
    cover.addShape(pptx.ShapeType.line, { x: W / 2 + 0.6, y: 4.05, w: 1.6, h: 0, line: { color: gold, width: 1 } });
    if (subtitle) cover.addText(subtitle, { x: 1.5, y: 4.35, w: W - 3, h: 1.1, fontSize: 16, color: ink2, fontFace: FONT, align: 'center', valign: 'top', fit: 'shrink' });
    if (coverDate) cover.addText(coverDate, { objectName: 'wy-cover-meta', x: 1.5, y: H - 1.25, w: W - 3, h: 0.4, fontSize: 12, color: muted, fontFace: FONT, align: 'center' });
  } else if (T.cover === 'airy') {
    cover.background = { color: light };
    cover.addShape(pptx.ShapeType.rect, { x: 0.9, y: 1.2, w: 0.08, h: 3.6, fill: { color: accent }, line: { color: accent } });
    if (author) cover.addText(author, { x: 1.3, y: 1.1, w: W - 2.6, h: 0.4, fontSize: 13, color: muted, fontFace: FONT });
    cover.addText(title, { x: 1.3, y: 1.6, w: W - 2.6, h: 2.2, fontSize: 44, bold: true, color: head, fontFace: HFONT, valign: 'bottom', fit: 'shrink' });
    if (subtitle) cover.addText(subtitle, { x: 1.3, y: 3.95, w: W - 2.6, h: 0.9, fontSize: 18, color: ink2, fontFace: FONT, valign: 'top', fit: 'shrink' });
    if (coverDate) cover.addText(coverDate, { objectName: 'wy-cover-meta', x: 1.3, y: H - 1.2, w: 6, h: 0.4, fontSize: 12, color: muted, fontFace: FONT });
    cover.addShape(pptx.ShapeType.line, { x: 1.3, y: H - 1.35, w: W - 2.6, h: 0, line: { color: T.border, width: 0.75 } });
  } else if (T.cover === 'band') {
    cover.background = { color: light };
    cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 4.6, fill: { color: C.primary }, line: { color: C.primary } });
    cover.addShape(pptx.ShapeType.rect, { x: 0, y: 4.6, w: W, h: 0.12, fill: { color: accent }, line: { color: accent } });
    if (author) cover.addText(author, { x: 0.8, y: 0.8, w: W - 1.6, h: 0.4, fontSize: 13, color: C.soft, fontFace: FONT });
    cover.addText(title, { x: 0.8, y: 1.4, w: W - 1.6, h: 2.0, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: HFONT, valign: 'bottom', fit: 'shrink' });
    if (subtitle) cover.addText(subtitle, { x: 0.8, y: 3.5, w: W - 1.6, h: 0.9, fontSize: 17, color: C.soft, fontFace: FONT, valign: 'top', fit: 'shrink' });
    if (coverDate) cover.addText(coverDate, { objectName: 'wy-cover-meta', x: 0.8, y: 5.1, w: 6, h: 0.4, fontSize: 13, color: ink2, fontFace: FONT });
  } else {
    cover.background = { color: theme.official ? 'FFFFFF' : C.soft };
    cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: pw, h: H, fill: { color: dark }, line: { color: dark } });
    ornament(cover, pw);
    if (author) cover.addText(author, { x: 0.8, y: 0.9, w: pw - 1.4, h: 0.4, fontSize: 12, color: gold, fontFace: FONT });
    cover.addText(title, { x: 0.8, y: 1.6, w: pw - 1.4, h: 2.1, fontSize: 36, bold: true, color: 'FFFFFF', fontFace: HFONT, valign: 'bottom', fit: 'shrink' });
    cover.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.9, w: 1.0, h: 0.06, fill: { color: gold }, line: { color: gold } });
    if (subtitle) cover.addText(subtitle, { x: 0.8, y: 4.1, w: pw - 1.4, h: 1.0, fontSize: 16, color: C.soft, fontFace: FONT, valign: 'top', fit: 'shrink' });
    if (coverDate) cover.addText(coverDate, { objectName: 'wy-cover-meta', x: 0.8, y: H - 1.1, w: pw - 1.4, h: 0.4, fontSize: 12, color: C.soft, fontFace: FONT });
  }
  if (localDecoration && !coverImages.length) cover.addImage({ data: localDecoration, x: 10.7, y: 4.2, w: 2.7 * 560 / 960, h: 2.7, sizing: { type: 'cover', w: 2.0, h: 2.7 }, objectName: 'wy-decoration-cover' });
  layouts.push('cover');
  }

  if (!budget.cover && coverImages.length) for (const image of coverImages) missingImages.push(`${image.src}（当前页数约束未包含封面）`);
  // ---------- 汇报提纲：有两个以上“第 X 部分”时自动加
  const kinds = slides.map((s, i) => layoutOf(s, { last: i === slides.length - 1 }));
  const sections = slides.filter((s, i) => kinds[i] === 'section');
  const shortTitle = (t) => String(t).replace(SECTION, '').replace(/^[\s:：、.，,]+/, '').trim() || String(t);
  if (!budget.strict && sections.length >= 2) {
    const sl = addSlide('汇报提纲');
    titleBar(sl, '汇报提纲');
    const n = Math.min(sections.length, 6);
    const gap = 0.25;
    const h = Math.min(1.1, (5.3 - gap * (n - 1)) / n);
    const top = 1.6 + (5.3 - (n * h + (n - 1) * gap)) / 2;
    sections.slice(0, n).forEach((s, k) => {
      const y = top + k * (h + gap);
      sl.addShape(box, { x: 0.6, y, w: W - 1.2, h, ...card });
      sl.addText(chapterMark(T, k), { x: 0.9, y, w: 1.0, h, fontSize: 28, bold: true, color: accent, fontFace: HFONT, valign: 'middle' });
      sl.addText(shortTitle(s.title), { x: 2.0, y, w: W - 3.0, h, fontSize: 20, bold: true, color: head, fontFace: FONT, valign: 'middle', fit: 'shrink' });
    });
    pageNo(sl, records.length);
    layouts.push('agenda');
  }

  // ---------- 各页
  const pages = []; // 每页的页码和版式：查“连续好几页都是普通列表”
  const ignored = []; // 指定了版式但内容排不成的页
  let listRun = 0; // 连续几页普通要点：换着用不同构图
  const cardVariants = []; // 连续卡片页各用了哪种版式；中间隔了别的版式就重新开始
  for (const [i, s] of slides.entries()) {
    const kind = kinds[i];
    preferredIcons = s.iconNames || [];
    if (kind !== 'cards') cardVariants.length = 0;
    if (kind !== 'bullets') listRun = 0;
    layouts.push(kind);
    const sl = addSlide(s.title);
    const n = records.length;
    pages.push({ n, kind });
    const why = ignoredLayout(s, kind);
    if (why) ignored.push({ level: 'warn', slide: n, text: `第 ${n} 页${why}` });
    const images = s.blocks.filter(block => block.type === 'image');
    const summary = kind === 'table' && !images.length ? summarizeTable(s.blocks.find(block => block.type === 'table')) : null;
    const restoreImageSpace = (images.length || summary) && !['image', 'imageText'].includes(kind) ? reserveImageColumn(sl) : () => {};
    const lines = s.blocks.flatMap(blockLines).filter(Boolean);
    switch (kind) {
      case 'section': {
        sectionNo++;
        const mark = chapterMark(T, sectionNo - 1);
        sectionTag = `${mark} ${shortTitle(s.title)}`.slice(0, 24);
        if (T.section === 'story') {
          sl.background = { color: light };
          ornament(sl, pw, true, mark);
          sl.addText(`第${mark}章`, { x: 1.2, y: 1.9, w: 5, h: 0.7, fontSize: 22, color: gold, fontFace: HFONT, valign: 'bottom' });
          sl.addText(shortTitle(s.title), { x: 1.2, y: 2.7, w: 7.6, h: 1.5, fontSize: 38, bold: true, color: head, fontFace: HFONT, valign: 'top', fit: 'shrink' });
          if (lines.length) sl.addText(lines.join('　'), { x: 1.2, y: 4.3, w: 7.6, h: 1.0, fontSize: 16, color: ink2, fontFace: FONT, valign: 'top', fit: 'shrink' });
        } else if (T.section === 'light' || T.section === 'band') {
          sl.background = { color: light };
          if (T.section === 'band') sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.35, h: H, fill: { color: C.primary }, line: { color: C.primary } });
          sl.addText(mark, { x: 0.9, y: 1.2, w: 4, h: 1.8, fontSize: 96, bold: true, color: accent, fontFace: FONT, valign: 'bottom' });
          sl.addShape(pptx.ShapeType.rect, { x: 0.95, y: 3.2, w: 0.8, h: 0.06, fill: { color: accent }, line: { color: accent } });
          sl.addText(shortTitle(s.title), { x: 0.9, y: 3.45, w: W - 1.8, h: 1.3, fontSize: 36, bold: true, color: head, fontFace: HFONT, valign: 'top', fit: 'shrink' });
          if (lines.length) sl.addText(lines.join('　'), { x: 0.9, y: 4.8, w: W - 1.8, h: 0.8, fontSize: 16, color: ink2, fontFace: FONT, valign: 'top', fit: 'shrink' });
        } else {
          sl.background = { color: dark };
          ornament(sl, pw, true);
          sl.addText(mark, { x: 0.8, y: 1.7, w: 3, h: 1.1, fontSize: 60, bold: true, color: gold, fontFace: FONT, valign: 'bottom' });
          sl.addText(shortTitle(s.title), { x: 0.8, y: 2.9, w: pw, h: 1.3, fontSize: 36, bold: true, color: 'FFFFFF', fontFace: HFONT, valign: 'top', fit: 'shrink' });
          if (lines.length) sl.addText(lines.join('　'), { x: 0.8, y: 4.3, w: pw, h: 0.8, fontSize: 16, color: C.soft, fontFace: FONT, valign: 'top', fit: 'shrink' });
        }
        break;
      }
      case 'end': {
        const words = s.title || '谢谢';
        if (T.cover !== 'split') {
          // 其他风格的结尾页：和封面同一种构图，居中或靠左的大字
          sl.background = { color: T.cover === 'band' ? C.primary : light };
          if (T.cover === 'centered') ornament(sl, pw, true);
          const onBand = T.cover === 'band';
          const center = T.cover === 'centered';
          if (lines.length) sl.addText(lines.join('\n'), { x: 1.2, y: 1.6, w: W - 2.4, h: 2.1, fontSize: 28, bold: true, color: onBand ? 'FFFFFF' : head, fontFace: HFONT, align: center ? 'center' : 'left', valign: 'bottom', fit: 'shrink' });
          sl.addText(words, { x: 1.2, y: lines.length ? 4.1 : 2.6, w: W - 2.4, h: 1.2, fontSize: lines.length ? 28 : 48, bold: true, color: lines.length ? gold : onBand ? 'FFFFFF' : head, fontFace: HFONT, align: center ? 'center' : 'left', valign: 'middle', fit: 'shrink' });
          break;
        }
        sl.background = { color: theme.official ? 'FFFFFF' : C.soft };
        sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: pw, h: H, fill: { color: dark }, line: { color: dark } });
        ornament(sl, pw);
        if (lines.length) {
          sl.addText(lines.join('\n'), { x: 0.8, y: 1.8, w: pw - 1.4, h: 2.0, fontSize: 28, bold: true, color: 'FFFFFF', fontFace: HFONT, valign: 'bottom', fit: 'shrink' });
          sl.addText(words, { x: 0.8, y: 4.3, w: pw - 1.4, h: 0.8, fontSize: 28, bold: true, color: gold, fontFace: HFONT });
        } else {
          sl.addText(words, { x: 0.8, y: 2.3, w: pw - 1.4, h: 1.5, fontSize: 48, bold: true, color: 'FFFFFF', fontFace: HFONT, valign: 'bottom', fit: 'shrink' });
          sl.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.95, w: 1.0, h: 0.06, fill: { color: gold }, line: { color: gold } });
        }
        break;
      }
      case 'stats': {
        titleBar(sl, s.title);
        const all = entriesOf(s.blocks).map((it) => plain(it.inlines));
        const items = all.map(numMatch).filter(Boolean).slice(0, 6);
        const foot = [...all.filter((t) => !numMatch(t)), ...s.blocks.filter(b => b.type === 'heading').flatMap(blockLines)];
        // 4 个以内一行；5、6 个排两行（3 + 2 / 3 + 3）
        const gap = 0.3;
        const cols = items.length <= 4 ? items.length : 3;
        const rows = Math.ceil(items.length / cols);
        const cw = (W - 1.2 - gap * (cols - 1)) / cols;
        const ch = rows === 1 ? 3.6 : foot.length ? 2.15 : 2.45;
        const top = rows === 1 ? 1.9 : 1.55;
        const pick = iconPicker(preferredIcons);
        items.forEach((m, k) => {
          const x = 0.6 + (k % cols) * (cw + gap);
          const y = top + Math.floor(k / cols) * (ch + gap);
          const big = rows === 1;
          sl.addShape(box, { x, y, w: cw, h: ch, ...card });
          iconCircle(sl, x + cw / 2 - (big ? 0.33 : 0.27), y + (big ? 0.35 : 0.22), big ? 0.66 : 0.54, pick(m[2]), circleColors[k % circleColors.length], k);
          sl.addText(m[1].trim(), { x, y: y + (big ? 1.15 : 0.82), w: cw, h: big ? 1.0 : 0.75, fontSize: big ? 40 : 32, bold: true, color: accent, align: 'center', valign: 'middle', fontFace: FONT, fit: 'shrink' });
          sl.addText(m[2].trim(), { x: x + 0.25, y: y + (big ? 2.25 : 1.6), w: cw - 0.5, h: big ? 1.1 : ch - 1.7, fontSize: big ? 16 : 14, color: ink2, align: 'center', valign: 'top', fontFace: FONT, fit: 'shrink' });
        });
        if (foot.length) highlight(sl, foot.join('；'), { y: 6.25 });
        pageNo(sl, n);
        break;
      }
      case 'compare': {
        titleBar(sl, s.title);
        const groups = [];
        for (const b of s.blocks) {
          if (b.type === 'heading') groups.push({ title: plain(b.inlines), blocks: [] });
          else if (groups.length) groups.at(-1).blocks.push(b);
        }
        // 两边卡片一样高：按要点多的那边定
        const rowsOf = (g) => textOf(g.blocks).flatMap((b) => b.items).reduce((a, it) => a + Math.ceil(plain(it.inlines).length / 22) + it.children.length, 0);
        const bodyH = Math.min(4.4, Math.max(1.4, 0.5 + Math.max(...groups.slice(0, 2).map(rowsOf)) * 0.62));
        groups.slice(0, 2).forEach((g, k) => {
          const x = 0.6 + k * ((W - 1.2) / 2 + 0.15);
          const w = (W - 1.2) / 2 - 0.15;
          const color = k ? gold : accent;
          const items = textOf(g.blocks).flatMap((b) => b.items);
          sl.addShape(box, { x, y: 1.6, w, h: bodyH + 0.75, ...card });
          sl.addShape(pptx.ShapeType.rect, { x, y: 1.6, w, h: 0.62, fill: { color }, line: { color } });
          sl.addText(g.title, { x, y: 1.6, w, h: 0.62, fontSize: 19, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT, fit: 'shrink' });
          if (items.length) sl.addText(bulletRuns(items, 18), { x: x + 0.25, y: 2.35, w: w - 0.5, h: bodyH - 0.05, fontSize: 18, color: ink, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.15, fit: 'shrink' });
        });
        pageNo(sl, n);
        break;
      }
      case 'chart': {
        titleBar(sl, s.title);
        const t = s.blocks.find((b) => b.type === 'table');
        const cols = chartColumns(t).slice(0, 3);
        const rows = t.rows.filter((r) => !TOTAL_ROW.test(plain(r[0] ?? []))); // 合计不画成柱子，不然别的柱子都被压扁
        const totals = t.rows.filter((r) => TOTAL_ROW.test(plain(r[0] ?? [])));
        const labels = rows.map((r) => plain(r[0] ?? []));
        const data = cols.map((c) => ({ name: plain(t.header[c]), labels, values: rows.map((r) => num(plain(r[c] ?? []))) }));
        // 没画进图的列（单位不同）和合计，写在右边说明里；占比的合计（100%）不写
        const other = numericColumns(t).filter((c) => !cols.includes(c));
        const isShare = (c) => /占比|比重|构成/.test(plain(t.header[c]));
        const note = [
          ...totals.map((r) => `${plain(r[0])}：${t.header.map((h, c) => (c && plain(r[c] ?? []) && !isShare(c) ? `${plain(h)} ${plain(r[c])}` : '')).filter(Boolean).join('，')}`),
          ...other.map((c) => `${plain(t.header[c])}：${rows.map((r) => `${plain(r[0])} ${plain(r[c] ?? [])}`).join('，')}`),
          ...s.blocks.filter((b) => b.type !== 'table').flatMap(blockLines).filter(Boolean)
        ].filter((x) => !/：$/.test(x));
        const chartW = note.length ? 8.2 : W - 1.2;
        // 图形按数据选：占比 / 构成 → 环形图；按时间排的（月、季度、年）→ 折线；其余柱状图。页内写“版式：饼图 / 折线图”也行
        const shareOnly = cols.length === 1 && /占比|比重|构成|份额/.test(plain(t.header[cols[0]])) && rows.length >= 2 && rows.length <= 6;
        const timed = rows.length >= 4 && labels.every((l) => PERIOD.test(l));
        const shape = s.wish === '饼图' || (shareOnly && s.wish !== '柱状图') ? 'doughnut' : s.wish === '折线图' || s.wish === '趋势' || (timed && s.wish !== '柱状图') ? 'line' : 'bar';
        const extra = shape === 'doughnut'
          ? { holeSize: 55, showPercent: true, showValue: false, showLegend: true, legendPos: 'r', dataLabelColor: 'FFFFFF', chartColors: [accent, C.primary, gold, mix2(accent, 'FFFFFF', 0.45), mix2(C.primary, 'FFFFFF', 0.45), ink2].map((c) => c.toUpperCase()) }
          : shape === 'line' ? { lineSize: 3, lineDataSymbol: 'circle', lineDataSymbolSize: 8, dataLabelPosition: 't' } : {};
        layouts[layouts.length - 1] = shape === 'bar' ? 'chart' : shape === 'line' ? 'chart-line' : 'chart-pie';
        sl.addChart(pptx.ChartType[shape], data, {
          x: 0.6, y: 1.5, w: chartW, h: 5.3, barDir: 'col', barGapWidthPct: 60,
          chartColors: (cols.length === 1 ? [accent] : [accent, gold, T.id === 'story' ? T.head : C.primary]).map((c) => c.toUpperCase()),
          showLegend: cols.length > 1, legendPos: 'b', legendFontFace: FONT, legendFontSize: 12, legendColor: ink,
          showValue: true, dataLabelFontSize: 11, dataLabelFontFace: FONT, dataLabelColor: ink,
          catAxisLabelFontFace: FONT, catAxisLabelFontSize: 12, catAxisLabelColor: ink, valAxisLabelFontSize: 11, valAxisLabelColor: ink2,
          valGridLine: { color: T.grid, size: 0.5 }, catAxisLineColor: T.grid,
          ...extra
        });
        const numericNotes = s.blocks.filter(b => b.type === 'list').flatMap(blockLines).filter(text => NUM_ITEM.test(text) && !DATE_ITEM.test(text) && text.length < 30);
        if (numericNotes.length >= 2 && numericNotes.length <= 4) {
          // 同页有真实统计图和关键数字时，数字仍排成卡片，不缩成侧栏小字。
          const cw = (W - 9.6 - 0.15) / 2;
          numericNotes.forEach((text, index) => {
            const m = NUM_ITEM.exec(text), x = 9.0 + index % 2 * (cw + 0.15), y = 1.7 + Math.floor(index / 2) * 1.65;
            sl.addShape(box, { x, y, w: cw, h: 1.5, ...card });
            sl.addText(m[1].trim(), { objectName: 'wy-stat-number', x, y: y + 0.2, w: cw, h: 0.6, fontSize: 28, bold: true, color: accent, align: 'center', fontFace: FONT });
            sl.addText(m[2].trim(), { x: x + 0.1, y: y + 0.9, w: cw - 0.2, h: 0.4, fontSize: 14, color: ink, align: 'center', fontFace: FONT });
          });
          const rest = note.filter(text => !numericNotes.includes(text));
          if (rest.length) sl.addText(rest.join('；'), { x: 9.0, y: 5.15, w: W - 9.6, h: 1.5, fontSize: 14, color: ink2, fontFace: FONT, valign: 'top', fit: 'shrink' });
        } else if (note.length) {
          const noteH = Math.min(4.9, 0.5 + note.reduce((a, x) => a + Math.ceil(x.length / 14), 0) * 0.42);
          sl.addShape(box, { x: 9.0, y: 1.7, w: W - 9.6, h: noteH, ...card });
          sl.addText(note.map((x) => ({ text: x, options: { bullet: { code: '25CF', indent: 18 }, breakLine: true, paraSpaceAfter: 10 } })), { x: 9.2, y: 1.85, w: W - 10.0, h: noteH - 0.3, fontSize: 15, color: ink, fontFace: FONT, valign: 'top', fit: 'shrink' });
        }
        pageNo(sl, n);
        break;
      }
      case 'table': {
        titleBar(sl, s.title);
        const t = s.blocks.find((b) => b.type === 'table');
        const fs = t.rows.length > 10 ? 12 : t.rows.length > 6 ? 14 : 16;
        const rowH = t.rows.length > 10 ? undefined : Math.min(t.rows.length <= 4 ? 1.1 : 0.75, 5.2 / (t.rows.length + 1)); // 行少时加高，不挤在页面顶上
        // 列宽按内容长短分，长文字的列宽一些
        const lens = t.header.map((h, ci) => Math.max(plain(h).length, ...t.rows.map((r) => plain(r[ci] ?? []).length)));
        const sum = lens.reduce((a, b) => a + Math.min(Math.max(b, 4), 40), 0);
        const colW = lens.map((l) => ((W - 1.2) * Math.min(Math.max(l, 4), 40)) / sum);
        const headRow = t.header.map((c) => ({ text: plain(c), options: { bold: true, color: T.onStrong, fill: { color: T.id === 'data' ? C.primary : dark }, align: 'center' } }));
        const body = t.rows.map((r, ri) => t.header.map((_, ci) => ({ text: plain(r[ci] ?? []), options: { fill: { color: ri % 2 ? T.soft : T.surface }, align: t.align[ci] ?? (num(plain(r[ci] ?? [])) !== null ? 'right' : 'left') } })));
        sl.addTable([headRow, ...body], { x: 0.6, y: 1.55, w: W - 1.2, fontSize: fs, fontFace: FONT, color: ink, border: { type: 'solid', pt: 0.75, color: T.border }, valign: 'middle', colW, ...(rowH && { rowH }), autoPage: true, autoPageRepeatHeader: true });
        pageNo(sl, n);
        break;
      }
      case 'imageText':
      case 'image': {
        titleBar(sl, s.title);
        if (kind === 'imageText') {
          const items = textOf(s.blocks.filter((b) => b.type !== 'image')).flatMap((b) => b.items);
          const size = fontFor(items.length, lines.join('').length) - 2;
          sl.addText(bulletRuns(items, size), { x: 0.6, y: 1.6, w: 6.1, h: 5.2, fontSize: size, color: ink, fontFace: FONT, valign: 'top', fit: 'shrink' });
        }
        pageNo(sl, n);
        break;
      }
      case 'cards':
      case 'steps': {
        titleBar(sl, s.title);
        const all = entriesOf(s.blocks);
        // “总体判断 / 结论 / 定位”这类总结句不做成卡片，放进底部的深色重点横条
        const isSummary = (it) => SUMMARY.test(labelOf(it).label);
        const main = all.filter((it) => LABEL.test(plain(it.inlines)) && !(isSummary(it) && kind === 'cards'));
        const foot = all.filter((it) => !main.includes(it)).map((it) => plain(it.inlines));
        if (kind === 'cards') {
          // 连续几页都是卡片：换着用不同的版式（参照用户给的样例：一排大圆、长条、左右分栏、卡片网格）
          const its = main.map(labelOf);
          const fits = {
            grid: true,
            circles: its.length >= 3 && its.length <= 5 && its.every((x) => [...x.label].length <= 4),
            rows: its.length <= 4,
            split: its.length >= 4 && its.length <= 5
          };
          const order = ['grid', 'circles', 'split', 'rows'];
          const prevVariant = cardVariants.at(-1);
          let variant = 'grid';
          if (prevVariant) {
            const start = order.indexOf(prevVariant) + 1;
            variant = [...order.slice(start), ...order.slice(0, start)].find((v) => fits[v] && v !== prevVariant) ?? 'grid';
          }
          if (variant === 'circles') circleRow(sl, its);
          else if (variant === 'rows') iconRows(sl, its, { bottom: foot.length ? 6.05 : 6.85 });
          else if (variant === 'split') splitPanel(sl, its, main);
          else cardGrid(sl, main, { bottom: foot.length ? 6.05 : 6.85 });
          cardVariants.push(variant);
        } else { const its = main.map(labelOf); chevrons(sl, its.map((x) => x.label), { descs: its.map((x) => x.text), bottom: foot.length ? 6.05 : 6.85 }); }
        if (foot.length) highlight(sl, foot.join('；'), { y: 6.25 });
        pageNo(sl, n);
        break;
      }
      case 'timeline': {
        // 时间线：日期写在箭头里，事项写在下面的卡片里；不带日期的一句话放进底部横条
        titleBar(sl, s.title);
        const all = entriesOf(s.blocks).map((it) => plain(it.inlines));
        const its = all.map((t) => DATE_ITEM.exec(t)).filter(Boolean).slice(0, 7);
        const foot = all.filter((t) => !DATE_ITEM.test(t));
        chevrons(sl, its.map((m) => m[1].replace(/\s+/g, '')), { y: 2.2, h: 1.0, descs: its.map((m) => m[2].trim()), descH: 2.3, descSize: its.length > 5 ? 17 : 19, nodeSize: 22, bottom: foot.length ? 6.05 : 6.85 });
        if (foot.length) highlight(sl, foot.join('；'), { y: 6.25 });
        pageNo(sl, n);
        break;
      }
      case 'progress': {
        // 进度条：左边名称，中间横条按百分比填色，右边数值；100% 用主色，没完成的用强调色，0 的标红
        titleBar(sl, s.title);
        const t = s.blocks.find((b) => b.type === 'table');
        let rows, foot = [];
        if (t) {
          const c = progressColumn(t);
          rows = t.rows.map((r) => ({ name: plain(r[0] ?? []), pct: num(plain(r[c] ?? [])), note: t.header.map((_, k) => (k && k !== c ? plain(r[k] ?? []) : '')).filter(Boolean).join(' ') }));
          foot = s.blocks.filter((b) => b.type !== 'table').flatMap(blockLines).filter(Boolean);
        } else {
          const all = entriesOf(s.blocks).map((it) => plain(it.inlines));
          rows = all.map((x) => PCT_ITEM.exec(x)).filter(Boolean).map((m) => ({ name: m[1].trim(), pct: Number(m[2]), note: m[3].replace(/^[（(，,\s]+|[）)\s]+$/g, '') }));
          foot = all.filter((x) => !PCT_ITEM.test(x));
        }
        rows = rows.slice(0, 8);
        const top = 1.65, bottom = foot.length ? 6.0 : 6.75;
        const rh = Math.min(0.85, (bottom - top) / rows.length);
        const red = 'C0392B';
        rows.forEach((r, k) => {
          const y = top + k * rh;
          const barX = 4.1, barW = W - barX - 2.0, barH = Math.min(0.32, rh * 0.42);
          const color = r.pct >= 100 ? dark : r.pct <= 0 ? red : accent;
          sl.addText(r.name, { x: 0.6, y, w: 3.3, h: r.note ? rh * 0.58 : rh, fontSize: 17, bold: true, color: head, fontFace: FONT, valign: r.note ? 'bottom' : 'middle', fit: 'shrink' });
          if (r.note) sl.addText(r.note, { x: 0.6, y: y + rh * 0.58, w: 3.3, h: rh * 0.38, fontSize: 12, color: ink2, fontFace: FONT, valign: 'top', fit: 'shrink' });
          sl.addShape(pptx.ShapeType.roundRect, { x: barX, y: y + (rh - barH) / 2, w: barW, h: barH, fill: { color: T.track }, line: { color: T.track }, rectRadius: barH / 2 });
          if (r.pct > 0) sl.addShape(pptx.ShapeType.roundRect, { x: barX, y: y + (rh - barH) / 2, w: Math.max(barH, (barW * Math.min(100, r.pct)) / 100), h: barH, fill: { color }, line: { color }, rectRadius: barH / 2 });
          sl.addText(`${r.pct}%`, { x: barX + barW + 0.15, y, w: 1.25, h: rh, fontSize: 20, bold: true, color: r.pct <= 0 ? red : dark, fontFace: FONT, align: 'right', valign: 'middle' });
        });
        if (foot.length) highlight(sl, foot.join('；'), { y: 6.25 });
        pageNo(sl, n);
        break;
      }
      case 'flow': {
        titleBar(sl, s.title);
        const all = s.blocks.filter((b) => b.type === 'list' || b.type === 'paragraph').flatMap((b) => (b.type === 'list' ? b.items : [{ inlines: b.inlines, children: [] }]));
        const chainIt = all.find((it) => isChain(plain(it.inlines)));
        const { label, text } = labelOf(chainIt);
        const nodes = (label && isChain(text) ? text : plain(chainIt.inlines)).split(ARROW).map((x) => x.trim()).filter(Boolean);
        if (label && isChain(text)) sl.addText(label, { x: 0.6, y: 1.35, w: W - 1.2, h: 0.4, fontSize: 16, bold: true, color: head, fontFace: FONT });
        chevrons(sl, nodes, { y: 1.85 });
        const rest = all.filter((it) => it !== chainIt);
        if (rest.length >= 3 && rest.length <= 6 && rest.every((it) => LABEL.test(plain(it.inlines)))) cardGrid(sl, rest, { top: 3.1 });
        else if (rest.length) {
          const size = Math.min(22, fontFor(rest.length, rest.map((it) => plain(it.inlines)).join('').length));
          sl.addShape(box, { x: 0.6, y: 3.1, w: W - 1.2, h: 3.75, ...card });
          sl.addText(bulletRuns(rest, size), { x: 0.9, y: 3.3, w: W - 1.8, h: 3.35, fontSize: size, color: ink, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.15, fit: 'shrink' });
        }
        pageNo(sl, n);
        break;
      }
      case 'relation': {
        // 关系图：中心一个圆（不带标签的那句话，或页标题），周围是各方，用线连起来
        titleBar(sl, s.title);
        const all = entriesOf(s.blocks);
        const nodes = all.filter((it) => LABEL.test(plain(it.inlines))).map(labelOf).slice(0, 6);
        const hub = all.find((it) => !LABEL.test(plain(it.inlines)));
        const hubText = hub ? plain(hub.inlines) : String(s.title).replace(/[:：，,].*$/, '').slice(0, 12);
        const cx = W / 2, cy = 4.15, rx = 4.3, ry = 1.95, hubD = 2.0, nw = 3.3, nh = 1.15;
        const spots = nodes.map((_, k) => { const a = -Math.PI / 2 + (k * 2 * Math.PI) / nodes.length; return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }; });
        spots.forEach((p) => sl.addShape(pptx.ShapeType.line, { x: Math.min(cx, p.x), y: Math.min(cy, p.y), w: Math.abs(p.x - cx), h: Math.abs(p.y - cy), flipH: (p.x < cx) !== (p.y < cy), line: { color: T.id === 'story' ? gold : T.border, width: 1.25, dashType: T.id === 'story' ? 'dash' : 'solid' } }));
        sl.addShape(pptx.ShapeType.ellipse, { x: cx - hubD / 2, y: cy - hubD / 2, w: hubD, h: hubD, fill: { color: dark }, line: { color: T.id === 'story' ? gold : dark, width: 1.5 } });
        sl.addText(hubText, { x: cx - hubD / 2 + 0.15, y: cy - hubD / 2 + 0.15, w: hubD - 0.3, h: hubD - 0.3, fontSize: 18, bold: true, color: T.onStrong, fontFace: HFONT, align: 'center', valign: 'middle', fit: 'shrink' });
        nodes.forEach((nd, k) => {
          const p = spots[k];
          const x = Math.max(0.5, Math.min(W - 0.5 - nw, p.x - nw / 2)), y = Math.max(1.5, Math.min(H - 0.65 - nh, p.y - nh / 2));
          sl.addShape(box, { x, y, w: nw, h: nh, ...card });
          sl.addText(nd.label, { x: x + 0.15, y: y + 0.08, w: nw - 0.3, h: 0.42, fontSize: 16, bold: true, color: T.id === 'story' ? gold : accent, fontFace: HFONT, valign: 'middle', fit: 'shrink' });
          sl.addText(nd.text, { x: x + 0.15, y: y + 0.5, w: nw - 0.3, h: nh - 0.58, fontSize: 12, color: ink2, fontFace: FONT, valign: 'top', fit: 'shrink' });
        });
        pageNo(sl, n);
        break;
      }
      default: {
        titleBar(sl, s.title || title);
        // 重点句页：两句话写在相邻两行也拆成两条（第二条带标签时放进深色横条）
        const items = kind === 'statement' ? entriesOf(s.blocks) : textOf(s.blocks.filter((b) => b.type === 'list' || b.type === 'paragraph')).flatMap((b) => b.items);
        const extra = s.blocks.filter((b) => !['list', 'paragraph'].includes(b.type)).flatMap(blockLines).filter(Boolean);
        for (const t of extra) items.push({ inlines: [{ text: t }], children: [] });
        const short = items.length >= 2 && items.length <= 4 && items.every((it) => !it.children.some((c) => c.type === 'list') && plain(it.inlines).length <= 46);
        if (kind === 'statement' && items.length >= 2 && !LABEL.test(plain(items[0].inlines)) && items.slice(1).every((it) => LABEL.test(plain(it.inlines)))) {
          // 一句话 + 一两条“标签：说明”：上面大字，下面深色横条
          const bars = items.slice(1, 3);
          const boxH = 4.95 - 1.75 - (bars.length - 1) * 0.85;
          sl.addShape(box, { x: 0.6, y: 1.75, w: W - 1.2, h: boxH, fill: { color: T.soft }, line: { color: T.id === 'story' ? T.border : T.soft }, rectRadius: 0.06 });
          sl.addShape(pptx.ShapeType.rect, { x: 1.1, y: 2.15, w: 1.0, h: 0.07, fill: { color: gold }, line: { color: gold } });
          sl.addText(bulletRuns(items.slice(0, 1), 28).map((r) => ({ ...r, options: { ...r.options, bullet: false } })), { x: 1.1, y: 2.4, w: W - 2.2, h: boxH - 0.9, fontSize: 28, color: head, fontFace: FONT, valign: 'middle', lineSpacingMultiple: 1.2, fit: 'shrink' });
          bars.forEach((it, k) => highlight(sl, plain(it.inlines), { y: 1.75 + boxH + 0.3 + k * 0.85, h: 0.72 }));
        } else if (kind === 'statement') {
          const said = bulletRuns(items, 30).map((r) => ({ ...r, options: { ...r.options, bullet: false, paraSpaceBefore: 18 } }));
          if (T.id === 'story' || T.id === 'minimal') {
            // 叙事、留白：不要底板，居中大字，上下各一道细线（像书里的题记）
            const c = T.id === 'story' ? gold : accent;
            sl.addShape(pptx.ShapeType.line, { x: W / 2 - 1.2, y: 2.05, w: 2.4, h: 0, line: { color: c, width: 1 } });
            sl.addText(said, { x: 1.5, y: 2.3, w: W - 3.0, h: 2.9, fontSize: 30, color: head, fontFace: HFONT, align: 'center', valign: 'middle', lineSpacingMultiple: 1.3, fit: 'shrink' });
            sl.addShape(pptx.ShapeType.line, { x: W / 2 - 1.2, y: 5.45, w: 2.4, h: 0, line: { color: c, width: 1 } });
          } else {
            // 只有一两句话：浅色底板上的大字，当作重点陈述页
            sl.addShape(box, { x: 1.2, y: 2.0, w: W - 2.4, h: 3.4, fill: { color: T.soft }, line: { color: T.soft }, rectRadius: 0.06 });
            sl.addShape(pptx.ShapeType.rect, { x: 1.7, y: 2.45, w: 1.0, h: 0.07, fill: { color: gold }, line: { color: gold } });
            sl.addText(said, { x: 1.7, y: 2.7, w: W - 3.4, h: 2.4, fontSize: 30, color: head, fontFace: HFONT, valign: 'middle', fit: 'shrink' });
          }
        } else if (short || (T.id !== 'business' && items.length >= 2 && items.length <= 6 && items.every((it) => !it.children.some((c) => c.type === 'list') && plain(it.inlines).length <= 70))) {
          // 要点少而短：按风格换构图（见 listPage），连续几页轮换
          listPage(sl, items, listRun++, n);
        } else if (items.length) {
          const size = fontFor(items.length, lines.join('').length);
          sl.addShape(box, { x: 0.6, y: 1.5, w: W - 1.2, h: 5.35, ...card });
          sl.addText(bulletRuns(items, size), { x: 0.95, y: 1.7, w: W - 1.9, h: 4.95, fontSize: size, color: ink, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.15, fit: 'shrink' });
        }
        pageNo(sl, n);
      }
    }
    restoreImageSpace();
    if (summary) {
      sl.addText(summary.title, { x: 10.05, y: 1.65, w: 2.65, h: 0.5, fontSize: 15, bold: true, color: head, fontFace: FONT });
      sl.addChart(pptx.ChartType.bar, [{ name: '条数', labels: summary.labels, values: summary.values }], { x: 10.05, y: 2.25, w: 2.65, h: 3.6, catAxisLabelFontSize: 12, valAxisLabelFontSize: 12, showValue: true, showLegend: false, chartColors: [accent], showTitle: false });
      sl.addText(`由本页${summary.total}条记录汇总`, { objectName: 'wy-caption', x: 10.05, y: 6.1, w: 2.65, h: 0.5, fontSize: 12, color: muted, fontFace: FONT });
    }
    if (['table', 'imageText', 'image'].includes(kind)) iconCircle(sl, W - 0.9, 0.35, 0.4, iconPicker(preferredIcons)(s.title), accent);
    await placeSlideImages(sl, images, kind, { load: imageData, missingImages });
    if (s.notes.length) sl.addNotes(s.notes.join('\n'));
  }
  const blob = await pptx.write({ outputType: 'blob' });
  const preview = records.map(({ n, title: t, items, slide }) => ({ n, title: t, items, background: slide.background?.color }));
  return { blob, info: { slides: records.length, expectedSlides, layouts, coverMetadata: { subtitle, author, date: date || today() }, editableContent: presentationMarkdown(slides, { title, cover: budget.cover, coverImages, agenda: !budget.strict && sections.length >= 2 ? sections.map(s => s.title) : [] }), missingImages, preview, layoutIssues: [...layoutIssues(preview), ...monotony(pages, MONOTONY_RUN[T.id] ?? 3), ...ignored, ...localVisualIssues], style: T.id } };
}

/**
 * 连续 3 页以上都是普通要点列表：看着单调，提醒换版式（交给模型改一轮）。
 * 其他风格的要点页会轮换构图（见 listPage），连着 4 页才提醒；叙事风格的情节本来就是一件件往下讲，连着 6 页才提醒
 */
const MONOTONY_RUN = { business: 3, minimal: 4, data: 4, story: 6 };
export function monotony(pages, run = 3) {
  const out = [];
  for (let i = 0; i < pages.length;) {
    let j = i;
    while (j < pages.length && pages[j].kind === 'bullets') j++;
    if (j - i >= run) out.push({ level: 'warn', slide: pages[i].n, text: `第 ${pages[i].n}–${pages[j - 1].n} 页连续 ${j - i} 页都是普通要点列表，看着单调。把其中能对上的页改写：并列的几件事写成“标签：说明”（卡片），带数字的写成数字开头（大数字），有先后的写成日期开头或“A→B→C”，一两句的重点单独成页；也可以在页内加一行“版式：卡片 / 大数字 / 时间线 / 重点句”` });
    i = Math.max(j, i + 1);
  }
  return out;
}

function today() {
  const d = new Date(Date.now() + 8 * 3600_000);
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}

