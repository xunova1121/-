/** 企业表单直查：复用已有工具与来源协议，不启动聊天模型，不写入任何会话证据。 */
import { createBusinessTools } from './businessIntelligence.js';
import { createSearch } from './webSearch.js';
import { openaiSearchOptions } from './openaiSearch.js';
import { createRetrievalBudget } from './retrievalBudget.js';

export const COMPANY_QUERY_MS = 45_000;
export const COMPANY_QUERY_REQUESTS = 12;
const sections = new Set(['basic', 'shareholders', 'executives', 'investments']);
const sources = new Set(['public', 'qibook']);
const fields = new Set(['company', 'section', 'source']);
const inputError = message => Object.assign(new Error(message), { code: 'COMPANY_QUERY_INPUT', status: 400, kind: 'input' });
const searchKey = value => typeof value === 'string' && !value.startsWith('••••') ? value.trim() : '';

export function validateCompanyQuery(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !fields.has(key)))
    throw inputError('企业查询只接受企业名称、资料类型和来源，不能指定密钥、地址或会话');
  if (typeof args.company !== 'string' || args.company.length > 100 || !args.company.trim() || /[\x00-\x1f\x7f]/.test(args.company))
    throw inputError('请输入 1 至 100 字的企业名称或统一社会信用代码');
  const section = args.section ?? 'basic', source = args.source ?? 'public';
  if (!sections.has(section) || !sources.has(source)) throw inputError('企业资料类型或查询来源不支持');
  return { company: args.company.trim(), section, source };
}

/** cfg 必须由当前运行位置的设置提供；只取搜索凭据，不借用聊天模型 Key。 */
export async function runCompanyLookup(cfg = {}, args, {
  get = (...values) => globalThis.fetch(...values), signal, openaiSearchFetch,
  timeBudgetMs = COMPANY_QUERY_MS
} = {}) {
  const query = validateCompanyQuery(args);
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('企业查询已停止'), { name: 'AbortError' });
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason ?? Object.assign(new Error('企业查询已停止'), { name: 'AbortError' }));
  signal?.addEventListener('abort', cancel, { once: true });
  const duration = Math.min(COMPANY_QUERY_MS, Math.max(1, Number(timeBudgetMs) || COMPANY_QUERY_MS));
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('本次企业查询已达到时间上限，请缩小范围后再试'), { code: 'RETRIEVAL_BUDGET' })), duration);
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', rejectStopped, { once: true });
  let requests = 0;
  const transport = fetcher => async (url, init = {}) => {
    controller.signal.throwIfAborted();
    init.signal?.throwIfAborted();
    if (requests >= COMPANY_QUERY_REQUESTS) {
      controller.abort(Object.assign(new Error('本次企业查询已达到请求次数上限，请缩小范围后再试'), { code: 'RETRIEVAL_BUDGET' }));
      throw controller.signal.reason;
    }
    requests++;
    try { return await fetcher(url, { ...init, signal: init.signal || controller.signal }); }
    catch (error) {
      if (['RETRIEVAL_BUDGET', 'EVAL_QUOTA', 'EVAL_EXPIRED'].includes(error?.code)) controller.abort(error);
      throw error;
    }
  };
  const publicGet = transport(get);
  const options = {
    ...openaiSearchOptions(cfg), openaiSearchFetch: transport(openaiSearchFetch || get),
    deepseekSearchEnabled: cfg.deepseekSearchEnabled === true, deepseekSearchKey: searchKey(cfg.deepseekSearchKey),
    qianfanSearchKey: searchKey(cfg.qianfanSearchKey), qianfanSearchTopK: cfg.qianfanSearchTopK,
    tavilyKey: searchKey(cfg.tavilyKey), bochaKey: searchKey(cfg.bochaKey),
    searchRegion: ['cn', 'global'].includes(cfg.searchRegion) ? cfg.searchRegion : 'auto',
    qibookAccessKey: searchKey(cfg.qibookAccessKey), qibookBaseUrl: cfg.qibookBaseUrl,
    fetchViaGateway: publicGet
  };
  const retrieval = createRetrievalBudget('企业资料查询', { timeBudgetMs: duration });
  retrieval.begin();
  const lookup = createBusinessTools(options, createSearch(options)).find(tool => tool.name === 'lookup_company');
  try {
    // requestText 仅表达这个表单按钮的明确选项；不把企业名称当额外授权指令。
    const result = await Promise.race([lookup.run(query, {
      signal: controller.signal, retrieval,
      requestText: query.source === 'qibook' ? '用企百科查询企业资料' : '查询企业公开资料'
    }), stopped]);
    controller.signal.throwIfAborted();
    // 不回传凭据，即使异常上游将传入凭据放进了资料字段。
    const secrets = ['qibookAccessKey', 'openaiSearchKey', 'deepseekSearchKey', 'qianfanSearchKey', 'tavilyKey', 'bochaKey'].map(key => searchKey(options[key])).filter(Boolean);
    return JSON.parse(result, (_, value) => typeof value === 'string' ? secrets.reduce((text, key) => text.split(key).join('[已隐藏]'), value) : value);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectStopped);
  }
}
