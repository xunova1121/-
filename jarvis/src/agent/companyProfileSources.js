/** 企业简介可找官网、母公司和媒体线索；工商/股权查询仍沿用官方来源规则。 */
import { isPrivateHost } from '../../shared/providers.js';
import { businessSource, businessSnippet, cleanBusinessText } from './businessSources.js';

const PROFILE = /公司简介|企业简介|企业介绍|公司介绍|关于我们|主营(?:业务)?|主要(?:业务|产品)|经营范围|业务(?:范围|领域)|专注于|致力于|成立于/;
const INCIDENTAL = /招标|投标|中标|采购公告|成交公告|判决|诉讼|失信|汇款|收款账户|开户银行/;

export function companyProfileHit(row, subject) {
  if (!row || !subject) return null;
  let url;
  try {
    url = new URL(row.url);
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 2048
      || !host.includes('.') || isPrivateHost(host) || host.endsWith('.internal')) return null;
  } catch { return null; }
  const title = cleanBusinessText(row.title, 180);
  const snippet = businessSnippet(row.snippet);
  // 必须有当前企业的明确主语与简介内容，不能拿付款行、项目供应商或同名简称拼工商资料。
  const at = snippet.indexOf(subject);
  const context = at < 0 ? '' : snippet.slice(at, at + subject.length + 160).split(/[。；;]/)[0];
  const prefix = at < 0 ? '' : snippet.slice(0, at).split(/[。；;]/).at(-1);
  // Responses 可能只给真实引文的标题与 URL：保留明确企业的待读链接，不能算取到简介。
  const linkOnly = !snippet && row.evidenceType === 'provider_citation' && title.includes(subject);
  if (!linkOnly && (!PROFILE.test(title + ' ' + snippet) || !(title.includes(subject) || at >= 0 && PROFILE.test(context)))) return null;
  if (INCIDENTAL.test(title) || INCIDENTAL.test(prefix + context)) return null;
  return {
    title, url: url.href, source: businessSource(url.href)?.label || url.hostname,
    snippet, publishedAt: null, evidence: linkOnly ? 'source_link' : 'search_summary', claimScope: 'company_profile',
    registrationVerified: false, originalRead: false,
    ...(row.summaryEvidence === 'provider_cited_summary' && { summaryEvidence: row.summaryEvidence })
  };
}
