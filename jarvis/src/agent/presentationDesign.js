import { STYLE_IDS, STYLE_NAMES } from './pptStyles.js';
import { chooseDesign } from './documentDesign.js';
import { documentError } from './documentPlan.js';

// 只解析要求头部，不拿正文/附件里提到的风格改用户的选择。最后一次明确改口优先。
const EXPRESSIONS = [
  ['minimal', /简约|极简|留白|干净一点|苹果风|简洁风/gi],
  ['story', /故事感|叙事|氛围感|古风|国风|电影感|有氛围/gi],
  ['data', /数据报告|数据风|图表为主|多用图表|仪表盘/gi],
  ['business', /稳重商务|商务风|正式一点|稳重|政务|汇报风/gi]
];
export function presentationRequest(text = '') {
  const header = String(text).slice(0, 12000).split(/^#{1,6}\s/m)[0];
  const events = [];
  for (const [style, expression] of EXPRESSIONS) {
    for (const match of header.matchAll(new RegExp(expression.source, expression.flags))) {
      const prefix = header.slice(0, match.index).split(/[，,。；;\n]/).at(-1).slice(-120);
      const listedPrefix = EXPRESSIONS.reduce((text, [, re]) => text.replace(new RegExp(re.source, re.flags), ''), prefix).replace(/[、/和或与及\s]+$/, '');
      // 否定仅作用于紧随其后的风格，不能使“不要封面，使用商务风”也被否定。
      const negative = /(?:不要|不用|不想要|不喜欢|别用|别|不采用|避免)(?:再|用|采用|做成|选择|那种|这种|这个|太|那么|过于|的|\s)*$/.test(listedPrefix);
      events.push({ style, negative, at: match.index });
    }
  }
  let style = '';
  const excluded = new Set();
  for (const event of events.sort((a, b) => a.at - b.at)) {
    if (event.negative) {
      excluded.add(event.style);
      if (style === event.style) style = '';
    } else {
      excluded.delete(event.style);
      style = event.style;
    }
  }
  return { style, excluded: [...excluded] };
}

/** 真实用户原话优先于调用参数；历史只读all/pptx，最多30条，不增加模型调用。 */
export async function presentationDesign(ctx, request, options, signal) {
  signal?.throwIfAborted();
  const history = await ctx.documentStylePreferences?.(signal) || '';
  signal?.throwIfAborted();
  const entries = String(history).split('\n').filter(line => /^- (?:all|pptx) · /.test(line)).slice(0, 30).reverse();
  const inherited = presentationRequest([
    ...entries.filter(line => line.startsWith('- all · ')),
    ...entries.filter(line => line.startsWith('- pptx · '))
  ].join('\n'));
  const current = presentationRequest(request);
  const excluded = new Set([...inherited.excluded, ...current.excluded]);
  // 当次正向要求可覆盖旧的“不用某风格”。
  if (current.style) excluded.delete(current.style);
  const fallback = chooseDesign({ ...options, style: '' });
  const candidates = [
    [current.style, '按你当前明确的风格要求', true],
    [options.style, '按指定的风格', true],
    [inherited.style, '按你保存的PPT风格偏好', true],
    [fallback.style, fallback.reason],
    ...STYLE_IDS.map(style => [style, '避开你排除的风格'])
  ];
  for (const [style, reason, required = false] of candidates) {
    if (STYLE_IDS.includes(style) && !excluded.has(style)) return { style, label: STYLE_NAMES[style], reason, required, excluded: [...excluded] };
  }
  throw documentError('四种PPT风格均被排除，请明确允许的风格；未生成文件', 'DOCUMENT_DESIGN');
}
