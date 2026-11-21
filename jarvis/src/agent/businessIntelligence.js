import { createPageReader, decodeBody } from './pageReader.js';
import { withWebDeadline } from './retrievalBudget.js';
import { webBody } from './webBody.js';
import { throwControl } from '../core/networkRequest.js';
import { evidence as evidenceStore } from './evidenceStore.js';
import { businessDate, businessError, businessSource, businessWindow, businessSnippet, companyMatches, cleanBusinessText, noticeMatches, noticeType, uniqueNotices } from './businessSources.js';
import { parseTenderListing, parseGgzyListing, parseTenderNotice, ggzyBodyUrl } from './tenderNotices.js';
import { queryQibookCompany } from './qibookCompany.js';
import { qibookConfig, qibookSelected } from '../core/qibook.js';
import { companyProfileHit } from './companyProfileSources.js';

export const BUSINESS_TOOL_NAMES = ['search_tenders', 'read_tender_notice', 'lookup_company'];
const str = description => ({ type: 'string', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const timeFields = {
  period: { type: 'string', enum: ['today', 'week', 'month', 'all'], description: '北京时间范围，默认最近7天；all不限历史日期' },
  from: str('可选起始日期，支持2026-11-03、2026/11/3、2026年11月3日'),
  to: str('可选截止日期，不能晚于今天')
};
const issue = (source, error) => ({ source, code: String(error?.code || error?.name || 'UNAVAILABLE').slice(0, 60), ...(Number.isInteger(error?.status) && { status: error.status }) });
const hitDate = row => businessDate(row.publishedAt || row.published_at || row.date || '')
  || businessDate(String(row.snippet || '').match(/(?:发布时间|发布日期|公告时间|公告日期)\s*[:：]?\s*(20\d{2}[年/.-]\d{1,2}[月/.-]\d{1,2})/)?.[1]);
const inWindow = (date, window) => Boolean(date && (!window.from || date >= window.from) && date <= window.to);
const emptyState = (warnings, jobs) => {
  const failed = new Set(warnings.map(row => row.source));
  return jobs.every(([source]) => failed.has(source)) ? 'unavailable' : warnings.length ? 'partial' : 'empty';
};
function rethrowBusinessControl(error, signal) {
  throwControl(error, signal);
  // 评测授权的次数/期限同样是整轮控制信号，不能换来源后继续发收费请求。
  if (['EVAL_QUOTA', 'EVAL_EXPIRED'].includes(error?.code)) throw error;
}

function searchHit(row) {
  const source = businessSource(row.url);
  if (!source) return null;
  return { title: cleanBusinessText(row.title, 180), url: source.url, source: source.label,
    snippet: businessSnippet(row.snippet), publishedAt: hitDate(row) || null,
    type: noticeType(row.title), evidence: 'search_summary' };
}
/** 回执不带大段正文；原文在独立证据库，模型按需回读。 */
function pack(value) {
  const encode = () => JSON.stringify(value);
  // 最多8条、每条短摘要；长URL等极端输入仍有12KiB硬上限，不截断JSON或谎报条数。
  while (encode().length > 12000 && (value.items?.length || value.leads?.length)) {
    if (value.leads?.length) value.leads.pop(); else value.items.pop();
    value.truncated = true;
  }
  if ('dataRetrieved' in value) value.dataRetrieved = Boolean(value.items?.length || value.rows?.length);
  return encode();
}

export function createBusinessTools(ctx, engine) {
  const get = ctx.fetchViaGateway || ctx.fetchImpl || ((...args) => fetch(...args));
  const now = ctx.now || Date.now;
  const evidence = ctx.businessEvidence || evidenceStore;
  const readPage = ctx.businessReadPage || ((url, options) => createPageReader(ctx)(url, options));
  async function remember(rows, execution) {
    if (!execution.sessionId) return rows;
    if (execution.signal?.aborted) throw execution.signal.reason;
    const fresh = rows.filter(row => !row.evidenceId);
    const ids = await evidence.put(execution.sessionId, { sources: fresh.map(row => ({ url: row.url, title: row.title, text: row.text || row.excerpt || row.snippet || '', original: row.evidence === 'original_page' })) });
    const byUrl = new Map(fresh.map((row, i) => [row.url, ids[i]]));
    return rows.map(row => ({ ...row, ...(!row.evidenceId && byUrl.get(row.url) && { evidenceId: byUrl.get(row.url) }) }));
  }
  async function search(query, execution, acceptHit) {
    if (!engine) throw businessError('当前没有可用搜索通道，仍可读取公开采购公告或已知原文链接', 'BUSINESS_SEARCH_UNAVAILABLE', 'api');
    const { retrieval, signal, progress } = execution;
    retrieval?.registerQuery?.(query);
    retrieval?.consume('search');
    return withWebDeadline(s => engine.search(query, 8, { signal: s, progress, routeContext: retrieval, consume: kind => retrieval?.consume(kind), ...(acceptHit && { acceptHit }) }), { signal, timeoutMs: Math.min(14000, retrieval?.remaining ?? Infinity) });
  }
  async function listing(execution, provider = 'ccgp') {
    execution.retrieval?.consume('read');
    return withWebDeadline(async signal => {
      const response = await get(provider === 'ccgp' ? 'https://www.ccgp.gov.cn/cggg/' : 'https://www.ggzy.gov.cn/', { signal });
      if (!response.ok) throw Object.assign(businessError('公开交易公告列表未读取成功', 'TENDER_LIST_HTTP', 'api'), { status: response.status });
      const bytes = await webBody(response, 2 * 1024 * 1024, signal);
      return (provider === 'ccgp' ? parseTenderListing : parseGgzyListing)(decodeBody(bytes, response.headers.get('content-type')));
    }, { signal: execution.signal, timeoutMs: Math.min(10000, execution.retrieval?.remaining ?? Infinity) });
  }
  async function detail(url, title, execution) {
    if (!businessSource(url)) throw businessError('请使用政府采购、公共资源交易、交易所或已支持采购平台的原文链接；其他线索可用fetch_url核查', 'TENDER_SOURCE');
    execution.retrieval?.consume('read');
    let bodyUrl = url;
    if (new URL(url).hostname === 'www.ggzy.gov.cn' && new URL(url).pathname.includes('/information/deal/html/a/')) {
      bodyUrl = await withWebDeadline(async signal => {
        const response = await get(url, { signal });
        if (!response.ok) throw Object.assign(businessError('公共资源公告入口读取失败', 'TENDER_ENTRY_HTTP', 'api'), { status: response.status });
        const html = decodeBody(await webBody(response, 1024 * 1024, signal), response.headers.get('content-type'));
        const linked = ggzyBodyUrl(html, url);
        if (!linked) throw businessError('只取得公告导航，未找到可读取的对应正文', 'TENDER_NO_BODY', 'api');
        return linked;
      }, { signal: execution.signal, timeoutMs: Math.min(8000, execution.retrieval?.remaining ?? Infinity) });
      execution.retrieval?.consume('read');
    }
    const text = await readPage(bodyUrl, { signal: execution.signal, progress: execution.progress, consume: kind => execution.retrieval?.consume(kind) });
    // 登录页、导航和搜索摘要不能当公告正文；不绕过验证码。
    if (String(text).trim().length < 100 || !/采购需求|采购内容|招标内容|招标范围|投标人|供应商|更正内容|中标人|成交人/.test(text)) throw businessError('页面未提供可核实的公告正文；可能是导航、登录或验证页面', 'TENDER_NO_BODY', 'api');
    // 标题只采用正文可回读的内容，不能用模型传来的“招标”覆盖实际中标/废标标题。
    const lines = String(text).split(/\n+/).map(line => line.trim()).filter(Boolean);
    const pageTitle = bodyUrl !== url ? lines[0] : lines.find(line => /(?:公告|公示)(?:[（(][^）)]*[）)])?$/.test(line) && line.length > 8 && line.length < 200) || '';
    const trustedTitle = title && cleanBusinessText(text, 60000).includes(cleanBusinessText(title)) ? title : pageTitle;
    const row = { ...parseTenderNotice(text, { url, title: trustedTitle, now: now() }), ...(bodyUrl !== url && { bodyUrl }) };
    const [saved] = await remember([{ ...row, text }], execution);
    const { text: original, ...receipt } = saved;
    return receipt;
  }
  async function collect(jobs, execution, warnings) {
    const result = await Promise.allSettled(jobs.map(async ([source, work]) => {
      try { return await work(); }
      catch (error) { rethrowBusinessControl(error, execution.signal); warnings.push(issue(source, error)); return []; }
    }));
    // 所有Promise均观察，停止/预算信号必须传播，不能转成“查不到”。
    for (const row of result) if (row.status === 'rejected') throw row.reason;
    return result.flatMap(row => row.value);
  }

  return [
    {
      name: 'search_tenders', sourceHealthManaged: true,
      description: '检索公开招投标公告。免费官方列表加现有搜索通道，按北京时间、地区和公告类型筛选，区分原文、官方列表与待核实线索。公开检索不保证覆盖全网；无结果不等于没有项目。',
      input_schema: schema({ query: str('项目或行业关键词，用空格连接；如智慧农业、水域 监测；不填则看最新公告'), region: str('可选省市，如江苏、南京；默认全国'), ...timeFields,
        notice_type: { type: 'string', enum: ['all', 'tender', 'award', 'correction', 'terminated', 'intention'], description: '全部/招标采购/中标成交/更正延期/终止废标/采购意向，默认all' },
        limit: { type: 'integer', minimum: 1, maximum: 8, description: '最多8条，默认6条；更多可缩小地区或日期范围' } }),
      run: async (args = {}, execution = {}) => {
        if (execution.signal?.aborted) throw execution.signal.reason;
        const query = cleanBusinessText(args.query), region = cleanBusinessText(args.region, 40);
        const filters = { query, region, notice_type: args.notice_type || 'all' };
        const window = businessWindow(args, now());
        const limit = Math.min(8, Math.max(1, Number(args.limit) || 6));
        const warnings = [];
        const terms = `${region === '全国' ? '' : region} ${query} ${args.notice_type === 'award' ? '中标' : args.notice_type === 'correction' ? '更正公告' : '招标 采购公告'} ${window.from ? window.from.slice(0, 7) : ''}`.trim();
        const jobs = [['中国政府采购网最新列表', () => listing(execution)], ['全国公共资源交易平台', () => listing(execution, 'ggzy')]];
        if (engine) jobs.push(['官方公告检索', async () => (await search(terms + ' site:gov.cn', execution)).map(searchHit).filter(Boolean)],
          ['采购平台补充检索', async () => (await search(terms + ' 公共资源交易 采购', execution)).map(searchHit).filter(Boolean)]);
        const raw = uniqueNotices(await collect(jobs, execution, warnings)).filter(row => noticeMatches(row, filters));
        const verified = [], leads = [];
        // 官方列表自带发布日期可直接展示；搜索结果必须读正文才能标为日期已核验。
        for (const row of raw) {
          if (row.evidence === 'official_listing' && inWindow(row.publishedAt, window)) verified.push(row);
          else if (row.evidence === 'search_summary') leads.push(row);
        }
        let reads = 0;
        const pending = [];
        for (const row of leads) {
          if (reads >= 3 || verified.length >= limit) { pending.push(row); continue; }
          reads++;
          try {
            const full = await detail(row.url, row.title, execution);
            if (inWindow(full.publishedAt, window) && noticeMatches({ ...full, snippet: full.excerpt }, filters)) verified.push(full);
            else if (!full.publishedAt) pending.push({ ...row, reason: '原文未识别到发布日期' });
          } catch (error) { rethrowBusinessControl(error, execution.signal); warnings.push(issue(row.source || businessSource(row.url)?.label, error)); pending.push(row); }
        }
        const sorted = verified.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))).slice(0, limit);
        const items = (await remember(sorted, execution)).map(({ title, titleTruncated, url, source, publishedAt, region, type, evidence, evidenceId, status, deadlineText, budgetText, projectNumber }) => ({ title, titleTruncated, url, source: source || businessSource(url)?.label, publishedAt, region, type, evidence, evidenceId, status: status || 'needs_verification', deadlineText, budgetText, projectNumber }));
        return pack({ state: items.length ? 'ok' : pending.length ? 'unverified' : emptyState(warnings, jobs), filters, window,
          items, leads: pending.slice(0, 3).map(row => ({ title: row.title, url: row.url, source: row.source, evidence: 'unverified', reason: row.reason || '尚未核实原文及发布日期' })),
          warnings, retrievedAt: new Date(now()).toISOString(),
          note: '只代表本次实际检索到的公开公告，不保证完整覆盖。partial表示部分来源失败，不能据此回答没有项目。待核实线索不能冒充该日期范围内的最新项目；中标、废标和更正不能当首次招标。详情需读取原文并核对最新更正；所有项目均未替用户确认投标资格。' });
      }
    },
    {
      name: 'read_tender_notice', sourceHealthManaged: true,
      description: '读取招投标原公告，提取预算、项目编号、截止时间和相关原文片段，保留证据编号。更正可改变原条件，不能只看首次公告就承诺可投标。',
      input_schema: schema({ url: str('官方公告原文URL'), title: str('检索取得的原公告标题（可选）') }, ['url']),
      run: async ({ url, title }, execution = {}) => pack(await detail(url, title, execution))
    },
    {
      name: 'lookup_company', sourceHealthManaged: true,
      description: '查企业简介、工商、股东、投资或近期公告。默认检索免费公开来源；basic缺少官方资料时补充全网简介线索，须用fetch_url读取原文，搜索摘要不能当工商/股权事实。用户选择企百科且已配置凭证时才用source=qibook（可能计费），失败仍可走公开检索。法定代表人不等于实际控制人。',
      input_schema: schema({ company: str('企业全称优先，也支持简称或统一社会信用代码；同名企业须按地区/信用代码区分'),
        section: { type: 'string', enum: ['basic', 'shareholders', 'executives', 'investments', 'news'], description: '基本信息/股东/高管/投资/近期公告；默认basic' },
        source: { type: 'string', enum: ['public', 'qibook'], description: '默认public公开来源；只有用户要求或表单选择企百科时使用qibook' }, ...timeFields }, ['company']),
      run: async ({ company, section = 'basic', source = 'public', ...dates }, execution = {}) => {
        const subject = cleanBusinessText(company, 100);
        if (!subject) throw businessError('请输入企业名称或统一社会信用代码');
        const warnings = [];
        if (source === 'qibook' && section !== 'news') {
          if (!qibookSelected(execution.requestText)) throw businessError('本轮未选择企百科，请使用公开来源；收费来源须由用户选择', 'QIBOOK_NOT_SELECTED');
          try {
            const result = await queryQibookCompany(subject, section, { config: qibookConfig(ctx), get, ...execution });
            if (result.rows.length) return pack({ ...result, dataRetrieved: true, retrievedAt: new Date(now()).toISOString() });
            warnings.push({ source: '企百科', code: 'QIBOOK_EMPTY' });
          }
          catch (error) { rethrowBusinessControl(error, execution.signal); warnings.push(issue('企百科', error)); }
        }
        const label = { basic: '统一社会信用代码 企业信息', shareholders: '股东 持股 年报', executives: '董事 高管', investments: '对外投资 年报', news: '公告 最新动态' }[section];
        if (!label) throw businessError('企业资料类型无效');
        const window = section === 'news' ? businessWindow(dates, now()) : null;
        const officialHit = row => {
          const hit = searchHit(row);
          return hit && companyMatches(hit, subject, section) ? hit : null;
        };
        const acceptOfficial = row => Boolean(officialHit(row));
        const jobs = [
          ['政府公开资料', async () => (await search(`${subject} ${label} site:gov.cn`, execution, acceptOfficial)).map(officialHit).filter(Boolean)],
          ['上市公司披露', async () => (await search(`${subject} ${label} site:cninfo.com.cn`, execution, acceptOfficial)).map(officialHit).filter(Boolean)]
        ];
        let rows = uniqueNotices(await collect(jobs, execution, warnings)).slice(0, 6);
        // 只为基本简介增加一次有界补搜，不把工商/股权查询降级成一般网页事实。
        if (!rows.length && section === 'basic') {
          const profileHit = row => companyProfileHit(row, subject);
          const fallback = ['企业简介公开检索', async () => (await search(`${subject} 公司简介 主营业务`, execution, row => Boolean(profileHit(row)))).map(profileHit).filter(Boolean)];
          jobs.push(fallback);
          rows = uniqueNotices(await collect([fallback], execution, warnings)).slice(0, 6);
        }
        const items = await remember(rows.filter(row => row.evidence !== 'source_link' && (!window || inWindow(row.publishedAt, window))), execution);
        const leads = rows.filter(row => row.evidence === 'source_link' || window && !row.publishedAt).slice(0, 3).map(row => ({ title: row.title, url: row.url, evidence: 'unverified', reason: row.evidence === 'source_link' ? '仅取得服务商引文链接，未取得简介内容；请用fetch_url读取原文' : '未识别到发布日期，不属于已核实的近期动态' }));
        return pack({ state: items.length || leads.length ? 'unverified' : emptyState(warnings, jobs), dataRetrieved: Boolean(items.length), company: subject, section, source: '公开资料', window,
          items: items.map(row => ({ ...row, snippet: row.snippet.slice(0, 240) })),
          leads, warnings, retrievedAt: new Date(now()).toISOString(),
          note: '公开搜索线索，未读原文，不能据此宣称工商/股权已核实或实时完整。company_profile仅为企业简介线索，应使用fetch_url读取链接原文再整理主营业务；不能从域名或自称官网推定来源身份。须核对企业全称与信用代码、年报对应日期；工商股东、上市公司十大股东与实际控制人分开。法定代表人不等于老板，个人同名不能合并。没有数据不得推断不存在。' });
      }
    }
  ];
}
