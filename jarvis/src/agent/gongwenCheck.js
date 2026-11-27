/**
 * 公文体检（智能体专业化第 1 批）：生成公文前后做确定性检查，不调用模型。
 * 依据《党政机关公文处理工作条例》的文种要求和 GB/T 9704《党政机关公文格式》的常见规范，只查能确定的错误，宁可漏报不误报：
 *   文种与结语、请示一文一事 / 单一主送、报告不夹带请示、批复先引来文、纪要用语、层级编号连续、成文日期写法、
 *   发文字号是否来自用户材料、标题格式、口语和网络用语。
 */
export const GONGWEN_KINDS = ['请示', '报告', '批复', '通知', '通报', '函', '纪要', '意见', '决定', '通告', '公告', '议案'];
const KIND_RE = new RegExp(`(?:关于)?.{0,60}?的?(${GONGWEN_KINDS.join('|')})$`);

const CN = '零一二三四五六七八九十';
/** 一、二、……二十 → 1–20 */
function cnNumber(s) {
  if (/^十$/.test(s)) return 10;
  const m = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(s);
  if (m) return (m[1] ? CN.indexOf(m[1]) : 1) * 10 + (m[2] ? CN.indexOf(m[2]) : 0);
  return s.length === 1 ? CN.indexOf(s) : NaN;
}
const plainLine = (line) => String(line).replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();

/** 从标题或首行认出文种；认不出返回空 */
export function detectGongwenKind(text = '', title = '') {
  const head = plainLine(title || String(text).split('\n').find((l) => l.trim()) || '');
  const m = KIND_RE.exec(head.replace(/[。！!？?]+$/, ''));
  return m ? m[1] : '';
}

/**
 * @param {string} text  公文正文（Markdown 或纯文本，含标题）
 * @param {{ title?: string, kind?: string, sourceText?: string }} o  sourceText：用户给的材料原文，用来判断发文字号是不是编的
 * @returns {{ kind: string, issues: { level: 'error'|'warn', rule: string, message: string }[] }}
 */
export function checkGongwen(text = '', { title = '', kind = '', sourceText = '' } = {}) {
  const body = String(text || '');
  const lines = body.split('\n').map(plainLine).filter(Boolean);
  const k = kind || detectGongwenKind(body, title);
  const issues = [];
  const add = (level, rule, message) => issues.push({ level, rule, message });
  const tail = lines.slice(-8).join('\n');
  const all = lines.join('\n');

  // 标题
  const head = plainLine(title || lines[0] || '');
  if (k && !/关于/.test(head) && !/纪要$/.test(head)) add('warn', '标题', `标题“${head}”一般写成“发文机关 + 关于 + 事由 + 文种”，建议加上“关于”`);
  if (/[。！!？?]$/.test(head)) add('error', '标题', '公文标题末尾不加标点');

  // 文种要求
  if (k === '请示') {
    if (!/(妥否|当否|可否)[，,]?\s*请(批示|批复|审批|审定)|请予(批准|批复)|请批示|请审批/.test(tail)) add('error', '结语', '请示结尾要有请求批复的结语，如“妥否，请批示”或“当否，请批复”');
    const recipients = lines.filter((l) => l !== head).slice(0, 4).find((l) => /[：:]$/.test(l) && l.length <= 40);
    if (recipients && /[、，,]/.test(recipients)) add('error', '主送', `请示只写一个主送机关，现在是“${recipients}”；需要其他机关知道的用抄送`);
    const asks = (all.match(/(申请|请求|恳请)[^。；\n]{2,30}/g) || []).map((s) => s.slice(0, 12));
    if (new Set(asks).size >= 3) add('warn', '一文一事', '请示应一文一事，正文里好像提了多项请求，请确认是不是同一件事');
  }
  if (k === '报告') {
    if (/(妥否|当否)[，,]?\s*请(批示|批复)|请(予)?批准|请批示/.test(all)) add('error', '报告夹带请示', '报告不能夹带请示事项；需要上级批准的事另写请示');
    if (!/特此报告|专此报告|以上报告/.test(tail)) add('warn', '结语', '报告结尾一般写“特此报告”');
  }
  if (k === '批复') {
    if (!/(《[^》]{2,80}》|来文|请示)[^。\n]{0,20}(收悉|已收到)/.test(lines.slice(0, 6).join('\n'))) add('error', '引来文', '批复开头要先引来文，如“你单位《关于……的请示》收悉”');
    if (!/此复|特此批复/.test(tail)) add('warn', '结语', '批复结尾一般写“此复”');
  }
  if (k === '函' && !/特此函(告|复|达)|请(予)?函复|盼复|此函/.test(tail)) add('warn', '结语', '函的结尾一般写“特此函告”“请予函复”或“盼复”');
  if (k === '通知' && /(妥否|当否)[，,]?\s*请(批示|批复)/.test(all)) add('error', '文种', '通知不用“妥否，请批示”，这是请示的结语');
  if (k === '纪要' && !/会议(认为|指出|要求|强调|议定|决定|明确|同意)/.test(all)) add('warn', '纪要用语', '纪要一般用“会议认为 / 会议要求 / 会议议定”来写议定事项');

  // 层级编号：一、二、 和（一）（二）不跳号
  let prev = 0;
  let sub = 0;
  for (const line of lines) {
    const top = /^([一二三四五六七八九十]{1,3})、/.exec(line);
    if (top) {
      const n = cnNumber(top[1]);
      if (prev && n !== prev + 1) add('error', '层级编号', `一级标题编号不连续：“${top[1]}、”前面是第${prev}项`);
      prev = n; sub = 0;
      continue;
    }
    const second = /^[（(]([一二三四五六七八九十]{1,3})[）)]/.exec(line);
    if (second) {
      const n = cnNumber(second[1]);
      if (sub && n !== sub + 1) add('error', '层级编号', `二级标题编号不连续：“（${second[1]}）”前面是（${CN[sub] || sub}）`);
      sub = n;
    }
  }

  // 成文日期：用阿拉伯数字“2026年11月5日”，不用汉字年份或“2026-11-05”
  const dateLine = lines.slice(-4).join('\n');
  if (/[〇零一二三四五六七八九]{4}年/.test(dateLine)) add('warn', '成文日期', '成文日期用阿拉伯数字，如“2026年11月5日”（GB/T 9704—2012）');
  if (/\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/.test(dateLine)) add('warn', '成文日期', '成文日期写成“2026年11月5日”，不用“2026-11-05”这类写法');

  // 发文字号：用户材料里没有的，不能编
  for (const m of all.matchAll(/[^\s，。]{1,12}[〔\[［(（]\d{4}[〕\]］)）]\s*\d+\s*号/g)) {
    // 材料可能在更早的对话里，这里只提醒核对，不当硬错误
    if (!String(sourceText).replace(/\s/g, '').includes(m[0].replace(/\s/g, ''))) add('warn', '发文字号', `发文字号“${m[0]}”在本轮材料里没找到：确认是用户给的；不知道就写“〔待补充〕”，不能编造`);
  }

  // 用语
  const slang = all.match(/搞定|靠谱|超级|巨好|哈哈|小伙伴|亲们|给力|点赞|OK|ok|！！|～/g);
  if (slang) add('warn', '用语', `公文用语要庄重，避免口语和网络用语：${[...new Set(slang)].slice(0, 4).join('、')}`);
  if (/附件[：:]\s*$/m.test(all)) add('warn', '附件', '写了“附件：”但没有附件名称');

  return { kind: k, issues };
}

/** 给模型看的一段话；没有问题返回空 */
export function gongwenIssueNote(result) {
  if (!result?.issues?.length) return '';
  const lines = result.issues.slice(0, 8).map((x, i) => `${i + 1}. 【${x.rule}】${x.message}`);
  return `公文体检（${result.kind || '公文'}）发现 ${result.issues.length} 处问题，请改正后再交付：\n${lines.join('\n')}`;
}

/** 工具：成稿前先体检（只读、不联网、不调模型） */
export function createGongwenCheckTool() {
  return {
    name: 'check_gongwen',
    description: '公文体检：检查公文草稿的文种与结语、请示一文一事和单一主送、报告不夹带请示、批复先引来文、纪要用语、层级编号是否连续、成文日期写法、发文字号是否来自用户材料、标题格式和口语用词。起草请示、报告、批复、通知、函、纪要等公文后、生成 Word 前先调用；按返回的问题改正。',
    input_schema: { type: 'object', properties: { text: { type: 'string', description: '公文全文（含标题）' }, title: { type: 'string' }, kind: { type: 'string', enum: GONGWEN_KINDS }, source_text: { type: 'string', description: '用户给的材料原文（用来核对发文字号等）' } }, required: ['text'], additionalProperties: false },
    run: async ({ text, title = '', kind = '', source_text: sourceText = '' } = {}) => {
      const result = checkGongwen(String(text || '').slice(0, 60000), { title, kind, sourceText });
      return JSON.stringify({ kind: 'gongwen_check', doc_kind: result.kind, issues: result.issues, note: result.issues.length ? '按 issues 逐条改正后再生成；warn 是提醒，error 必须改' : '没发现问题' });
    }
  };
}
