/** 仅缩短本程序工具的模型说明，不改变名称、参数、执行器或第三方MCP协议。 */
const DESCRIPTIONS = Object.freeze({
  create_document: '按完整requirements生成Office/PDF文件并读回检查。正文用Markdown，参考材料传原文件；回执中的渲染或视觉未检查不能当通过。',
  write_long_document: '长文档按大纲分节写作、统一审查并返工一次。完整task和material_files保留要求与原材料，outline_only只交大纲。',
  write_professional_document: '重要文档先按授权免费调研，再底稿、推演、起草与审查。传完整原话和原文件；用户禁止联网或仅用材料时research=false，不编造缺失证据。',
  fact_check: '逐项查证多个对象或用户明确要求的核验，items名称原样保留。核对实际原文引用，官方正文可单源核实，其他按来源与冲突分级；普通单一问题先搜索。',
  web_search: '检索最新网页，可按queries并行搜索不同关键词。结果是索引和摘要，关键原文用fetch_url读取；同词换源由程序降级。',
  deep_research: '多轮调研并将带来源的报告保存到工作区。适合明确研究任务，普通问题用web_search；遵守本轮预算。',
  read_evidence: '按编号读取本会话已缓存的原文片段，不再联网、不额外消耗搜索预算。不填编号列索引，片段有长度上限。',
  review_task: '核对本轮真实产物、运行与读回回执；计划勾选不是验收，未检查项不能说通过。'
});

export function conciseTool(tool) {
  const description = Object.hasOwn(DESCRIPTIONS, tool.name) ? DESCRIPTIONS[tool.name] : null;
  return description ? { ...tool, description } : tool;
}
