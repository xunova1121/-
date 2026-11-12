import { businessError, cleanBusinessText } from './businessSources.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';
import { webBody } from './webBody.js';

// 依企百科公开接口说明独立实现；保留HTTPS校验，不复制原Python脚本的verify=False和吞错逻辑。
const MODULES = { basic: 'BASIC', shareholders: 'SHAREHOLDER', executives: 'PERSON', investments: 'ENTINV' };
const SECTION_FIELDS = {
  basic: ['ENTNAME', 'CREDITCODE', 'FRNAME', 'REGCAP', 'REGCAPCUR', 'ESDATE', 'ENTSTATUS', 'DOM', 'OPSCOPE', 'REGORG'],
  shareholders: ['SHANAME', 'SUBCONAM', 'FUNDEDRATIO', 'REGCAPCUR', 'CONDATE'],
  executives: ['PERNAME', 'POSITION'], investments: ['ENTNAME', 'ENTJGNAME', 'REGCAP', 'REGCAPCUR', 'ENTSTATUS', 'FUNDEDRATIO', 'CONDATE']
};
const FIELDS = {
  ENTNAME: '企业名称', CREDITCODE: '统一社会信用代码', FRNAME: '法定代表人', REGCAP: '注册资本（万元）', REGCAPCUR: '资本币种',
  ESDATE: '成立日期', ENTSTATUS: '经营状态', DOM: '住所', OPSCOPE: '经营范围', REGORG: '登记机关',
  SHANAME: '股东名称', SUBCONAM: '认缴出资额（万元）', FUNDEDRATIO: '出资比例', CONDATE: '出资日期',
  PERNAME: '高管姓名', POSITION: '职务', ENTJGNAME: '企业名称'
};
export async function queryQibookCompany(company, section, { config, get, signal, retrieval } = {}) {
  if (!config) throw businessError('尚未配置企百科API地址和访问密钥；可改用source=public查公开资料', 'QIBOOK_NOT_CONFIGURED');
  const endpoint = new URL(config.baseUrl + '/skill/entData/combinedQuery');
  endpoint.searchParams.set('entmark', company);
  retrieval?.consume('read');
  return withWebDeadline(async activeSignal => {
    let response;
    try { response = await get(endpoint.href, { headers: { access_key: config.key }, signal: activeSignal, redirect: 'error' }); }
    catch (error) {
      throwControl(error, activeSignal);
      if (['EVAL_QUOTA', 'EVAL_EXPIRED'].includes(error?.code)) throw error;
      throw businessError('企百科连接失败，可继续使用公开来源', 'QIBOOK_NETWORK', 'network');
    }
    if (!response.ok) throw Object.assign(businessError(`企百科HTTP ${response.status}，未取得企业资料`, 'QIBOOK_HTTP', 'api'), { status: response.status });
    let result;
    try { result = JSON.parse(new TextDecoder().decode(await webBody(response, 1024 * 1024, activeSignal))); }
    catch (error) { throwControl(error, activeSignal); throw businessError('企百科返回格式无法识别', 'QIBOOK_RESPONSE', 'api'); }
    if (Number(result.code ?? result.CODE) !== 200) throw businessError('企百科未返回成功回执，请核对账号权限或额度；不能当作企业不存在', 'QIBOOK_REJECTED', 'api');
    const info = result.data?.ENT_INFO;
    if (!info || typeof info !== 'object') return { state: 'empty', source: '企百科', company, rows: [], note: '本次没有返回企业资料，不代表企业不存在' };
    const module = info[MODULES[section]];
    const raw = Array.isArray(module) ? module : module && typeof module === 'object' ? [module] : [];
    const rows = raw.slice(0, section === 'basic' ? 1 : 10).filter(row => row && typeof row === 'object' && !Array.isArray(row))
      .map(row => Object.fromEntries(Object.entries(row).filter(([k, v]) => SECTION_FIELDS[section]?.includes(k) && v != null && v !== '').map(([k, v]) => [FIELDS[k], cleanBusinessText(v, k === 'OPSCOPE' ? 300 : 100)]))).filter(row => Object.keys(row).length);
    return { state: rows.length ? 'ok' : 'empty', source: '企百科', company: cleanBusinessText(info.BASIC?.ENTNAME || company), creditCode: cleanBusinessText(info.BASIC?.CREDITCODE), section, rows, truncated: raw.length > 10,
      note: '仅为接口返回的该模块资料；未提供数据更新日，不能保证实时。工商股东不等于最终实际控制人，法定代表人不等于老板。' };
  }, { signal, timeoutMs: Math.min(8000, retrieval?.remaining ?? Infinity) });
}
