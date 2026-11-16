/** 自有专项方法按任务加载；只描述实际工具，不复制厂商提示词或虚构执行环境。 */
const METHODS = Object.freeze({
  poster: { label: '图文海报与同稿Demo', match: /海报|\.design\.json|\.canvas\.json|同稿.*Demo/i,
    tools: ['make_poster', 'create_visual_demo', 'inspect_image', 'read_file'],
    steps: ['先确定原文、阅读场景和真实源稿；只改标题时保留其余图层。', '已有卡槽用Canvas保护原图；重新设计用design，栏目配图用magazine+sections.asset或自由图层。图像须服务内容，不能用空地图和重复文字卡片充数。', '数字单位不断开，中文用真实字体。参数修正在渲染前进行；根据明确失败字段修改，遵守corrections与retryAllowed。', '检查最终PNG和手机预览；图文关联/字体/像素/事实分别核验。交付实际读回的主PNG，Demo另附HTML，不把文件齐全当审美通过。'] },
  company: { label: '企业与招投标研究', match: /企业|公司|工商|股东|股权|招投标|招标|中标|采购公告/,
    tools: ['lookup_company', 'search_tenders', 'read_tender_notice', 'web_search', 'fetch_url'],
    steps: ['先按用户完整公司名/地区检索，名称近似的企业分别核对；不要把无结果理解为公司不存在。', '专业接口没有资料时，在已开放搜索预算内找官网、公告、年报或监管原文。股权需注明对应时间与直接/间接关系。', '区分候选摘要、已读原文和已核实事实；招标记录保留发布日、截止日、地区及原文链接。', '来源冲突先核对时间和统计口径；缺项具体说明，不编造股东/项目/实时性，不要求用户理解后台工具名。'] },
  research: { label: '有证据的搜索研究', match: /搜索|查找|查询|最新|新闻|调研|研究|核实|核验|查证|资料/,
    tools: ['web_search', 'fetch_url', 'read_evidence', 'fact_check', 'reconcile_numbers'],
    steps: ['当前状态与变化信息按需检索，稳定常识直接回答；同时查多个对象时分别覆盖。', '优先一手来源，关键结论读对应原文；sourceLedger的候选不能当已读原文，读取时间不等于发布日期。', '数据附来源、日期、单位；冲突先查口径再取舍，未解决就保留分歧。', '够用即答，失败换有针对性的来源；有界并行、取消与预算沿用当前执行器，不无限搜索。'] },
  document: { label: '文档制作与局部修改', match: /Word|PPT|Excel|文档|报告|表格|幻灯片|\.docx|\.pptx|\.xlsx/i,
    tools: ['read_file', 'create_document', 'edit_office_document', 'edit_spreadsheet', 'check_document'],
    steps: ['先读用户素材与确认原文，区分新建、局部改稿和仅解释。', '根据读者和用途组织结构，按格式选择已有工具；局部修改核对旧值，不重写无关内容。', '按真实渲染检查分页、字体、溢出和数字；技术检查与事实来源分别报告。', '读取最终文件并给出能打开的链接，只有成功回执才能称交付。'] },
  code: { label: '代码修改与验证', match: /代码|编程|修复.*(?:bug|程序)|开发.*(?:功能|接口)|运行测试/i,
    tools: ['read_file', 'edit_file', 'run_project_tests', 'code_read', 'code_edit', 'code_run'],
    steps: ['先读取实际项目约定和相关代码，定位复现原因。', '针对缺陷做最小适用修改，保留已有功能和用户改动。', '运行适用测试并记录真实结果；没有执行工具时不声称测试成功。', '报告实际改动、验证和未完成项；发布与外部写入沿用现有授权边界。'] }
});
export function taskMethodContext(text, tools = []) {
  const found = Object.entries(METHODS).find(([, method]) => method.match.test(String(text)));
  if (!found) return '';
  const [id, method] = found, available = new Set(tools.map(t => t.name));
  return `本轮专项方法:${id}（${method.label}）\n` + method.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    + '\n相关实际工具:' + (method.tools.filter(name => available.has(name)).join('、') || '需先用工具目录核对') + '。方法说明不增加工具、权限或付费预算。';
}
export function createTaskMethodsTool(tools = []) {
  return { name: 'read_task_method', description: '按需读取未央自有专项制作/研究方法与实际工具，不下载或安装外部插件。',
    input_schema: { type: 'object', properties: { task: { type: 'string', maxLength: 300 } }, required: ['task'], additionalProperties: false },
    run: async ({ task }) => taskMethodContext(task, tools) || '没有匹配的专项；按本轮实际工具完成任务，不编造安装能力。' };
}
