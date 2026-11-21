/** create_flowchart：流程图/泳道图/思维导图的唯一制作入口（布局与导出见 flowchart.js）。 */
import * as ws from './workspace.js';
import { normalizeFlowchart, layoutFlowchart, composeFlowchartSvg, composeFlowchartPptx, checkFlowchart, FLOW_TYPES } from './flowchart.js';
import { renderVisualScene } from './visualSceneRaster.js';
import { throwControl } from '../core/networkRequest.js';

const str = { type: 'string' };
export const FLOWCHART_DESCRIPTION = '先想清楚要表达什么，能删就删：一张图最好不超过9个节点、12条线，超了拆成总览加分图；只给1～2个最关键步骤加focus。画流程图、业务流程图、审批流程、泳道图（跨部门/跨角色流程）、思维导图时用这个；架构图（分层系统结构）用create_diagram。只给节点、连线和泳道，坐标由程序算：判断节点（type=decision）至少两个出口，出口label写条件（是/否、通过/退回）；回头的线（退回、循环）自动从侧面虚线绕开。泳道图给lanes并给每个节点写lane。节点文字≤40字、连线文字≤12字，超了会报错要求精简，不截字。交付PNG、可编辑SVG、原生可编辑PPTX（PowerPoint自带流程图形状）和.flow.json源稿；改图用source_path加完整的nodes/edges/lanes重出。回执里crossings是连线交叉数、checks是结构问题，交付时如实说明。时序图、甘特图、ER图等用create_chart。';

export function createFlowchartTool(ctx = {}) {
  return {
    name: 'create_flowchart',
    description: FLOWCHART_DESCRIPTION,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', description: '图标题，≤40字' },
        kind: { type: 'string', enum: ['flow', 'swimlane', 'mindmap', 'tree', 'org', 'state', 'steps', 'loop'], description: 'flow流程图；swimlane泳道图（需lanes）；mindmap思维导图；tree树形分解；org组织架构（无箭头）；state状态图（连线label写触发条件）；steps步骤图（带序号，可不给edges）；loop循环/飞轮（3–8个环节，可不给edges，center写中心主题）' },
        center: { type: 'string', description: 'loop循环图中心文字，≤12字' },
        direction: { type: 'string', enum: ['TB', 'LR'], description: 'TB自上而下（默认）；LR从左到右（步骤多、思维导图用）' },
        theme: { type: 'string', enum: ['blue', 'gray', 'green'], description: '配色，默认blue' },
        lanes: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, properties: { id: str, title: { type: 'string', description: '角色/部门，≤16字' } }, required: ['id', 'title'] } },
        nodes: { type: 'array', maxItems: 60, items: { type: 'object', additionalProperties: false, properties: {
          id: str, text: { type: 'string', description: '≤40字' }, type: { type: 'string', enum: FLOW_TYPES, description: 'start开始、end结束、process步骤、decision判断、io输入输出、document文档、subprocess子流程、data数据' }, lane: { type: 'string', description: '泳道id' }, focus: { type: 'boolean', description: '重点步骤，最多2个，用强调色描边' } }, required: ['id', 'text'] } },
        edges: { type: 'array', maxItems: 120, items: { type: 'object', additionalProperties: false, properties: { from: str, to: str, label: { type: 'string', description: '≤12字，判断出口必填' } }, required: ['from', 'to'] } },
        source_path: { type: 'string', description: '修改已有.flow.json；本次给的字段整体替换原字段' },
        path: { type: 'string', description: '输出路径（不含或含扩展名），如 流程图/请假审批' }
      },
      required: []
    },
    run: async (input = {}, { signal, progress } = {}) => {
      throwControl(null, signal);
      let raw = input;
      if (input.source_path) {
        if (!/\.flow\.json$/i.test(input.source_path)) throw Object.assign(new Error('修改流程图请给.flow.json源稿'), { code: 'FLOWCHART_INPUT', kind: 'input' });
        let previous;
        try { previous = JSON.parse(await (await ws.readBlob(input.source_path)).text()); } catch { throw Object.assign(new Error('流程图源稿读取失败或不是有效JSON'), { code: 'FLOWCHART_INPUT', kind: 'input' }); }
        if (previous?.kind !== 'flowchart' || previous.version !== 1) throw Object.assign(new Error('不是支持的流程图源稿'), { code: 'FLOWCHART_INPUT', kind: 'input' });
        raw = { ...previous, kind: input.kind ?? previous.flowKind, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && !['source_path', 'path', 'kind'].includes(k))) };
      }
      const flow = normalizeFlowchart(raw);
      progress?.('正在排流程图：分层、减少交叉、直角连线…');
      const layout = layoutFlowchart(flow);
      if (layout.width * layout.height > 40e6) throw Object.assign(new Error('流程图过大，请拆成总览图和分图'), { code: 'FLOWCHART_INPUT', kind: 'input' });
      const svg = composeFlowchartSvg(flow, layout);
      const checks = checkFlowchart(flow, layout);
      const base = await outputBase(input.path || input.source_path?.replace(/\.flow\.json$/i, '') || `流程图/${flow.title}`, signal);
      const files = [];
      const save = async (ext, blob, extra = {}) => {
        const saved = await ws.write(`${base}.${ext}`, blob);
        const back = await ws.readBlob(saved.path);
        if (back.size !== blob.size) throw Object.assign(new Error('写入读回不一致'), { code: 'FLOWCHART_READBACK' });
        ctx.onFileChanged?.(saved.path);
        files.push({ format: ext.replace(/^flow\./, ''), path: saved.path, readback: 'passed', ...extra });
        return saved.path;
      };
      await save('flow.json', new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' }));
      await save('svg', new Blob([svg], { type: 'image/svg+xml' }));
      const errors = [];
      let fontCheck = 'not_checked';
      try {
        const rendered = await (ctx.renderVisualScene || renderVisualScene)(svg, { signal });
        fontCheck = rendered.fontCheck?.status === 'passed' ? 'passed' : 'not_checked';
        const path = await save('png', rendered.blob, { render: 'passed' });
        ctx.onImage?.(URL.createObjectURL(rendered.blob), path);
      } catch (error) {
        throwControl(error, signal);
        errors.push({ code: 'FLOWCHART_RENDER_FAILED', message: 'PNG渲染未完成；SVG和源稿已保留' });
      }
      try { await save('pptx', await composeFlowchartPptx(flow, layout)); }
      catch (error) { throwControl(error, signal); errors.push({ code: 'FLOWCHART_PPTX_FAILED', message: 'PPTX生成未完成' }); }
      const png = files.find(f => f.format === 'png');
      return JSON.stringify({
        kind: 'flowchart', status: png && !errors.length ? (checks.issues.length ? 'needs_review' : 'complete') : 'partial',
        title: flow.title, flowKind: flow.flowKind, direction: flow.direction, width: layout.width, height: layout.height,
        nodes: flow.nodes.length, edges: flow.edges.length, lanes: flow.lanes.length, files, primaryPath: png?.path || null, sourcePath: files[0].path,
        checks: { status: checks.status, issues: checks.issues, advice: checks.advice, crossings: checks.crossings, backEdges: checks.backEdges }, fontCheck, visual: 'not_checked', errors,
        notes: ['坐标、连线由程序计算；文字未删减', checks.crossings ? `有${checks.crossings}处连线交叉，可调整节点顺序或拆图` : '连线无交叉', '未做看图审美核验，交付时不能说视觉已验收']
      });
    }
  };
}

async function outputBase(path, signal) {
  const clean = String(path).replace(/\.(?:flow\.json|png|svg|pptx)$/i, '').replace(/[\\:*?"<>|\u0000-\u001f]+/g, '').slice(0, 200) || '流程图/流程图';
  for (const base of [clean, `${clean}-${Date.now().toString(36)}`]) {
    throwControl(null, signal);
    const taken = await Promise.all(['flow.json', 'png', 'svg', 'pptx'].map(ext => ws.exists(`${base}.${ext}`)));
    if (!taken.some(Boolean)) return base;
  }
  return `${clean}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
}
