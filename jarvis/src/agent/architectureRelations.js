const ranking = { infrastructure: 0, acquisition: 1, data: 2, capability: 3, application: 4, interface: 5 };
const intentTypes = { usage: 'dataflow', presentation: 'dataflow', hosting: 'supports' };
const applicationKinds = new Set(['application', 'capability', 'system']);
const hostedKinds = new Set(['application', 'capability', 'system', 'data', 'interface']);
const ports = values => Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim() && [...value].length <= 100).slice(0, 8) : [];
const shared = (from, to) => [...new Set(ports(from?.outputs).filter(value => ports(to?.inputs).includes(value)))];
const entityIndex = entities => new Map(entities.map((entity, index) => [typeof entity?.id === 'string' ? entity.id.trim() : '', { entity, index }]));
const endpoint = (indexed, includePorts) => {
  if (!indexed?.entity) return null;
  const item = indexed.entity;
  return {
    id: [...String(item.id || '')].slice(0, 64).join(''), kind: String(item.kind || '').slice(0, 30), entityIndex: indexed.index,
    ...(includePorts ? { inputs: ports(item.inputs), outputs: ports(item.outputs) } : { portsInPreviousContent: true })
  };
};
function context(relation, indexed, includePorts = true) {
  const from = indexed.get(relation?.from), to = indexed.get(relation?.to);
  const forward = shared(from?.entity, to?.entity), reverse = shared(to?.entity, from?.entity);
  const candidates = [];
  if (from?.entity?.kind === 'interface' && applicationKinds.has(to?.entity?.kind) && forward.length)
    candidates.push({ intent: 'usage', from: relation.from, to: relation.to, dataOptions: forward, candidateOnly: true });
  if (to?.entity?.kind === 'interface' && applicationKinds.has(from?.entity?.kind) && forward.length)
    candidates.push({ intent: 'presentation', from: relation.from, to: relation.to, dataOptions: forward, candidateOnly: true });
  if (from?.entity?.kind === 'interface' && applicationKinds.has(to?.entity?.kind) && reverse.length)
    candidates.push({ intent: 'presentation', from: relation.to, to: relation.from, dataOptions: reverse, candidateOnly: true });
  return {
    from: endpoint(from, includePorts), to: endpoint(to, includePorts), repairCandidates: candidates,
    ...(includePorts && { portMismatch: {
      producedButNotAccepted: ports(from?.entity?.outputs).filter(value => !ports(to?.entity?.inputs).includes(value)),
      acceptedButNotProduced: ports(to?.entity?.inputs).filter(value => !ports(from?.entity?.outputs).includes(value)),
      candidateOnly: true
    } })
  };
}
function failure(message, diagnostics) {
  return Object.assign(new Error(message), { code: 'ARCHITECTURE_RELATION', kind: 'input', diagnostics });
}
function semanticError(row, index, indexed, field, message, action) {
  return { field: 'relations[' + index + '].' + field, stage: 'review', message, action, ...context(row, indexed, index < 32) };
}
/** 内容层意图编译为正式关系；只接受已有端口，不根据名称/说明猜类型、倒箭头或补数据。 */
export function compileArchitectureRelations(rows, entities) {
  if (!Array.isArray(rows) || rows.length > 100 || !Array.isArray(entities) || entities.length > 60)
    throw failure('关系语义输入超限或无效', [{ field: 'relations', stage: 'arguments', action: '保留原60对象/100关系容量，不能截断条目' }]);
  const indexed = entityIndex(entities), diagnostics = [];
  const result = rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      diagnostics.push(semanticError(row, index, indexed, '', '关系必须是对象', '沿用该关系的真实端点及依据，不删除问题关系'));
      return null;
    }
    const hasIntent = Object.hasOwn(row, 'intent'), hasData = Object.hasOwn(row, 'data');
    const from = indexed.get(row.from)?.entity, to = indexed.get(row.to)?.entity;
    const add = (field, message, action) => diagnostics.push(semanticError(row, index, indexed, field, message, action));
    if (row.type === 'integration') {
      if (hasIntent || hasData) {
        add(hasIntent ? 'intent' : 'data', 'integration只表示原文证明的应用级无向集成，不能混入intent或data', '真实有向传输沿用dataflow与精确端口；没有方向/数据的集成不冒称usage、presentation或hosting');
        return null;
      }
      if (!from || !to || row.from === row.to || !applicationKinds.has(from.kind) || !applicationKinds.has(to.kind)) {
        add('from/to', 'integration必须连接两个不同的system/application/capability对象', '保留原文实际应用级端点；设备、界面、数据与基础设施不能用integration绕过方向/端口规则');
        return null;
      }
      return { ...row };
    }
    if (!hasIntent && !hasData) return { ...row };
    if (!from || !to || row.from === row.to) {
      add('from/to', '关系意图必须连接两个不同的已登记对象', '使用当前对象id，不猜新id，不把流程步骤都连到同一模块');
      return null;
    }
    let type = row.type;
    if (hasIntent) {
      if (!Object.hasOwn(intentTypes, row.intent)) {
        add('intent', '关系intent只能是usage、presentation或hosting', '用户操作用usage，业务向界面输出用presentation，真实运行承载用hosting；一般关系沿用原type');
        return null;
      }
      type = intentTypes[row.intent];
      if (row.type !== undefined && row.type !== type && !(type === 'dataflow' && row.type === 'supports')) {
        add('type', '关系type与明确intent冲突', '不把contains/workflow/feedback改称交互；按本条真实业务目的选择一种关系');
        return null;
      }
      const allowed = row.intent === 'usage'
        ? from.kind === 'interface' && applicationKinds.has(to.kind)
        : row.intent === 'presentation'
          ? applicationKinds.has(from.kind) && to.kind === 'interface'
          : ['infrastructure', 'acquisition'].includes(from.kind) && hostedKinds.has(to.kind);
      if (!allowed) {
        add('intent', '明确intent的端点职责不匹配：' + from.kind + '→' + to.kind, '核对真实职责和原文；呈现应由业务/能力/系统指向interface，物理设备与移动界面需要分别建模，不能仅改说明或盲目倒箭头');
        return null;
      }
    }
    if (type === 'dataflow') {
      if (typeof row.data !== 'string' || !row.data.trim() || [...row.data].length > 100 || !shared(from, to).includes(row.data)) {
        add('data', '交互/呈现的数据必须同时出现在发送方outputs与接收方inputs', 'data逐字采用现有共同端口；若原文支持但端口缺失，先修对应对象端口，不凭名称造数据或自动反转关系');
        return null;
      }
    } else if (hasData) {
      add('data', 'hosting/资源支撑不承载data字段', '运行承载沿用supports；数据传输另列有真实两端端口的数据流，不混为一条关系');
      return null;
    }
    const { intent, data, ...item } = row;
    return { ...item, type };
  });
  if (diagnostics.length) throw failure('关系语义共' + diagnostics.length + '项未通过，需修改明确的类型/端点/端口字段，不能只改meaning', diagnostics);
  return result;
}
/** 原确定性规则保持，只把错误具体到实际关系，不携带会撑大30KB审查报告的端口副本。 */
export function architectureRelationIssues(relation, index, from, to) {
  const issues = [], target = 'relation:' + index;
  const suffix = '（' + from.id + ':' + from.kind + '→' + to.id + ':' + to.kind + '）';
  const add = (kind, detail) => issues.push({ target, kind, detail: (detail + suffix).slice(0, 240) });
  if (relation.type === 'supports' && ranking[from.kind] !== undefined && ranking[to.kind] !== undefined && ranking[from.kind] > ranking[to.kind])
    add('dependency', '上层业务支撑下层资源，方向或关系类型可能颠倒；请核实职责和原文；用户交互/界面呈现/运行承载须分开，不要仅改meaning');
  if (relation.type === 'workflow' && (from.kind !== 'application' || to.kind !== 'application'))
    add('classification', '业务流程应连接业务活动；数据传输和能力调用请另列关系');
  if (relation.type === 'dataflow' && !shared(from, to).length)
    add('flow', '数据流两端没有相同的已声明输出/输入，请核实传输对象而不是仅写连通');
  if (relation.type === 'integration' && (from.id === to.id || !applicationKinds.has(from.kind) || !applicationKinds.has(to.kind)))
    add('classification', '无向应用级集成只连接不同的system/application/capability对象，不能代替界面交互、设备接入或数据流');
  return issues;
}
/** 详细上下文只用于独立纠错文件，不能原样塞入50KB任务状态或30KB正式审查报告。 */
export function architectureRelationDiagnostics(plan, issues) {
  const indexed = entityIndex(plan.entities);
  return issues.map((issue, index) => {
    const match = /^relation:(\d+)$/.exec(issue.target), position = match ? Number(match[1]) : null;
    const relation = position !== null ? plan.relations[position] : null;
    return {
      field: relation ? 'relations[' + position + ']' : issue.target, stage: 'review',
      message: issue.detail, action: issue.detail,
      ...(relation && { relation: { from: relation.from, to: relation.to, type: relation.type }, ...context(relation, indexed, index < 32) })
    };
  });
}
