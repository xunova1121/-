/** 检查点只记录证据，不把“可能执行过”当成可重放的命令。 */
const READ_ONLY = new Set(['read_file','list_files','search_files','search_file_content','web_search','fetch_url','kb_search','recall','get_current_time','get_weather','read_task_requirements','read_tool_result','read_skill_file','list_skills','update_plan']);
export const isReadOnlyTool = name => READ_ONLY.has(name);
export function checkpointEvent(previous = {}, event, at = Date.now()) {
  const next = { ...previous, updatedAt:at, inFlight:[...(previous.inFlight || [])], steps:[...(previous.steps || [])], files:[...(previous.files || [])] };
  if (event.type === 'tool_start') {
    next.inFlight = next.inFlight.filter(x=>x.id!==event.id);
    next.inFlight.push({id:event.id,name:event.name,...(typeof event.args?.path==='string'&&{path:event.args.path}),at});
  } else if (event.type === 'tool_end') {
    next.inFlight = next.inFlight.filter(x=>x.id!==event.id);
    next.steps.push({id:event.id,name:event.name,ok:Boolean(event.ok),at,summary:String(event.output || '').slice(0,500)});
  } else if (event.type === 'file' && !next.files.includes(event.path)) next.files.push(event.path);
  else if (event.type === 'plan') next.plan = event.steps;
  else if (event.type === 'user_note') next.notes = [...(previous.notes || []),String(event.text)];
  else if (event.type === 'task_state') next.status = event.status;
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
    rec.files?.length ? '已经生成的文件：'+rec.files.join('、')+'；先检查是否存在且内容正确。' : ''
  ].filter(Boolean).join('\n\n');
}
