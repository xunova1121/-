import { styleRequest } from './documentStyleRequest.js';
import { documentError } from './documentPlan.js';

export const SHEET_STYLE_IDS = ['business', 'minimal', 'ledger', 'analysis'];
export const SHEET_STYLE_NAMES = { business: '商务表格', minimal: '简洁留白', ledger: '紧凑台账', analysis: '分析报表' };
const EXPRESSIONS = [
  ['minimal', /极简|简约|留白|简洁风/gi],
  ['business', /商务风|商务样式|商务表格/gi],
  ['ledger', /紧凑台账|台账风|台账样式|登记簿风/gi],
  ['analysis', /分析报表风|分析风|数据风|仪表盘风/gi]
];
export const spreadsheetRequest = text => styleRequest(text, EXPRESSIONS);
export async function spreadsheetDesign(ctx, request, { kind, sheetStyle }, signal) {
  signal?.throwIfAborted();
  const history = await ctx.documentStylePreferences?.(signal) || '';
  signal?.throwIfAborted();
  const entries = String(history).split('\n').filter(line => /^- (?:all|xlsx) · /.test(line)).slice(0, 30).reverse();
  const inherited = spreadsheetRequest([...entries.filter(line => line.startsWith('- all · ')), ...entries.filter(line => line.startsWith('- xlsx · '))].join('\n'));
  const current = spreadsheetRequest(request);
  const excluded = new Set([...inherited.excluded, ...current.excluded]);
  if (current.style) excluded.delete(current.style);
  const automatic = kind === 'ledger' ? 'ledger' : kind === 'analysis' ? 'analysis' : 'business';
  for (const [style, reason, required = false] of [
    [current.style, '按你当前的表格风格要求', true],
    [sheetStyle, '按指定的表格风格', true],
    [inherited.style, '按你保存的Excel风格偏好', true],
    [automatic, '按表格用途选择'],
    ...SHEET_STYLE_IDS.map(style => [style, '避开你排除的风格'])
  ]) {
    if (SHEET_STYLE_IDS.includes(style) && !excluded.has(style)) return { style, label: SHEET_STYLE_NAMES[style], reason, required, excluded: [...excluded] };
  }
  throw documentError('四种Excel风格均被排除，请明确允许的风格', 'DOCUMENT_DESIGN');
}

/** 仅改变视觉参数，不插行/列，不参与公式或数值计算；公文黑白规则保持。 */
export function spreadsheetTokens(id, theme, kind) {
  const C = theme.colors, official = Boolean(theme.official);
  const style = official ? 'business' : SHEET_STYLE_IDS.includes(id) ? id : kind === 'ledger' ? 'ledger' : kind === 'analysis' ? 'analysis' : 'business';
  const base = { style, headFill: official ? 'FFD9D9D9' : `FF${C.accent}`, headFont: official ? 'FF000000' : 'FFFFFFFF', zebra: `FF${official ? 'FFFFFF' : C.soft}`, titleFill: official ? 'FFFFFFFF' : `FF${C.primary}`, titleFont: official ? 'FF000000' : 'FFFFFFFF', bodySize: 10.5, headSize: 10.5, titleSize: 15, headHeight: 24, bodyHeight: 20, titleAlign: 'center', rulesOnly: false, totalFill: official ? 'FFF2F2F2' : `FF${C.soft}`, totalFont: 'FF000000', reportWidth: 90 };
  if (official || style === 'business') return base;
  if (style === 'minimal') return { ...base, headFill: 'FFFFFFFF', headFont: `FF${C.primary}`, zebra: 'FFFFFFFF', titleFill: 'FFFFFFFF', titleFont: `FF${C.primary}`, bodySize: 11, headSize: 11, titleSize: 18, headHeight: 30, bodyHeight: 24, titleAlign: 'left', rulesOnly: true, totalFill: 'FFF5F7FA', totalFont: `FF${C.primary}` };
  if (style === 'ledger') return { ...base, headFill: 'FFE9EEF4', headFont: `FF${C.primary}`, zebra: 'FFF7F9FC', bodySize: 10, headSize: 10, titleSize: 14, headHeight: 22, bodyHeight: 18, titleAlign: 'left' };
  return { ...base, headFill: `FF${C.soft}`, headFont: `FF${C.primary}`, bodySize: 11, titleSize: 18, headHeight: 28, bodyHeight: 24, titleAlign: 'left', rulesOnly: true, totalFill: `FF${C.primary}`, totalFont: 'FFFFFFFF' };
}
