import { businessArchitectureLayout } from './architectureLayout.js';
import { architectureView } from './architectureViews.js';
import * as workspace from './workspace.js';
import { diagramDigest } from './diagramExport.js';
import { checkSources } from './diagramSources.js';
import { ARCHITECTURE_KINDS } from './architecturePlan.js';
import { architectureReviewStatus } from './architectureReview.js';
const invalid = (message) => Object.assign(new Error(message), { code: 'ARCHITECTURE_PROJECTION', kind: 'input' });
const includes = (text, value) => String(text).replace(/\s+/g, '').includes(String(value).replace(/\s+/g, ''));
const labels = {
  interface: '用户与展示',
  system: '系统与边界',
  application: '业务应用',
  capability: '共用能力',
  data: '数据资源',
  acquisition: '感知与接入',
  infrastructure: '基础设施',
  security: '贯穿保障'
};
const roleIcons = {
  interface: 'layout-grid',
  system: 'layers',
  application: 'clipboard-check',
  capability: 'network',
  data: 'database',
  acquisition: 'target',
  infrastructure: 'cpu',
  security: 'shield-check'
};

export async function loadArchitecture(path, signal) {
  if (typeof path !== 'string' || !path.endsWith('.architecture.json') || path.length > 400) throw invalid('请提供plan_architecture的真实底稿路径');
  const blob = await workspace.readBlob(path);
  if (blob.size > 1e6) throw invalid('底稿超过1MB，请拆为总体与专题');
  const plan = JSON.parse(await blob.text());
  if (
    plan.version !== 1 ||
    !Array.isArray(plan.entities) ||
    !plan.entities.length ||
    plan.entities.length > 60 ||
    !Array.isArray(plan.relations) ||
    plan.relations.length > 100
  )
    throw invalid('底稿结构无效');
  const reviewPath = path.replace(/\.architecture\.json$/, '.review.json');
  const reportBlob = await workspace.readBlob(reviewPath);
  if (reportBlob.size > 30000) throw invalid('关系审查报告无效');
  const report = JSON.parse(await reportBlob.text());
  const planHash = await diagramDigest(JSON.stringify(plan));
  if (report.planHash !== planHash) throw invalid('底稿已变化，旧审查不能复用；请重新plan_architecture');
  const { materials, checks } = await checkSources(
    (plan.sources || []).map((item) => ({
      path: item.path,
      excerpt: item.excerpt || '',
      ...(item.scope === 'section' && { sectionStart: item.sectionStart, sectionEnd: item.sectionEnd })
    })),
    signal
  );
  for (const saved of plan.materialHashes || []) {
    const actual = materials.find((item) => item.path === saved.path);
    if (!actual || (await diagramDigest(actual.text)) !== saved.hash) throw invalid('原始材料已变化，请重新生成和审查底稿');
  }
  return { plan, report, planHash, reviewPath, path, materials, sourceChecks: checks };
}

/** 不提供版式时给出保守的职责分层；可提供丰富零件版式，但必须逐项通过同一关系校验。 */
export function architectureInput(plan, input) {
  if (input.layers) return { ...structuredClone(input), title: input.title || plan.title };
  if (plan.layoutProfile === 'business-v2') return businessArchitectureLayout(plan, input);
  const layers = ['interface', 'system', 'application', 'capability', 'data', 'acquisition', 'infrastructure', 'security']
    .map((role) => ({
      title: labels[role],
      role,
      kind: 'cards',
      nodes: plan.entities
        .filter((item) => item.kind === role)
        .map((item, index) => ({
          id: item.id,
          title: item.title,
          detail: item.responsibility,
          icon: roleIcons[role],
          ...(role === 'application' && { accent: ['orange', 'blue', 'green'][index % 3] })
        }))
    }))
    .filter((layer) => layer.nodes.length);
  return { ...input, title: input.title || plan.title, layers, direction: 'top-down', design: { theme: 'gov-blue', ...(input.design || {}) } };
}

/** 所有对象可追溯；所属用容器表达，其余关系由底稿生成，调用者不能删箭头以绕过验收。 */
export function projectArchitecture(bundle, input) {
  const { plan, report } = bundle;
  if (report.structure !== 'passed' || report.semantic === 'failed') throw Object.assign(invalid('业务关系审查未通过，请读取' + bundle.reviewPath + '修正底稿'), {
    diagnostics: [{ stage: 'review', field: 'architecturePath', action: '读取' + bundle.reviewPath + '，按审查意见修正底稿，不能绕过或反复审到通过' }],
    reviewPath: bundle.reviewPath
  });
  if (report.semantic !== 'passed' && !input.draft) {
    const state = architectureReviewStatus(report, bundle.reviewPath);
    throw Object.assign(invalid('语义审查未完成，不能交付正式架构图；' + state.reviewNote + '；' + state.nextAction), {
      diagnostics: [{ stage: 'review', field: 'architecturePath', action: state.nextAction }],
      reviewPath: bundle.reviewPath,
      reviewErrorCode: state.reviewErrorCode
    });
  }
  const result = architectureInput(plan, input);
  const byId = new Map(plan.entities.map((item) => [item.id, item]));
  const containers = plan.entities.filter((item) => plan.relations.some((link) => link.type === 'contains' && link.from === item.id));
  const number = (id) => 'C' + (containers.findIndex((item) => item.id === id) + 1);
  const owners = new Map(plan.relations.filter((link) => link.type === 'contains').map((link) => [link.to, link.from]));
  const badge = (node, token) => {
    const layer = result.layers.find((item) => item.nodes.includes(node));
    const field = layer.kind === 'columns' ? 'subtitle' : layer.kind === 'band' ? 'detail' : 'badge';
    if (layer.kind === 'grid') throw invalid('网格对象需要在正确容器内表达所属，不能静默丢失归属标记');
    const value = [node[field], token].filter(Boolean).join('｜');
    const limit = field === 'subtitle' ? 48 : field === 'detail' ? 160 : 28;
    if (value.length > limit) throw invalid('所属标记与原文字超过容量，请调整版式而非截断');
    node[field] = value;
  };
  const drawn = new Set();
  const grouped = new Set();
  const belongs = (child, parent, visited = new Set()) => {
    if (visited.has(child)) return false;
    visited.add(child);
    return plan.relations.some((link) => link.type === 'contains' && link.to === child && (link.from === parent || belongs(link.from, parent, visited)));
  };
  for (const layer of result.layers) {
    const matches = layer.group ? containers.filter((item) => item.title === layer.group) : [];
    if (matches.length > 1) throw invalid('同名容器无法确定所属，请在底稿使用有业务限定的名称');
    const group = matches[0];
    if (layer.group && !group) throw invalid('平台容器必须对应底稿中的确切系统名称');
    if (group) {
      grouped.add(group.id);
      layer.groupEntityId = group.id;
      layer.group = group.title + '（' + number(group.id) + (owners.has(group.id) ? '，归属' + number(owners.get(group.id)) : '') + '）';
    }
    const kinds = new Set(layer.nodes.map((node) => byId.get(node.id)?.kind));
    const role = layer.role || (kinds.size === 1 ? [...kinds][0] : undefined);
    if (!ARCHITECTURE_KINDS.includes(role)) throw invalid('每层必须声明明确职责role，不能混放数据、业务或基础设施');
    const headings = {
      interface: ['用户与展示', '界面展示', '用户入口'],
      system: ['系统与边界', '系统组成', '建设系统'],
      application: ['业务应用', '业务流程'],
      capability: ['共用能力', '平台能力', '能力支撑'],
      data: ['数据资源', '数据层', '数据底座'],
      acquisition: ['感知与接入', '感知接入', '设备接入', '感知层'],
      infrastructure: ['基础设施', '运行资源', '部署支撑'],
      security: ['贯穿保障', '安全保障', '标准规范']
    };
    if (!headings[role].some((prefix) => layer.title.startsWith(prefix)))
      throw invalid('层标题与职责不匹配，请以' + labels[role] + '开头，可用｜追加原文分组名；不强迫凑齐所有层');
    layer.role = role;
    for (const node of layer.nodes) {
      const entity = byId.get(node.id);
      if (!entity || drawn.has(node.id) || entity.kind !== role) throw invalid('对象重复、不在底稿中或层职责不匹配：' + node.id);
      if (!includes(node.title, entity.title)) throw invalid('图中对象名称必须保留底稿名称：' + entity.title);
      // 网格只表达组成，职责留在底稿；有正文的卡片必须保留已审职责，不允许排版时另写一套业务。
      if (layer.kind !== 'grid') {
        const visible = [node.detail, node.subtitle, ...(node.bullets || []).map((item) => item.text)].filter(Boolean).join(' ');
        if (!includes(visible, entity.responsibility)) {
          if (!node.detail) node.detail = entity.responsibility;
          else throw invalid('卡片说明必须保留已审职责，请先修底稿再审或沿用原职责：' + entity.title);
        }
      }
      if (group && !belongs(entity.id, group.id)) throw invalid('平台容器归属与底稿不一致：' + entity.title);
      drawn.add(node.id);
    }
  }
  for (const item of plan.entities) if (!drawn.has(item.id) && !grouped.has(item.id)) throw invalid('底稿对象未进入图中：' + item.title);
  const edges = plan.relations
    .map((link, index) => ({ ...link, relationIndex: index }))
    .filter((link) => link.type !== 'contains')
    .map((link, index) => {
      if (!drawn.has(link.from) || !drawn.has(link.to)) throw invalid('系统级关系需呈现独立对象或细化到明确能力/业务端点，不可连接不存在的容器端口');
      return {
        from: link.from,
        to: link.to,
        type: link.type,
        meaning: link.meaning,
        relationId: 'relation-' + link.relationIndex,
        ...(link.type === 'workflow' && { label: link.meaning.length <= 12 ? link.meaning : '业务流' })
      };
    });
  for (const container of containers) {
    const node = result.layers.flatMap((layer) => layer.nodes).find((item) => item.id === container.id);
    if (node) badge(node, '对象 ' + number(container.id));
  }
  for (const link of plan.relations.filter((item) => item.type === 'contains')) {
    const layer = result.layers.find((item) => item.nodes.some((node) => node.id === link.to));
    const target = layer?.nodes.find((node) => node.id === link.to);
    if (target && layer.groupEntityId !== link.from) badge(target, '归属 ' + number(link.from));
    else if (!target && !grouped.has(link.to)) throw invalid('所属对象缺失');
  }
  if (input.edges?.length) {
    const actual = new Set(input.edges.map((edge) => [edge.from, edge.to, edge.type || ''].join('\u0000')));
    if (actual.size !== edges.length || edges.some((edge) => !actual.has([edge.from, edge.to, edge.type].join('\u0000'))))
      throw invalid('调用者连线与底稿不一致；不要自行删除、增加或反转业务关系');
  }
  if (input.draft) for (const layer of result.layers) for (const node of layer.nodes) delete node.accent;
  return architectureView(plan, {
    ...result,
    edges,
    semanticRouting: true,
    formats: input.draft ? ['svg', 'png'] : input.formats,
    design: input.draft ? { ...result.design, theme: 'charcoal' } : result.design
  });
}
