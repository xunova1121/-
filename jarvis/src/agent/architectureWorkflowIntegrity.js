import * as workspace from './workspace.js';
import { diagramDigest } from './diagramExport.js';

const invalid = (message) => Object.assign(new Error(message), {
  code: 'ARCHITECTURE_WORKFLOW_INTEGRITY', kind: 'input', terminal: true, integrityFailure: true,
  diagnostics: [{ field: 'contentPath', stage: 'integrity', action: '已保存内容与任务摘要不一致，停止模型收费和导出；保留原始回复与诊断，新建任务重新读取原件，不采纳外部删改的状态' }]
});
/** 比较本轮整理时的材料快照，不能在等待模型期间悄悄采用新版原件。 */
export async function assertWorkflowMaterials(materials, expectedHash) {
  if (expectedHash && await diagramDigest(JSON.stringify(materials)) !== expectedHash) throw Object.assign(invalid('原始材料在业务整理等待期间变化，不能把旧内容绑定到新原件'), {
    materialIntegrity: true,
    diagnostics: [{ field: 'materialHash', stage: 'integrity', action: '停止当前任务，保留原始回复和已有文件；重新读取当前原件并新建任务，不复用旧材料编号' }]
  });
}
/** 通用文件编辑、目录同步或外部程序都不能把未经校验的新稿偷偷作为下一轮基线。 */
export async function loadWorkflowContent(state, jobPath) {
  if (!state.contentPath) return null;
  const base = jobPath.replace(/\.json$/, '.content');
  if ((state.contentPath !== base + '.json' && !(state.contentPath.startsWith(base + '.') && /^[\w-]+\.json$/.test(state.contentPath.slice(base.length + 1)))) || !state.contentHash)
    throw invalid('架构内容缺少可信版本摘要，不能续接未绑定的旧内容');
  const blob = await workspace.readBlob(state.contentPath);
  if (blob.size > 320000) throw invalid('架构业务内容超过320KB');
  const text = await blob.text();
  if (await diagramDigest(text) !== state.contentHash) throw invalid('架构业务内容在受控修订以外发生变化');
  try { return JSON.parse(text); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; throw invalid('已保存架构业务内容不是有效JSON'); }
}

export async function saveWorkflowContent(state, jobPath, content, adapters, audit, execution) {
  // 每版内容不可变；状态保存中断时仍可沿用上一版，避免两个文件更新一半造成旧摘要指向新正文。
  const contentPath = jobPath.replace(/\.json$/, '.content.' + state.attempts + '-' + crypto.randomUUID() + '.json');
  if (audit?.length) {
    const data = JSON.stringify({ attempt: state.attempts, beforeHash: state.contentHash, corrections: audit });
    if (data.length > 1000000) throw invalid('受控修订审计超过1MB，停止而非截掉变更证据');
    const path = jobPath.replace('架构任务/', '架构诊断/').replace(/\.json$/, '.audit-' + state.attempts + '-' + crypto.randomUUID() + '.json');
    await workspace.writeArchitectureState(path, data, { signal: execution.signal });
    state.correctionAudits = [...(state.correctionAudits || []), { path, hash: await diagramDigest(data) }].slice(-3);
    await execution.checkpoint?.({ type: 'file', path });
  }
  const text = JSON.stringify(content);
  await workspace.writeArchitectureState(contentPath, text, { signal: execution.signal });
  state.contentPath = contentPath;
  state.contentHash = await diagramDigest(text);
  state.contentAdapters = adapters;
}

/** 形式底稿拆行只改变映射位置，修复仍定位到模型持有的原始条款。 */
export function mapWorkflowDiagnostics(value, sourceIndices) {
  if (!Array.isArray(sourceIndices)) return value;
  const map = (row) => {
    if (!row || typeof row !== 'object') return row;
    const next = { ...row };
    const field = /^requirements\[(\d+)\](.*)$/.exec(row.field || '');
    const target = /^requirement:(\d+)$/.exec(row.target || '');
    if (field && !row.formalField && Number.isInteger(sourceIndices[Number(field[1])])) {
      next.formalField = row.field;
      next.field = 'requirements[' + sourceIndices[Number(field[1])] + ']' + field[2];
    }
    if (target && !row.formalTarget && Number.isInteger(sourceIndices[Number(target[1])])) {
      next.formalTarget = row.target;
      next.target = 'requirement:' + sourceIndices[Number(target[1])];
    }
    return next;
  };
  if (Array.isArray(value)) return value.map(map);
  if (!value || typeof value !== 'object') return value;
  return { ...value, ...(value.diagnostics && { diagnostics: value.diagnostics.map(map) }), ...(value.issues && { issues: value.issues.map(map) }) };
}
