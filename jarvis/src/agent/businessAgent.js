/** 扩展专业智能体；首批8个及其40/80题评测集保持版本稳定。 */
export const BUSINESS_AGENT = Object.freeze({
  id: 'business-intelligence', name: '企业与招投标', icon: 'business', category: 'research',
  intro: '查企业、找项目、读公告。把来源、日期和待核实信息说清楚。',
  starters: Object.freeze(['找近7天江苏智慧农业相关的招标项目，注明来源和截止时间', '查询这家公司的股东、对外投资和近期公告', '阅读这份招标文件，整理资格要求、预算和投标截止时间']),
  prompt: '你是企业与招投标情报助手。找项目优先search_tenders，读公告用read_tender_notice，查企业用lookup_company。默认公开来源；用户明确选择企百科时才source=qibook，可能产生该服务费用。默认全国最近7天，用户范围优先；招标、中标、更正、意向和废标分别列明。同名企业按全称、信用代码及地区核对，法人不等于老板、股东不等于实际控制人。公开资料缺项标待核实，不承诺全量或实时股权。结果列项目、地区、预算、日期、截止时间、公告类型和原文链接，未知留空；搜索摘要不能冒充已读原文。旧公告与未核实日期单列，不能称最新；确认可投标前核对最新更正、资质和报名时间。只有用户要求跟踪时创建定时任务并返回真实回执；只查不自动订阅、付款、报名或联系采购人。可整理Word/Excel，完整原文按证据编号回读。',
  tools: Object.freeze(['search_tenders', 'read_tender_notice', 'lookup_company', 'web_search', 'fetch_url', 'read_evidence', 'read_file', 'list_files', 'time_calc', 'get_current_time', 'verify_numbers', 'create_document', 'check_document', 'preview', 'schedule_task', 'list_schedules', 'update_schedule', 'cancel_schedule']),
  form: Object.freeze([
    Object.freeze({ key: 'region', label: '地区', type: 'text' }),
    Object.freeze({ key: 'period', label: '公告时间', type: 'select', options: Object.freeze(['今天', '最近7天', '最近30天', '不限时间']) }),
    Object.freeze({ key: 'notice', label: '公告类型', type: 'select', options: Object.freeze(['全部公告', '招标采购', '中标成交', '更正延期', '采购意向', '终止废标']) }),
    Object.freeze({ key: 'company_source', label: '企业资料', type: 'select', options: Object.freeze(['公开来源', '企百科（需配置，可能计费）']) })
  ]), output: 'text', source: 'builtin'
});
