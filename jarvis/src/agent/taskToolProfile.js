import { CODE_TASK_CORE } from './codeDevelopment.js';
import { DOCUMENT_TASK_CORE } from './documentToolProfile.js';
import { CORE } from './toolLoader.js';
import { isPhoneRequest } from '../../shared/phoneControl.js';
import { textPosterRequest, POSTER_TOOLS } from './posterRouting.js';
import { visualSceneRequest, VISUAL_SCENE_TOOLS } from './visualSceneRouting.js';

const BASIC = ['execution_capabilities', 'read_task_requirements', 'read_tool_result', 'review_task', 'need_more_time', 'request_capable_model'];
const MEMORY = ['recall', 'remember', 'kb_search', 'search_conversations', 'read_conversation', 'list_my_messages', 'list_work_records'];
const FILES = ['find_files', 'search_in_files', 'list_files', 'read_file', 'write_file', 'edit_file', 'preview', 'run_javascript', 'run_project_tests'];
const SEARCH = ['web_search', 'fetch_url', 'read_evidence', 'fetch_json', 'reconcile_numbers'];

/** 只决定先展示哪些 schema；所有工具仍可通过目录发现、按名字直接调用，权限边界不变。 */
export function taskToolCore(intent, text, { images = [], computerTask = false, strict = false } = {}) {
  if (computerTask) return CORE;
  const value = String(text || '');
  const names = new Set([...BASIC, ...MEMORY]);
  const add = list => list.forEach(name => names.add(name));
  if (visualSceneRequest(value)) { add(VISUAL_SCENE_TOOLS); return names; }
  if (strict || images.length) return CORE;
  if (isPhoneRequest(value)) { add(['phone_devices', 'phone_action', 'get_current_time', 'time_calc']); return names; }
  if (textPosterRequest(value)) { add(POSTER_TOOLS); return names; }
  if (intent?.category === 'code') { add(CODE_TASK_CORE); add(FILES); return names; }
  if (/Word|Excel|PPT|文档|表格|幻灯片|\.docx|\.xlsx|\.pptx/i.test(value)) return DOCUMENT_TASK_CORE;
  if (/架构图|流程图|关系图|拓扑图|生成图片|画图|图片|唱歌|歌曲|视频/.test(value)) return CORE;
  if (/招投标|招标|中标|采购公告|股东|股权|工商|查企业|查公司|对外投资/.test(value)) add(['search_tenders', 'read_tender_notice', 'lookup_company', 'time_calc', ...SEARCH]);
  if (/天气|温度|下雨|气温/.test(value)) add(['get_weather', 'get_current_time', ...SEARCH]);
  else if (/股价|行情|金价|汇率|大盘|美股|港股|油价|股票/.test(value)) add(['get_market_quote', 'get_stock_kline', 'verify_numbers', 'time_calc', 'list_holdings', 'holding_profit', ...SEARCH]);
  else if (/比分|赛程|比赛|足球|篮球|新闻|资讯/.test(value)) add(['get_today_news', 'get_sports_scores', ...SEARCH]);
  else if (/时间|日期|几点|星期|工作日|倒计时|年龄|计算|换算|平均|百分比|月供|相差/.test(value)) add(['time_calc', 'verify_numbers', 'get_current_time', 'run_javascript']);
  else if (/提醒|定时/.test(value)) add(['schedule_task', 'get_current_time', 'time_calc']);
  else if (/文件|工作区|附件|(?:写|记|整理|编辑|保存)[^。！？\n]{0,20}(?:笔记|备忘录|便笺)/.test(value)) add(FILES);
  else if (/查|搜|最新|资料|调研/.test(value)) add(SEARCH);
  // 未知任务保留通用入口，避免凭短句隐藏真实能力；长说明留在可搜索的工具目录。
  else add(['web_search', 'find_files', 'read_file', 'verify_numbers', 'time_calc']);
  if (/调研|研究|调查|核验|查证|核实/.test(value)) add([...SEARCH, 'deep_research', 'fact_check', 'check_search_terms']);
  return names;
}
