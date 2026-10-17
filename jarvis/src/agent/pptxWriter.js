/**
 * Markdown → PPT（.pptx），用 PptxGenJS（MIT）。16:9，配色用主题（themes.js）。
 *
 * 写法：“# 标题”或“## 标题”开始一页，也可以用 --- 分页；页内的列表、段落、表格、图片决定版式。
 * 版式按内容自动选：
 *   cover     封面：文档标题、副标题、日期（深色底）
 *   section   章节页：只有标题（或标题 + 一句话），或标题像“第二部分 …”
 *   stats     大数字：2–4 条要点，每条以数字开头（如“1,236 万元 销售额”）
 *   bullets   要点：列表 / 段落；超过 7 条自动拆成两页（续）
 *   imageText 左文右图：有图片也有文字
 *   image     大图：只有图片
 *   compare   对比：页内有两个 ### 小标题，左右两栏
 *   chart     数据：表格里有数字列 → 柱状图（数据少于等于 8 行）
 *   table     表格：其他表格
 *   end       结尾：标题是“谢谢 / 感谢 / Q&A / 结束”
 * 以“备注：”开头的段落放进演讲者备注，不上屏。
 */
import { parseDoc, plain } from './docModel.js';
import { imageInfo } from './imageInfo.js';
import { recordSlide, layoutIssues, fitText } from './slidePreview.js';

const W = 13.333;
const H = 7.5;
const FONT = '微软雅黑';
const NUM_ITEM = /^(?:\*\*)?([-+]?[\d,.]+\s*(?:%|万亿元|亿元|万元|千元|万亿|亿|万|千|元|个|家|人次|人|倍|天|小时|分钟|项|台|套|次)?)(?:\*\*)?(?:\s*[：:]\s*|\s+)(.+)$/;
const END = /^(谢谢|感谢|谢谢观看|感谢聆听|thanks|thank you|q\s*&\s*a|结束)/i;
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
/** 合计行：不进柱状图 */
const TOTAL_ROW = /^(合计|总计|小计|总额|共计|total)/i;
/** 单位：同一张图里单位不同的数据列不能放在一起比 */
const UNIT = /(万元|亿元|千元|元|人天|人月|人|天|小时|%|个|台|套|次|项|家|km|公里|吨)/;

/** 按文字意思配图标（图标见 pptIcons.js）；同一页尽量不重复 */
const ICON_RULES = [
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
export function iconPicker() {
  const used = new Set();
  return (text) => {
    const t = String(text ?? '');
    const hit = ICON_RULES.find(([re, name]) => re.test(t) && !used.has(name))?.[1]
      ?? ICON_FALLBACK.find((name) => !used.has(name)) ?? 'sparkles';
    used.add(hit);
    return hit;
  };
}

/** 按页拆开，每页保留原始块，供选版式 */
export function parseSlides(title, md) {
  const blocks = parseDoc(md);
  const slides = [];
  let cur = null;
  const start = (t) => { cur = { title: t, blocks: [], notes: [] }; slides.push(cur); };
  for (const b of blocks) {
    if (b.type === 'heading' && b.level <= 2) { start(plain(b.inlines)); continue; }
    if (b.type === 'hr') { cur = null; continue; }
    if (!cur) start(slides.length ? '' : title);
    if (b.type === 'paragraph' && /^备注[:：]/.test(plain(b.inlines))) { cur.notes.push(plain(b.inlines).replace(/^备注[:：]\s*/, '')); continue; }
    cur.blocks.push(b);
  }
  return slides;
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

/** 选版式 */
export function layoutOf(slide, { first = false, last = false } = {}) {
  const bs = slide.blocks;
  const has = (t) => bs.some((b) => b.type === t);
  const lines = bs.flatMap(blockLines).filter(Boolean);
  if (first && !bs.length) return 'cover';
  if (END.test(slide.title.trim()) && (last || lines.length <= 2)) return 'end';
  if (!bs.length || (SECTION.test(slide.title) && lines.length <= 1)) return 'section';
  const table = bs.find((b) => b.type === 'table');
  if (table) return chartColumns(table).length && table.rows.filter((r) => !TOTAL_ROW.test(plain(r[0] ?? []))).length <= 8 ? 'chart' : 'table';
  const imgs = bs.filter((b) => b.type === 'image');
  if (imgs.length) return lines.length ? 'imageText' : 'image';
  if (bs.filter((b) => b.type === 'heading' && b.level >= 3).length === 2) return 'compare';
  const items = bs.filter((b) => b.type === 'list').flatMap((b) => b.items.map((it) => plain(it.inlines)));
  if (items.length >= 2 && items.length <= 6 && items.length === lines.length && items.every((t) => NUM_ITEM.test(t))) return 'stats';
  if (lines.some(isChain)) return 'flow';
  // 3–6 条“标签：说明”（允许再带一句不带标签的总结，放到页脚）
  const labeled = items.filter((t) => LABEL.test(t)).length;
  if (labeled >= 3 && labeled <= 6 && items.length - labeled <= 1 && items.length === lines.length) {
    return STEP_TITLE.test(slide.title) && labeled >= 4 ? 'steps' : 'cards';
  }
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
export async function makePptx({ title, content, theme, subtitle = '', author = '', date = '', loadImage = null }) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  pptx.author = '未央';
  const C = theme.colors;
  const dark = C.primary;
  const light = theme.official ? 'FFFFFF' : 'F7F9FC';
  const muted = '8A94A6';
  const missingImages = [];
  const layouts = [];
  // 每页放了什么都记下来：生成后估算字放不放得下、画预览图给模型看（slidePreview.js）
  const records = [];
  const addSlide = (title) => { const r = recordSlide(pptx.addSlide()); records.push({ n: records.length + 1, title, items: r.items, slide: r.slide }); return r.slide; };

  let slides = parseSlides(title, content);
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
  // 超过 7 条要点拆页
  const expanded = [];
  for (const s of slides) {
    const items = s.blocks.length === 1 && s.blocks[0].type === 'list' ? s.blocks[0].items : null;
    if (items && items.length > 7) {
      for (let i = 0; i < items.length; i += 6) expanded.push({ ...s, title: i ? `${s.title}（续）` : s.title, blocks: [{ ...s.blocks[0], items: items.slice(i, i + 6) }], notes: i ? [] : s.notes });
    } else expanded.push(s);
  }
  slides = expanded;

  const imageData = async (src) => {
    try {
      const bytes = loadImage ? await loadImage(src) : null;
      const info = bytes && imageInfo(bytes);
      if (!info) { missingImages.push(src); return null; }
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { data: `image/${info.type === 'jpg' ? 'jpeg' : info.type};base64,${btoa(bin)}`, ratio: info.width / info.height };
    } catch { missingImages.push(src); return null; }
  };

  // ---------- 版式零件（白底、左上标题、右上章节标签、底部页脚；白色卡片带淡阴影和圆形图标）
  const { ICON_PNG } = await import('./pptIcons.js');
  const gold = theme.official ? 'C00000' : C.extra; // 点缀色：重点关键词、封面短横线
  const ink2 = '5B6577'; // 说明文字的灰
  const card = { fill: { color: 'FFFFFF' }, line: { color: 'E3E8F0', width: 0.75 }, rectRadius: 0.06, shadow: { type: 'outer', color: '1F2D3D', opacity: 0.1, blur: 6, offset: 2, angle: 90 } };
  const circleColors = theme.official ? [dark] : [C.accent, dark, C.extra];
  const footTitle = String(title).slice(0, 40);
  let sectionNo = 0;
  let sectionTag = ''; // 右上角：当前在第几部分
  const iconCircle = (sl, x, y, d, name, color) => {
    sl.addShape(pptx.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color }, line: { color } });
    const png = ICON_PNG[name];
    if (png) sl.addImage({ data: `image/png;base64,${png}`, x: x + d * 0.25, y: y + d * 0.25, w: d * 0.5, h: d * 0.5 });
  };
  const titleBar = (sl, text) => {
    sl.background = { color: light };
    sl.addText(text, { x: 0.6, y: 0.38, w: W - (sectionTag ? 3.9 : 1.2), h: 0.8, fontSize: 24, bold: true, color: dark, fontFace: FONT, valign: 'middle', fit: 'shrink' });
    if (sectionTag) sl.addText(sectionTag, { x: W - 3.1, y: 0.55, w: 2.5, h: 0.45, fontSize: 10, color: C.accent, fontFace: FONT, align: 'right', valign: 'middle' });
  };
  const pageNo = (sl, n) => {
    sl.addText(footTitle, { x: 0.6, y: H - 0.42, w: 8, h: 0.28, fontSize: 8, color: muted, fontFace: FONT, valign: 'middle' });
    sl.addText(String(n), { x: W - 1.1, y: H - 0.42, w: 0.5, h: 0.28, fontSize: 9, color: muted, align: 'right', fontFace: FONT, valign: 'middle' });
  };
  /** 深色重点横条：“标签：内容”的标签用点缀色 */
  const highlight = (sl, text, { x = 0.6, y, w = W - 1.2, h = 0.62 } = {}) => {
    sl.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: dark }, line: { color: dark }, rectRadius: 0.05 });
    const m = LABEL.exec(text);
    const runs = m ? [{ text: `${m[1].trim()}　`, options: { bold: true, color: gold } }, { text: m[2].trim(), options: { color: 'FFFFFF' } }] : [{ text, options: { color: 'FFFFFF' } }];
    sl.addText(runs, { x: x + 0.3, y, w: w - 0.6, h, fontSize: 15, fontFace: FONT, valign: 'middle', fit: 'shrink' });
  };
  /** 右侧装饰：几个半透明的圆（不放图片时代替主图） */
  const ornament = (sl, x0, onDark = false) => {
    const ring = (x, y, d, color, t) => sl.addShape(pptx.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color, transparency: t }, line: { color, transparency: t } });
    ring(x0 + 1.2, 0.9, 4.4, onDark ? 'FFFFFF' : C.accent, onDark ? 92 : 78);
    ring(x0 + 3.0, 3.5, 3.2, onDark ? C.accent : gold, onDark ? 60 : 72);
    ring(x0 + 0.5, 4.4, 2.0, onDark ? 'FFFFFF' : dark, onDark ? 94 : 85);
  };
  const bulletRuns = (items, size) => items.flatMap((it, i) => {
    const run = (s) => ({ text: s.text, options: { bold: s.bold, italic: s.italic, color: s.link ? '0563C1' : undefined } });
    let head = it.inlines.map(run);
    // “标签：说明”的标签加粗，一眼能扫到重点
    const m = !it.inlines.some((x) => x.bold) && LABEL.exec(plain(it.inlines));
    if (m) head = [{ text: `${m[1]}：`, options: { bold: true, color: dark } }, { text: m[2], options: {} }];
    head[0] = { ...head[0], options: { ...head[0]?.options, bullet: { code: '25CF', indent: 22 }, paraSpaceBefore: i ? Math.round(size * 0.6) : 0 } };
    head[head.length - 1].options.breakLine = true;
    const subs = it.children.filter((c) => c.type === 'list').flatMap((c) => c.items.map((sub) => ({ text: plain(sub.inlines), options: { bullet: { indent: 22 }, indentLevel: 1, fontSize: size - 4, color: ink2, breakLine: true } })));
    return [...head, ...subs];
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
    const cols = n === 4 ? 2 : Math.min(3, n);
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
    const pick = iconPicker();
    const parsed = items.map(labelOf);
    // 同一页的卡片说明用同一个字号（取放得下的最小值），不要一张大一张小
    const descSize = Math.min(...parsed.map(({ text }) => {
      const guess = Math.max(13, Math.min(18, Math.floor(Math.sqrt(((w - 0.56) * descH * 5200) / Math.max(20, text.length * 1.3)))));
      return fitText(text, { w: w - 0.56, h: descH, fontSize: guess, lineSpacingMultiple: 1.3 }).o.fontSize;
    }));
    parsed.forEach(({ label, text }, k) => {
      const x = left + (k % cols) * (w + gap);
      const y = top + Math.floor(k / cols) * (h + gap);
      sl.addShape(pptx.ShapeType.roundRect, { x, y, w, h, ...card });
      iconCircle(sl, x + 0.28, y + 0.28, d, pick(`${label} ${text}`), circleColors[k % circleColors.length]);
      if (inline) sl.addText(label || text, { x: x + 0.28 + d + 0.18, y: y + 0.28, w: w - d - 0.74, h: d, fontSize: 18, bold: true, color: dark, fontFace: FONT, valign: 'middle', fit: 'shrink' });
      else sl.addText(label || text, { x: x + 0.28, y: y + 1.04, w: w - 0.56, h: 0.5, fontSize: 19, bold: true, color: dark, fontFace: FONT, valign: 'middle', fit: 'shrink' });
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
      const color = k % 2 ? C.accent : dark;
      sl.addShape(pptx.ShapeType.ellipse, { x: cx - d / 2, y: 1.75, w: d, h: d, fill: { color }, line: { color: 'FFFFFF', width: 3 }, shadow: card.shadow });
      sl.addText(label, { x: cx - d / 2, y: 1.75, w: d, h: d, fontSize: 22, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT, fit: 'shrink' });
      sl.addText(text, { x: cx - slot / 2 + 0.2, y: 1.75 + d + 0.35, w: slot - 0.4, h: descH, fontSize: descSize, color: ink2, align: 'center', valign: 'top', lineSpacingMultiple: 1.3, fontFace: FONT, fit: 'shrink' });
    });
  };
  /** 一行一条：白色长条卡片，左边图标，标签和说明排在一行（条目少时用） */
  const iconRows = (sl, items, { top = 1.6, bottom = 6.85 } = {}) => {
    const gap = 0.25;
    const h = Math.min(1.25, (bottom - top - gap * (items.length - 1)) / items.length);
    const pick = iconPicker();
    items.forEach(({ label, text }, k) => {
      const y = top + k * (h + gap);
      sl.addShape(pptx.ShapeType.roundRect, { x: 0.6, y, w: W - 1.2, h, ...card });
      iconCircle(sl, 0.9, y + h / 2 - 0.3, 0.6, pick(`${label} ${text}`), circleColors[k % circleColors.length]);
      sl.addText(label, { x: 1.75, y, w: 2.4, h, fontSize: 19, bold: true, color: dark, fontFace: FONT, valign: 'middle', fit: 'shrink' });
      sl.addShape(pptx.ShapeType.line, { x: 4.25, y: y + 0.25, w: 0, h: h - 0.5, line: { color: 'E3E8F0', width: 1 } });
      sl.addText(text, { x: 4.45, y, w: W - 5.35, h, fontSize: 17, color: ink2, fontFace: FONT, valign: 'middle', lineSpacingMultiple: 1.2, fit: 'shrink' });
    });
  };
  /** 左右分栏：左边深色块放第一条（最重要的一条），右边卡片放其余（条目多时用） */
  const splitPanel = (sl, items, raw) => {
    const [first, ...rest] = items;
    const pw2 = 4.3;
    sl.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 1.55, w: pw2, h: 5.3, fill: { color: dark }, line: { color: dark }, rectRadius: 0.06 });
    iconCircle(sl, 0.95, 1.9, 0.62, iconPicker()(`${first.label} ${first.text}`), C.accent);
    sl.addText(first.label, { x: 0.95, y: 2.75, w: pw2 - 0.7, h: 0.6, fontSize: 20, bold: true, color: gold, fontFace: FONT, valign: 'middle', fit: 'shrink' });
    sl.addText(first.text, { x: 0.95, y: 3.45, w: pw2 - 0.7, h: 3.1, fontSize: 20, color: 'FFFFFF', fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.35, fit: 'shrink' });
    cardGrid(sl, raw.slice(1), { left: 0.6 + pw2 + 0.3, width: W - 1.2 - pw2 - 0.3 });
    return rest;
  };

  /** 一排箭头：流程链或步骤；步骤的说明放在箭头下面的卡片里 */
  const chevrons = (sl, nodes, { y = 1.75, h = 0.85, descs = null } = {}) => {
    const n = Math.min(nodes.length, 7);
    const w = (W - 1.2) / n;
    nodes.slice(0, n).forEach((t, k) => {
      const x = 0.6 + k * w;
      const color = k % 2 ? dark : C.accent;
      sl.addShape(k ? pptx.ShapeType.chevron : pptx.ShapeType.homePlate, { x, y, w: w + 0.12, h, fill: { color }, line: { color: 'FFFFFF', width: 1 } });
      sl.addText(t, { x: x + (k ? 0.3 : 0.1), y, w: w - 0.35, h, fontSize: n > 5 ? 13 : 15, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT, fit: 'shrink' });
      if (descs?.[k]) {
        const cy = y + h + 0.3;
        sl.addShape(pptx.ShapeType.roundRect, { x: x + 0.05, y: cy, w: w - 0.1, h: 6.85 - cy, ...card });
        sl.addText(descs[k], { x: x + 0.2, y: cy + 0.15, w: w - 0.4, h: 6.85 - cy - 0.3, fontSize: n > 5 ? 14 : 16, color: ink2, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.25, fit: 'shrink' });
      }
    });
  };

  // ---------- 封面：左边深色块放文字，右边装饰
  const cover = addSlide(title);
  cover.background = { color: theme.official ? 'FFFFFF' : C.soft };
  const pw = 7.4;
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: pw, h: H, fill: { color: dark }, line: { color: dark } });
  ornament(cover, pw);
  // 单位 / 署名里已经带了日期就不再重复写日期
  const coverDate = /\d{4}\s*年|\d{4}[-./]\d{1,2}/.test(author) ? '' : (date || today());
  if (author) cover.addText(author, { x: 0.8, y: 0.9, w: pw - 1.4, h: 0.4, fontSize: 12, color: gold, fontFace: FONT });
  cover.addText(title, { x: 0.8, y: 1.6, w: pw - 1.4, h: 2.1, fontSize: 36, bold: true, color: 'FFFFFF', fontFace: FONT, valign: 'bottom', fit: 'shrink' });
  cover.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.9, w: 1.0, h: 0.06, fill: { color: gold }, line: { color: gold } });
  if (subtitle) cover.addText(subtitle, { x: 0.8, y: 4.1, w: pw - 1.4, h: 1.0, fontSize: 16, color: C.soft, fontFace: FONT, valign: 'top', fit: 'shrink' });
  if (coverDate) cover.addText(coverDate, { x: 0.8, y: H - 1.1, w: pw - 1.4, h: 0.4, fontSize: 12, color: C.soft, fontFace: FONT });
  layouts.push('cover');

  // ---------- 汇报提纲：有两个以上“第 X 部分”时自动加
  const kinds = slides.map((s, i) => layoutOf(s, { last: i === slides.length - 1 }));
  const sections = slides.filter((s, i) => kinds[i] === 'section');
  const shortTitle = (t) => String(t).replace(SECTION, '').replace(/^[\s:：、.，,]+/, '').trim() || String(t);
  if (sections.length >= 2) {
    const sl = addSlide('汇报提纲');
    titleBar(sl, '汇报提纲');
    const n = Math.min(sections.length, 6);
    const gap = 0.25;
    const h = Math.min(1.1, (5.3 - gap * (n - 1)) / n);
    const top = 1.6 + (5.3 - (n * h + (n - 1) * gap)) / 2;
    sections.slice(0, n).forEach((s, k) => {
      const y = top + k * (h + gap);
      sl.addShape(pptx.ShapeType.roundRect, { x: 0.6, y, w: W - 1.2, h, ...card });
      sl.addText(String(k + 1).padStart(2, '0'), { x: 0.9, y, w: 1.0, h, fontSize: 28, bold: true, color: C.accent, fontFace: FONT, valign: 'middle' });
      sl.addText(shortTitle(s.title), { x: 2.0, y, w: W - 3.0, h, fontSize: 20, bold: true, color: dark, fontFace: FONT, valign: 'middle', fit: 'shrink' });
    });
    pageNo(sl, records.length);
    layouts.push('agenda');
  }

  // ---------- 各页
  const cardVariants = []; // 连续卡片页各用了哪种版式；中间隔了别的版式就重新开始
  for (const [i, s] of slides.entries()) {
    const kind = kinds[i];
    if (kind !== 'cards') cardVariants.length = 0;
    layouts.push(kind);
    const sl = addSlide(s.title);
    const n = records.length;
    const lines = s.blocks.flatMap(blockLines).filter(Boolean);
    switch (kind) {
      case 'section': {
        sectionNo++;
        sectionTag = `${String(sectionNo).padStart(2, '0')} ${shortTitle(s.title)}`.slice(0, 24);
        sl.background = { color: dark };
        ornament(sl, pw, true);
        sl.addText(String(sectionNo).padStart(2, '0'), { x: 0.8, y: 1.7, w: 3, h: 1.1, fontSize: 60, bold: true, color: gold, fontFace: FONT, valign: 'bottom' });
        sl.addText(shortTitle(s.title), { x: 0.8, y: 2.9, w: pw, h: 1.3, fontSize: 36, bold: true, color: 'FFFFFF', fontFace: FONT, valign: 'top', fit: 'shrink' });
        if (lines.length) sl.addText(lines.join('　'), { x: 0.8, y: 4.3, w: pw, h: 0.8, fontSize: 16, color: C.soft, fontFace: FONT, valign: 'top', fit: 'shrink' });
        break;
      }
      case 'end': {
        sl.background = { color: theme.official ? 'FFFFFF' : C.soft };
        sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: pw, h: H, fill: { color: dark }, line: { color: dark } });
        ornament(sl, pw);
        if (lines.length) {
          sl.addText(lines.join('\n'), { x: 0.8, y: 1.8, w: pw - 1.4, h: 2.0, fontSize: 28, bold: true, color: 'FFFFFF', fontFace: FONT, valign: 'bottom', fit: 'shrink' });
          sl.addText(s.title || '谢谢', { x: 0.8, y: 4.3, w: pw - 1.4, h: 0.8, fontSize: 28, bold: true, color: gold, fontFace: FONT });
        } else {
          sl.addText(s.title || '谢谢', { x: 0.8, y: 2.3, w: pw - 1.4, h: 1.5, fontSize: 48, bold: true, color: 'FFFFFF', fontFace: FONT, valign: 'bottom', fit: 'shrink' });
          sl.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.95, w: 1.0, h: 0.06, fill: { color: gold }, line: { color: gold } });
        }
        break;
      }
      case 'stats': {
        titleBar(sl, s.title);
        const items = s.blocks.find((b) => b.type === 'list').items.map((it) => plain(it.inlines).match(NUM_ITEM));
        // 4 个以内一行；5、6 个排两行（3 + 2 / 3 + 3）
        const gap = 0.3;
        const cols = items.length <= 4 ? items.length : 3;
        const rows = Math.ceil(items.length / cols);
        const cw = (W - 1.2 - gap * (cols - 1)) / cols;
        const ch = rows === 1 ? 3.6 : 2.45;
        const top = rows === 1 ? 1.9 : 1.55;
        const pick = iconPicker();
        items.forEach((m, k) => {
          const x = 0.6 + (k % cols) * (cw + gap);
          const y = top + Math.floor(k / cols) * (ch + gap);
          const big = rows === 1;
          sl.addShape(pptx.ShapeType.roundRect, { x, y, w: cw, h: ch, ...card });
          iconCircle(sl, x + cw / 2 - (big ? 0.33 : 0.27), y + (big ? 0.35 : 0.22), big ? 0.66 : 0.54, pick(m[2]), circleColors[k % circleColors.length]);
          sl.addText(m[1].trim(), { x, y: y + (big ? 1.15 : 0.82), w: cw, h: big ? 1.0 : 0.75, fontSize: big ? 40 : 32, bold: true, color: C.accent, align: 'center', valign: 'middle', fontFace: FONT, fit: 'shrink' });
          sl.addText(m[2].trim(), { x: x + 0.25, y: y + (big ? 2.25 : 1.6), w: cw - 0.5, h: big ? 1.1 : 0.7, fontSize: big ? 16 : 14, color: ink2, align: 'center', valign: 'top', fontFace: FONT, fit: 'shrink' });
        });
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
          const color = k ? gold : C.accent;
          const items = textOf(g.blocks).flatMap((b) => b.items);
          sl.addShape(pptx.ShapeType.roundRect, { x, y: 1.6, w, h: bodyH + 0.75, ...card });
          sl.addShape(pptx.ShapeType.rect, { x, y: 1.6, w, h: 0.62, fill: { color }, line: { color } });
          sl.addText(g.title, { x, y: 1.6, w, h: 0.62, fontSize: 19, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT, fit: 'shrink' });
          if (items.length) sl.addText(bulletRuns(items, 18), { x: x + 0.25, y: 2.35, w: w - 0.5, h: bodyH - 0.05, fontSize: 18, color: C.ink, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.15, fit: 'shrink' });
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
        sl.addChart(pptx.ChartType.bar, data, {
          x: 0.6, y: 1.5, w: chartW, h: 5.3, barDir: 'col', barGapWidthPct: 60,
          chartColors: (cols.length === 1 ? [C.accent] : [C.accent, gold, dark]).map((c) => c.toUpperCase()),
          showLegend: cols.length > 1, legendPos: 'b', legendFontFace: FONT, legendFontSize: 12,
          showValue: true, dataLabelFontSize: 11, dataLabelFontFace: FONT, dataLabelColor: '404040',
          catAxisLabelFontFace: FONT, catAxisLabelFontSize: 12, valAxisLabelFontSize: 11, valGridLine: { color: 'E5E8EC', size: 0.5 }
        });
        if (note.length) {
          const noteH = Math.min(4.9, 0.5 + note.reduce((a, x) => a + Math.ceil(x.length / 14), 0) * 0.42);
          sl.addShape(pptx.ShapeType.roundRect, { x: 9.0, y: 1.7, w: W - 9.6, h: noteH, ...card });
          sl.addText(note.map((x) => ({ text: x, options: { bullet: { code: '25CF', indent: 18 }, breakLine: true, paraSpaceAfter: 10 } })), { x: 9.2, y: 1.85, w: W - 10.0, h: noteH - 0.3, fontSize: 15, color: C.ink, fontFace: FONT, valign: 'top', fit: 'shrink' });
        }
        pageNo(sl, n);
        break;
      }
      case 'table': {
        titleBar(sl, s.title);
        const t = s.blocks.find((b) => b.type === 'table');
        const fs = t.rows.length > 10 ? 12 : t.rows.length > 6 ? 14 : 16;
        const rowH = t.rows.length > 10 ? undefined : Math.min(0.75, 5.2 / (t.rows.length + 1)); // 行少时加高，不挤在页面顶上
        // 列宽按内容长短分，长文字的列宽一些
        const lens = t.header.map((h, ci) => Math.max(plain(h).length, ...t.rows.map((r) => plain(r[ci] ?? []).length)));
        const sum = lens.reduce((a, b) => a + Math.min(Math.max(b, 4), 40), 0);
        const colW = lens.map((l) => ((W - 1.2) * Math.min(Math.max(l, 4), 40)) / sum);
        const head = t.header.map((c) => ({ text: plain(c), options: { bold: true, color: 'FFFFFF', fill: { color: dark }, align: 'center' } }));
        const body = t.rows.map((r, ri) => t.header.map((_, ci) => ({ text: plain(r[ci] ?? []), options: { fill: { color: ri % 2 ? C.soft : 'FFFFFF' }, align: t.align[ci] ?? (num(plain(r[ci] ?? [])) !== null ? 'right' : 'left') } })));
        sl.addTable([head, ...body], { x: 0.6, y: 1.55, w: W - 1.2, fontSize: fs, fontFace: FONT, color: C.ink, border: { type: 'solid', pt: 0.75, color: 'D5DCE6' }, valign: 'middle', colW, ...(rowH && { rowH }), autoPage: true, autoPageRepeatHeader: true });
        pageNo(sl, n);
        break;
      }
      case 'imageText':
      case 'image': {
        titleBar(sl, s.title);
        const img = s.blocks.find((b) => b.type === 'image');
        const pic = await imageData(img.src);
        const area = kind === 'image' ? { x: 0.6, y: 1.5, w: W - 1.2, h: 5.3 } : { x: 7.0, y: 1.55, w: 5.7, h: 5.2 };
        if (pic) {
          let w = area.w;
          let h = w / pic.ratio;
          if (h > area.h) { h = area.h; w = h * pic.ratio; }
          sl.addImage({ data: pic.data, x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h });
        } else {
          sl.addShape(pptx.ShapeType.roundRect, { ...area, fill: { color: C.soft }, line: { color: C.soft }, rectRadius: 0.06 });
          sl.addText(`［图片：${img.alt || img.src}］`, { ...area, fontSize: 16, color: muted, align: 'center', fontFace: FONT });
        }
        if (img.alt) sl.addText(img.alt, { x: area.x, y: area.y + area.h - 0.05, w: area.w, h: 0.4, fontSize: 12, color: muted, align: 'center', fontFace: FONT });
        if (kind === 'imageText') {
          const items = textOf(s.blocks.filter((b) => b.type !== 'image')).flatMap((b) => b.items);
          const size = fontFor(items.length, lines.join('').length) - 2;
          sl.addText(bulletRuns(items, size), { x: 0.6, y: 1.6, w: 6.1, h: 5.2, fontSize: size, color: C.ink, fontFace: FONT, valign: 'top', fit: 'shrink' });
        }
        pageNo(sl, n);
        break;
      }
      case 'cards':
      case 'steps': {
        titleBar(sl, s.title);
        const all = s.blocks.filter((b) => b.type === 'list').flatMap((b) => b.items);
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
        } else { const its = main.map(labelOf); chevrons(sl, its.map((x) => x.label), { descs: its.map((x) => x.text) }); }
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
        if (label && isChain(text)) sl.addText(label, { x: 0.6, y: 1.35, w: W - 1.2, h: 0.4, fontSize: 16, bold: true, color: dark, fontFace: FONT });
        chevrons(sl, nodes, { y: 1.85 });
        const rest = all.filter((it) => it !== chainIt);
        if (rest.length >= 3 && rest.length <= 6 && rest.every((it) => LABEL.test(plain(it.inlines)))) cardGrid(sl, rest, { top: 3.1 });
        else if (rest.length) {
          const size = Math.min(22, fontFor(rest.length, rest.map((it) => plain(it.inlines)).join('').length));
          sl.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 3.1, w: W - 1.2, h: 3.75, ...card });
          sl.addText(bulletRuns(rest, size), { x: 0.9, y: 3.3, w: W - 1.8, h: 3.35, fontSize: size, color: C.ink, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.15, fit: 'shrink' });
        }
        pageNo(sl, n);
        break;
      }
      default: {
        titleBar(sl, s.title || title);
        const items = textOf(s.blocks.filter((b) => b.type === 'list' || b.type === 'paragraph')).flatMap((b) => b.items);
        const extra = s.blocks.filter((b) => !['list', 'paragraph'].includes(b.type)).flatMap(blockLines).filter(Boolean);
        for (const t of extra) items.push({ inlines: [{ text: t }], children: [] });
        const short = items.length >= 2 && items.length <= 4 && items.every((it) => !it.children.some((c) => c.type === 'list') && plain(it.inlines).length <= 46);
        const total = items.map((it) => plain(it.inlines)).join('').length;
        if (items.length <= 2 && total <= 90 && !items.some((it) => it.children.length)) {
          // 只有一两句话：浅色底板上的大字，当作重点陈述页
          sl.addShape(pptx.ShapeType.roundRect, { x: 1.2, y: 2.0, w: W - 2.4, h: 3.4, fill: { color: C.soft }, line: { color: C.soft }, rectRadius: 0.06 });
          sl.addShape(pptx.ShapeType.rect, { x: 1.7, y: 2.45, w: 1.0, h: 0.07, fill: { color: gold }, line: { color: gold } });
          sl.addText(bulletRuns(items, 30).map((r) => ({ ...r, options: { ...r.options, bullet: false, paraSpaceBefore: 18 } })), { x: 1.7, y: 2.7, w: W - 3.4, h: 2.4, fontSize: 30, color: dark, fontFace: FONT, valign: 'middle', fit: 'shrink' });
        } else if (short) {
          // 要点少而短：一行一张白卡片，左边配图标，铺满页面，不让几行字挤在左上角
          const gap = 0.25, top = 1.6, h = Math.min(1.2, (5.2 - gap * (items.length - 1)) / items.length);
          const pick = iconPicker();
          items.forEach((it, k) => {
            const y = top + k * (h + gap);
            sl.addShape(pptx.ShapeType.roundRect, { x: 0.6, y, w: W - 1.2, h, ...card });
            iconCircle(sl, 0.9, y + h / 2 - 0.3, 0.6, pick(plain(it.inlines)), circleColors[k % circleColors.length]);
            sl.addText(it.inlines.map((r) => ({ text: r.text, options: { bold: r.bold, italic: r.italic } })), { x: 1.75, y, w: W - 2.75, h, fontSize: 21, color: C.ink, fontFace: FONT, valign: 'middle', fit: 'shrink' });
          });
        } else if (items.length) {
          const size = fontFor(items.length, lines.join('').length);
          sl.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 1.5, w: W - 1.2, h: 5.35, ...card });
          sl.addText(bulletRuns(items, size), { x: 0.95, y: 1.7, w: W - 1.9, h: 4.95, fontSize: size, color: C.ink, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.15, fit: 'shrink' });
        }
        pageNo(sl, n);
      }
    }
    if (s.notes.length) sl.addNotes(s.notes.join('\n'));
  }
  const blob = await pptx.write({ outputType: 'blob' });
  const preview = records.map(({ n, title: t, items, slide }) => ({ n, title: t, items, background: slide.background?.color }));
  return { blob, info: { slides: slides.length + 1, layouts, missingImages, preview, layoutIssues: layoutIssues(preview) } };
}

function today() {
  const d = new Date(Date.now() + 8 * 3600_000);
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}
