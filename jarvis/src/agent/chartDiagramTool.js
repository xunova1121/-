/** create_chart：数据图表、时间图、表格型图示和结构图的统一入口（排版见 chartData/chartBoards/chartStructure）。 */
import * as ws from './workspace.js';
import { composeSceneSvg, composeScenePptx, themeOf, sceneError } from './chartScene.js';
import { DATA_CHARTS } from './chartData.js';
import { BOARD_CHARTS } from './chartBoards.js';
import { STRUCTURE_CHARTS } from './chartStructure.js';
import { renderVisualScene } from './visualSceneRaster.js';
import { throwControl } from '../core/networkRequest.js';

export const CHART_TYPES = { ...DATA_CHARTS, ...BOARD_CHARTS, ...STRUCTURE_CHARTS };
/** 每种图需要的 data 字段（写进工具说明，模型照着填） */
export const CHART_SHAPES = {
  bar: 'categories[],series[{name,values[]}],unit — 分类对比', line: 'categories[],series[{name,values[]}],unit — 随时间的趋势', pie: 'items[{label,value}],donut?,unit — 占比（≤10项）',
  scatter: 'points[{label?,x,y,size?}],xLabel,yLabel — 两个指标的关系/气泡', radar: 'axes[],series[{name,values[]}],max — 多维评分对比', heatmap: 'rows[],columns[],values[[...]],unit — 交叉表深浅',
  treemap: 'items[{label,value}],unit — 构成大小', waterfall: 'start{label,value},steps[{label,value}],endLabel,unit — 从期初到期末的增减', funnel: 'stages[{label,value}],unit — 转化漏斗',
  pyramid: 'levels[{label,note?}]（从塔尖到塔底）— 层级', venn: 'sets[{label,note?}]（2–3个）,overlap — 交集', sankey: 'nodes[{id,label}],links[{from,to,value}],unit — 流量去向',
  quadrant: 'xAxis{low,high,label},yAxis{low,high,label},quadrants[右上,左上,左下,右下],items[{label,x,y(0–1),focus?}] — 两维定位', gantt: 'tasks[{label,start,end,group?,milestone?,progress?,focus?}],today? 日期写2026-03-15，精确到时刻写2026-11-17 19:35（两天内自动按小时排）— 项目排期/当天日程',
  timeline: 'events[{date,label,note?,focus?}] — 大事记', kanban: 'columns[{title,limit?,cards[{text,tag?,blocked?}]}] — 任务看板', matrix: 'rows[],columns[],cells[[yes/partial/no或短文字]] — 权限/功能对照',
  journey: 'stages[],rows[{label,cells[]}],emotion[-2..2]? — 用户旅程', blueprint: 'stages[],customer[],frontstage[],backstage[],support?[] — 服务蓝图（自动画可见线）', storymap: 'backbone[],releases[{label,items[[...]]}] — 故事地图',
  layers: 'layers[{title,items[],focus?}]（从上到下）— 分层堆叠', nested: 'root{title,note?,children[...]}（最多3层）— 包含/范围', sequence: 'participants[{id,label}],messages[{from,to,text,reply?,note?}] — 时序/交互顺序',
  er: 'entities[{id,title,fields[{name,type?,key?:PK/FK}]}],relations[{from,to,label?}] — 数据库表结构', uml: 'classes[{id,title,fields[],methods[]}],relations[{from,to,type:inherit/compose/depend/associate,label?}] — 类图',
  fishbone: 'effect,categories[{title,causes[]}] — 鱼骨图（原因分析）'
};
export const CHART_DESCRIPTION = '画数据图表和专门图示（流程/泳道/思维导图/树/组织/状态/循环用create_flowchart，分层系统架构用create_diagram）。程序按数据排版，数字原样标注，文字放不下会报错要求精简，不截字。交付PNG、可编辑SVG、原生可编辑PPTX（PowerPoint形状和文字）和.chart.json源稿；改图用source_path加新的data整体重出。先想清楚要表达什么：分类对比用bar，趋势用line，占比用pie，构成用treemap，增减用waterfall，排期用gantt，大事记用timeline，二维定位用quadrant，原因分析用fishbone，系统交互顺序用sequence，表结构用er。能用三句话或一张表说清就不画。type与data字段：' +
  Object.entries(CHART_SHAPES).map(([k, v]) => `${k}=${v}`).join('；') + '。';

export function createChartTool(ctx = {}) {
  return {
    name: 'create_chart',
    description: CHART_DESCRIPTION,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        type: { type: 'string', enum: Object.keys(CHART_TYPES) },
        title: { type: 'string', description: '≤40字' },
        subtitle: { type: 'string', description: '可选：口径、来源、时间' },
        theme: { type: 'string', enum: ['blue', 'gray', 'green'] },
        data: { type: 'object', description: '按type填写，字段见工具说明' },
        source_path: { type: 'string', description: '修改已有.chart.json' },
        path: { type: 'string', description: '输出路径，如 图表/季度营收' }
      },
      required: []
    },
    run: async (input = {}, { signal, progress } = {}) => {
      throwControl(null, signal);
      let spec = input;
      if (input.source_path) {
        if (!/\.chart\.json$/i.test(input.source_path)) throw sceneError('修改图表请给.chart.json源稿');
        let previous;
        try { previous = JSON.parse(await (await ws.readBlob(input.source_path)).text()); } catch { throw sceneError('图表源稿读取失败或不是有效JSON'); }
        if (previous?.kind !== 'chart' || previous.version !== 1) throw sceneError('不是支持的图表源稿');
        spec = { ...previous, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && !['source_path', 'path'].includes(k))) };
      }
      const layout = CHART_TYPES[spec.type];
      if (!layout) throw sceneError(`请选择图表类型type：${Object.keys(CHART_TYPES).join('/')}`);
      const title = typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim() : '';
      if (!title || [...title].length > 40) throw sceneError('标题title需为1–40字');
      if (!spec.data || typeof spec.data !== 'object' || Array.isArray(spec.data)) throw sceneError('请按type填写data');
      if (JSON.stringify(spec.data).length > 60000) throw sceneError('图表数据过大，请拆成几张图');
      const theme = themeOf(spec.theme);
      progress?.('正在按数据排版图表…');
      const laid = layout({ ...spec.data, title, subtitle: typeof spec.subtitle === 'string' ? spec.subtitle.trim().slice(0, 120) : '' }, theme);
      const scene = { ...laid, title, background: theme.background };
      const svg = composeSceneSvg(scene);
      const source = { kind: 'chart', version: 1, type: spec.type, title, ...(spec.subtitle && { subtitle: spec.subtitle }), theme: spec.theme || 'blue', data: spec.data };
      const base = await outputBase(input.path || input.source_path?.replace(/\.chart\.json$/i, '') || `图表/${title}`, signal);
      const files = [], errors = [];
      const save = async (ext, blob, extra = {}) => {
        const saved = await ws.write(`${base}.${ext}`, blob);
        if ((await ws.readBlob(saved.path)).size !== blob.size) throw sceneError('写入读回不一致', 'CHART_READBACK');
        ctx.onFileChanged?.(saved.path);
        files.push({ format: ext.replace(/^chart\./, ''), path: saved.path, readback: 'passed', ...extra });
        return saved.path;
      };
      await save('chart.json', new Blob([JSON.stringify(source, null, 2)], { type: 'application/json' }));
      await save('svg', new Blob([svg], { type: 'image/svg+xml' }));
      let fontCheck = 'not_checked';
      try {
        const rendered = await (ctx.renderVisualScene || renderVisualScene)(svg, { signal });
        fontCheck = rendered.fontCheck?.status === 'passed' ? 'passed' : 'not_checked';
        const path = await save('png', rendered.blob, { render: 'passed' });
        ctx.onImage?.(URL.createObjectURL(rendered.blob), path);
      } catch (error) { throwControl(error, signal); errors.push({ code: 'CHART_RENDER_FAILED', message: 'PNG渲染未完成；SVG和源稿已保留' }); }
      try { await save('pptx', await composeScenePptx(scene)); }
      catch (error) { throwControl(error, signal); errors.push({ code: 'CHART_PPTX_FAILED', message: 'PPTX生成未完成' }); }
      const png = files.find(f => f.format === 'png');
      return JSON.stringify({ kind: 'chart', type: spec.type, status: png && !errors.length ? 'complete' : 'partial', title, width: Math.ceil(scene.width), height: Math.ceil(scene.height),
        files, primaryPath: png?.path || null, sourcePath: files[0].path, fontCheck, visual: 'not_checked', errors,
        notes: ['坐标由程序按数据计算，数字原样标注，文字未删减', '数据本身是否准确由提供方负责；未做看图审美核验，交付时不能说视觉已验收'] });
    }
  };
}

async function outputBase(path, signal) {
  const clean = String(path).replace(/\.(?:chart\.json|png|svg|pptx)$/i, '').replace(/[\\:*?"<>|\u0000-\u001f]+/g, '').slice(0, 200) || '图表/图表';
  for (const base of [clean, `${clean}-${Date.now().toString(36)}`]) {
    throwControl(null, signal);
    const taken = await Promise.all(['chart.json', 'png', 'svg', 'pptx'].map(ext => ws.exists(`${base}.${ext}`)));
    if (!taken.some(Boolean)) return base;
  }
  return `${clean}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
}
