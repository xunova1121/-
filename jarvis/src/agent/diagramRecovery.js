/** 单轮图形恢复：同目标同阶段最多3次确定性失败，总计最多6次；不保存正文/参数。 */
const TOOLS = new Set(['plan_architecture', 'create_diagram', 'export_diagram', 'render_diagram']);
const stages = { material: '材料读取', source: '来源定位', excerpt: '原文摘录', fact: '事实依据', inclusion: '事实入图', arguments: '参数结构' };
export const isDiagramTool = name => TOOLS.has(name);
export function diagramFailureDetails(error) {
  const details = error?.diagnostics;
  if (!Array.isArray(details)) return [];
  return details.slice(0, 8).map(item => ({ field: String(item.field || '').slice(0, 120), stage: String(item.stage || '').slice(0, 30), action: String(item.action || '').slice(0, 180) }));
}
export function createDiagramRecovery() {
  const counts = new Map();
  let total = 0;
  let stopped = false;
  return {
    reset() { counts.clear(); total = 0; stopped = false; },
    record(name, args, error) {
      if (!TOOLS.has(name) || stopped || error?.name === 'AbortError' || ['RETRIEVAL_BUDGET','NOT_APPROVED'].includes(error?.code)) return null;
      if (!error) {
        if (name === 'create_diagram' || name === 'plan_architecture') {
          const target = String(args?.architecturePath || args?.path || '本轮底稿').replace(/\.(svg|png|pdf|pptx|diagram\.json)$/i, '').slice(0, 400);
          for (const key of counts.keys()) if (key.startsWith(target + '\u0000')) counts.delete(key);
        }
        return null;
      }
      if (error.kind !== 'input' || !/^(?:DIAGRAM_|ARCHITECTURE_|SVG_)/.test(error.code || '')) return null;
      const stage = diagramFailureDetails(error)[0]?.stage || 'arguments';
      const target = String(args?.architecturePath || args?.path || '本轮底稿').replace(/\.(svg|png|pdf|pptx|diagram\.json)$/i, '').slice(0, 400);
      const key = target + '\u0000' + stage;
      const failures = (counts.get(key) || 0) + 1;
      counts.set(key, failures);
      if (counts.size > 24) counts.delete(counts.keys().next().value);
      total++;
      stopped = error.code === 'DIAGRAM_DUPLICATE_CALL' || failures >= 3 || total >= 6;
      return { stopped, stage, failures, total, message: stopped ? `图形流程在${stages[stage] || '参数或材料校验'}阶段连续未通过，已停止本轮重复执行。${String(error.message).slice(0, 300)}。本轮失败操作不作为完成；已有文件保留。` : `请按错误字段定点修复后再调用，不要重做无关步骤；同目标同阶段还可修复${3-failures}次。` };
    }
  };
}
