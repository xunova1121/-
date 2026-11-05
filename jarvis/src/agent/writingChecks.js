/**
 * 学术文档与合同的确定性检查（智能体专业化第 4 批），和公文体检同一思路：不调用模型，只查能确定的问题。
 *   学术：正文引用 [n] 和文末参考文献对得上、编号连续、条目带 GB/T 7714 文献类型标识（[J][M][D][C][EB/OL]…）和年份、
 *         论文类有摘要和关键词
 *   合同：必备条款（当事人、标的、价款、期限、违约责任、争议解决、签署）、金额大写和小写一致
 */
const lineOf = (s) => String(s).replace(/\*\*/g, '').trim();

// ---------------------------------------------------------------- 学术
const TYPE_MARK = /\[(?:J|M|D|C|N|R|S|P|G|A|Z|EB\/OL|DB\/OL|J\/OL|M\/OL|CP|DS)\]/;
export const isAcademic = (title = '', text = '') => /论文|开题报告|综述|课题申报|研究报告|学位/.test(title) || /^\s*#*\s*参考文献\s*$/m.test(text);

export function checkAcademic(text = '', { title = '' } = {}) {
  const body = String(text || '');
  const issues = [];
  const add = (level, rule, message) => issues.push({ level, rule, message });
  const parts = body.split(/^\s*#*\s*参考文献\s*[:：]?\s*$/m);
  const main = parts[0];
  const refs = parts.length > 1 ? parts.slice(1).join('\n').split('\n').map(lineOf).filter((l) => /^\[?\d+\]?[.、\s]/.test(l)) : [];
  const cited = new Set([...main.matchAll(/\[(\d+(?:\s*[,，\-–]\s*\d+)*)\]/g)].flatMap((m) => {
    const out = [];
    for (const piece of m[1].split(/[,，]/)) {
      const [a, b] = piece.split(/[-–]/).map((x) => Number(x.trim()));
      if (b && b > a && b - a < 50) for (let i = a; i <= b; i++) out.push(i); else out.push(a);
    }
    return out;
  }));
  if (cited.size && !refs.length) add('error', '参考文献', '正文有引用标号，但文末没有“参考文献”清单');
  const listed = refs.map((l) => Number((/^\[?(\d+)\]?/.exec(l) || [])[1]));
  listed.forEach((n, i) => { if (n !== i + 1) add('error', '文献编号', `参考文献编号不连续：第 ${i + 1} 条标成了 [${n}]`); });
  for (const n of cited) if (refs.length && !listed.includes(n)) add('error', '引用对不上', `正文引用了 [${n}]，参考文献里没有这一条`);
  for (const n of listed) if (cited.size && !cited.has(n)) add('warn', '未引用', `参考文献 [${n}] 正文里没有引用`);
  refs.forEach((l, i) => {
    if (!TYPE_MARK.test(l)) add('warn', '著录格式', `参考文献第 ${i + 1} 条缺少文献类型标识（如 [J] 期刊、[M] 专著、[D] 学位论文、[EB/OL] 网络资源，GB/T 7714—2015）`);
    if (!/(19|20)\d{2}/.test(l)) add('warn', '著录格式', `参考文献第 ${i + 1} 条没有出版年份`);
  });
  if (/论文|学位/.test(title) && !/^\s*#*\s*摘\s*要/m.test(body)) add('warn', '结构', '论文一般要有“摘要”');
  if (/论文|学位/.test(title) && !/关键词|关键字/.test(body)) add('warn', '结构', '论文一般要有“关键词”（3–5 个）');
  return { kind: 'academic', issues: issues.slice(0, 12) };
}

// ---------------------------------------------------------------- 合同
export const isContract = (title = '') => /合同|协议|协议书|契约/.test(title) && !/合同管理|协议栈/.test(title);
const CLAUSES = [
  ['当事人', /甲方|乙方|委托方|受托方|出租方|承租方|买方|卖方|发包人|承包人/],
  ['标的或内容', /标的|服务内容|工作内容|项目内容|租赁物|货物|合作内容|委托事项/],
  ['价款或报酬', /价款|费用|报酬|租金|价格|金额|支付/],
  ['期限', /期限|有效期|起止|自\s*\d{4}\s*年|履行期/],
  ['违约责任', /违约/],
  ['争议解决', /争议|仲裁|诉讼|人民法院/],
  ['签署', /签字|签章|盖章|签署|（签字）|\(签字\)/]
];
const CN_DIGIT = { 零: 0, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9 };
const CN_UNIT = { 拾: 10, 佰: 100, 仟: 1000 };
/** 人民币大写 → 数字（壹拾贰万叁仟元整 → 123000）；认不出返回 null */
export function upperAmount(s) {
  const t = String(s).replace(/^人民币/, '').replace(/[整正]$/, '');
  if (!/^[零壹贰叁肆伍陆柒捌玖拾佰仟万亿元圆角分]+$/.test(t)) return null;
  let total = 0, section = 0, num = 0;
  const [yuan, rest = ''] = t.split(/[元圆]/);
  for (const ch of yuan) {
    if (ch in CN_DIGIT) num = CN_DIGIT[ch];
    else if (ch in CN_UNIT) { section += (num || 1) * CN_UNIT[ch]; num = 0; }
    else if (ch === '万' || ch === '亿') { total += (section + num) * (ch === '万' ? 1e4 : 1e8); section = 0; num = 0; }
  }
  total += section + num;
  const jiao = /([壹贰叁肆伍陆柒捌玖])角/.exec(rest), fen = /([壹贰叁肆伍陆柒捌玖])分/.exec(rest);
  return Math.round((total + (jiao ? CN_DIGIT[jiao[1]] / 10 : 0) + (fen ? CN_DIGIT[fen[1]] / 100 : 0)) * 100) / 100;
}

export function checkContract(text = '') {
  const body = String(text || '');
  const issues = [];
  const add = (level, rule, message) => issues.push({ level, rule, message });
  for (const [name, re] of CLAUSES) if (!re.test(body)) add(name === '签署' || name === '期限' ? 'warn' : 'error', '必备条款', `缺少“${name}”相关条款`);
  // 金额大写和小写：同一句里“人民币……元整（¥123,000）”要一致
  for (const m of body.matchAll(/(人民币[零壹贰叁肆伍陆柒捌玖拾佰仟万亿元圆角分整正]+)[^\n。；]{0,12}?[（(]?\s*[¥￥]\s*([\d,，]+(?:\.\d+)?)/g)) {
    const upper = upperAmount(m[1]), lower = Number(m[2].replace(/[,，]/g, ''));
    if (upper !== null && Math.abs(upper - lower) > 0.005) add('error', '金额', `金额大小写不一致：“${m[1]}”是 ${upper} 元，小写写的是 ¥${m[2]}`);
  }
  if (!/仅供参考|律师|法律意见/.test(body)) add('warn', '提示', '交付时提醒：合同涉及具体权利义务，重要合同签署前请律师审核');
  return { kind: 'contract', issues: issues.slice(0, 12) };
}

/** 给模型看的一段话 */
export function writingIssueNote(result) {
  if (!result?.issues?.length) return '';
  const name = result.kind === 'contract' ? '合同检查' : '学术规范检查';
  return `${name}发现 ${result.issues.length} 处问题，请改正后再交付：\n${result.issues.slice(0, 8).map((x, i) => `${i + 1}. 【${x.rule}】${x.message}`).join('\n')}`;
}

export function createWritingCheckTool() {
  return {
    name: 'check_writing',
    description: '学术文档 / 合同的规范检查：academic 检查正文引用与参考文献对应、编号连续、GB/T 7714 文献类型标识和年份、论文摘要关键词；contract 检查必备条款（当事人、标的、价款、期限、违约责任、争议解决、签署）和金额大小写一致。写论文、开题报告、综述、合同、协议后、生成文件前调用。',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['academic', 'contract'] }, text: { type: 'string' }, title: { type: 'string' } }, required: ['kind', 'text'], additionalProperties: false },
    run: async ({ kind, text, title = '' } = {}) => {
      const result = kind === 'contract' ? checkContract(String(text || '').slice(0, 80000)) : checkAcademic(String(text || '').slice(0, 80000), { title });
      return JSON.stringify({ kind: 'writing_check', check: kind, issues: result.issues, note: result.issues.length ? '按 issues 改正；warn 是提醒，error 必须改' : '没发现问题' });
    }
  };
}
