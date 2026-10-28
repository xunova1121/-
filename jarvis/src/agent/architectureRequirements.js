const invalid = (field, message) => Object.assign(new Error(message), {
  code: 'ARCHITECTURE_CONTENT_SCHEMA', kind: 'input',
  diagnostics: [{ field, stage: 'arguments', action: '程序按每组最多12个对象拆分同一原文需求，保留全部关联；超过总80条时明确拆分任务，不删关联或裁掉原文' }]
});

/** 同一采购条款可涉及全部60个对象；只拆映射，不改原文、证据、ID或原正式行12/总80上限。 */
export function splitArchitectureRequirements(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 80) throw invalid('requirements', '原始需求需1～80条');
  const requirements = [], splits = [], mapping = [];
  for (const [sourceIndex, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !Array.isArray(row.entities) || !row.entities.length || row.entities.length > 60 ||
      row.entities.some(id => typeof id !== 'string' || !id.trim() || [...id].length > 64))
      throw invalid('requirements[' + sourceIndex + '].entities', '每条原始需求需关联1～60个合法对象ID');
    const entityIds = [...new Set(row.entities)];
    const count = Math.ceil(entityIds.length / 12);
    if (requirements.length + count > 80) throw invalid('requirements', '需求无损拆分后超过80条，不能删除关联来凑数');
    const outputIndices = [];
    for (let index = 0; index < entityIds.length; index += 12) {
      outputIndices.push(requirements.length);
      requirements.push({ ...structuredClone(row), entities: entityIds.slice(index, index + 12) });
    }
    const entry = { sourceIndex, outputIndices, entityIds };
    mapping.push(entry);
    if (count > 1) splits.push(entry);
  }
  return { requirements, splits, mapping };
}
