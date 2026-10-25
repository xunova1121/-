/** 检查点只记录证据，不把“可能执行过”当成可重放的命令。 */
const READ_ONLY = new Set(['list_my_messages','read_file','read_image_text','inspect_image','list_files','search_files','search_file_content','web_search','fetch_url','kb_search','recall','get_current_time','verify_numbers','get_stock_kline','get_sports_scores','check_search_terms','review_task','execution_capabilities','run_project_tests','get_weather','read_task_requirements','read_tool_result','read_skill_file','list_skills','get_document_template','plan_document','check_document','read_task_checkpoint','read_evidence','update_plan','need_more_time']);
export const isReadOnlyTool = name => READ_ONLY.has(name);
export function checkpointEvent(previous = {}, event, at = Date.now()) {
  const next = { ...previous, updatedAt:at, inFlight:[...(previous.inFlight || [])], steps:[...(previous.steps || [])], files:[...(previous.files || [])] };
  // 旧版把网页正文放在检查点里；现在证据单独存（src/agent/evidenceStore.js），这里只为兼容旧事件保留
  if (event.type === 'retrieval_evidence') {
    const evidence = event.evidence;
    if (evidence && typeof evidence.key === 'string' && evidence.key.length <= 2000 && Array.isArray(evidence.sources)) {
      const clean = {key:evidence.key, savedAt:Math.min(at,Number(evidence.savedAt)||at), sources:evidence.sources.slice(0,4).filter(s=>s && typeof s.url==='string' && /^https?:\/\//.test(s.url)).map(s=>({url:s.url.slice(0,2000),title:String(s.title||'').slice(0,300),text:String(s.text||'').slice(0,6000)}))};
      next.evidence = [...(previous.evidence || []).filter(x=>x.key!==clean.key),clean].slice(-3);
    }
  } else if (event.type === 'artifact_validation') {
    const value = event.validation || {};
    const item = { path: String(event.path || '').slice(0, 400), format: String(value.format || '').slice(0, 8),
      structure: value.structure, readback: value.readback, render: value.render, errors: Math.max(0, Number(value.errors) || 0), at };
    next.artifacts = [...(previous.artifacts || []).filter(record => record.path !== item.path), item].slice(-16);
  } else if (event.type === 'tool_start') {
    next.inFlight = next.inFlight.filter(x=>x.id!==event.id);
    next.inFlight.push({id:event.id,name:event.name,...(typeof event.args?.path==='string'&&{path:event.args.path}),at});
  } else if (event.type === 'tool_end') {
    next.inFlight = next.inFlight.filter(x=>x.id!==event.id);
    next.steps.push({id:event.id,name:event.name,ok:Boolean(event.ok),at,summary:String(event.output || '').slice(0,500)});
  } else if (event.type === 'file' && !next.files.includes(event.path)) next.files.push(event.path);
  else if (event.type === 'plan') next.plan = event.steps;
  else if (event.type === 'user_note') next.notes = [...(previous.notes || []),String(event.text)];
  else if (event.type === 'task_state') { next.status = event.status; if(event.error) next.error=String(event.error).slice(0,500); }
  return next;
}
export function checkpointNeedsReview(rec = {}) {
  return (rec.inFlight || []).some(x=>!isReadOnlyTool(x.name));
}
export function checkpointRecoveryText(rec = {}) {
  const steps = rec.steps || [];
  const complete = steps.filter(x=>x.ok).map(x=>`${x.name}${x.summary ? '：'+x.summary : ''}`);
  const failed = steps.filter(x=>!x.ok).map(x=>x.name);
  const uncertain = (rec.inFlight || []).map(x=>`${x.name}${x.path ? ' '+x.path : ''}`);
  return [
    '恢复任务时先核对证据，不要从头重做；已成功的外部操作不要重复执行。',
    '用户原始要求：\n'+String(rec.text || ''),
    rec.notes?.length ? '后续补充要求：\n'+rec.notes.join('\n') : '',
    complete.length ? '已成功步骤（需核对文件/结果）：\n'+complete.join('\n') : '',
    failed.length ? '失败步骤（不算完成）：'+failed.join('、') : '',
    uncertain.length ? '退出时仍在执行、结果未知：'+uncertain.join('、')+'。不得自动重放有副作用的操作；先报告不确定性，核实结果后再继续。' : '',
    rec.artifacts?.length ? '产物检查回执（结构、读回和转换不等于视觉验收）：'+rec.artifacts.map(item=>item.path+'：readback='+item.readback+'，render='+item.render+'，errors='+item.errors).join('；') : '',
    rec.files?.length ? '已经生成的文件：'+rec.files.join('、')+'；先检查是否存在且内容正确。' : ''
  ].filter(Boolean).join('\n\n');
}


/** 模型查看检查点只给证据索引，正文由核验内部复用，避免每次把网页全部塞进提示。 */
export function checkpointView(rec) {
  return rec && {...rec, ...(rec.evidence && {evidence:rec.evidence.map(e=>({key:e.key,savedAt:e.savedAt,sources:e.sources.map(({url,title})=>({url,title}))}))})};
}

