import { reusableArchitectureViews } from './architecturePackageState.js';
import * as workspace from './workspace.js';
import { loadArchitecture } from './architectureProjection.js';
import { createDiagramTool } from './diagramTool.js';
import { throwControl } from '../core/networkRequest.js';
const labels = { overview: '总体架构', workflow: '业务闭环', dataflow: '数据流' };
const invalid = message => Object.assign(new Error(message), { code: 'ARCHITECTURE_PACKAGE', kind: 'input', diagnostics: [{ field: 'directory', stage: 'layout', action: '用合法的交付目录和已存底稿；每视图仍需真实同稿导出，不用旧图替代' }] });
export function createArchitecturePackageTool(ctx) {
  const diagram = createDiagramTool(ctx, { requireArchitecture: true });
  return {
    name: 'create_architecture_package',
    description: '从同一已审架构底稿交付总体、业务闭环、数据流多视图，每视图实际生成SVG/PNG/PDF/原生可编辑PPT及清单；没有登记相应关系不编造专题。同版文件摘要一致时复用已完成视图，不重建底稿；任一视图失败保留已生成文件与partial清单，不声称整包完成。',
    input_schema: { type: 'object', properties: {
      architecturePath: { type: 'string', maxLength: 400 }, directory: { type: 'string', maxLength: 200 },
      views: { type: 'array', maxItems: 3, minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['overview', 'workflow', 'dataflow'] } }
    }, required: ['architecturePath', 'directory'], additionalProperties: false },
    run: async ({ architecturePath, directory, views }, execution = {}) => {
      throwControl(null, execution.signal);
      if (typeof directory !== 'string' || !directory.trim() || directory.length > 200 || directory.startsWith('/') || directory.includes('\\') || directory.split('/').some(part => !part || part === '.' || part === '..')) throw invalid('交付目录需1～200字的相对目录，不含空段或上级跳转');
      const bundle = await loadArchitecture(architecturePath, execution.signal);
      const available = ['overview', ...(bundle.plan.relations.some(item => ['workflow', 'feedback'].includes(item.type)) ? ['workflow'] : []), ...(bundle.plan.relations.some(item => item.type === 'dataflow') ? ['dataflow'] : [])];
      const selected = views || available;
      if (!Array.isArray(selected) || !selected.length || selected.length > 3 || new Set(selected).size !== selected.length || selected.some(view => !available.includes(view))) throw invalid('选择的视图未登记对应关系或重复，不编造专题');
      const manifestPath = directory + '/交付清单.json';
      const reused = await reusableArchitectureViews(manifestPath, bundle, selected, directory, execution.signal);
      const manifest = { version: 1, architecturePath, planHash: bundle.planHash, status: 'running', selectedViews: selected, reusedViews: reused.map(item => item.view), completedViews: reused, failedView: null, files: reused.flatMap(item => item.files.map(file => file.path)) };
      const save = async () => {
        manifest.completedViews.sort((a, b) => selected.indexOf(a.view) - selected.indexOf(b.view));
        manifest.files = manifest.completedViews.flatMap(item => item.files.map(file => file.path));
        await workspace.writeArchitectureState(manifestPath, JSON.stringify(manifest));
        await execution.checkpoint?.({ type: 'file', path: manifestPath });
        ctx.onFileChanged?.(manifestPath);
      };
      await save();
      for (const view of selected) {
        if (manifest.reusedViews.includes(view)) { execution.progress?.('已核对并复用' + labels[view] + '实际文件，不重复生成'); continue; }
        try {
          throwControl(null, execution.signal);
          execution.progress?.('正在交付' + labels[view] + '，保留同一底稿与来源版本…');
          const result = await diagram.run({ architecturePath, path: directory + '/' + labels[view] + '.svg', view, formats: ['svg', 'png', 'pdf', 'pptx'], pptxMode: 'editable' }, execution);
          const receipt = JSON.parse(result.split('\n')[1]);
          if (receipt.architecture?.semantic !== 'passed' || receipt.editable?.passed !== true || new Set(receipt.artifacts.map(item => item.designHash)).size !== 1 || ['svg', 'png', 'pdf', 'pptx'].some(format => !receipt.artifacts.some(item => item.format === format))) {
            const error = invalid('视图没有取得完整的四格式/原生PPT通过回执');
            error.code = receipt.errors?.[0]?.code || 'DIAGRAM_PPTX_COMPARE';
            error.diagnostics = [{ stage: 'render', field: view + '.artifacts', action: '核对实际渲染与可编辑PPT回执，修复该视图；不降门槛或拿展示版替代' }];
            error.validation = { view, semantic: receipt.architecture?.semantic, render: receipt.validation?.render, editable: receipt.editable ? { passed: receipt.editable.passed, state: receipt.editable.state, code: receipt.editable.code, meanChannelError: receipt.editable.meanChannelError, aspectError: receipt.editable.aspectError } : null, formats: receipt.artifacts.map(item => item.format) };
            throw error;
          }
          const current = await loadArchitecture(architecturePath, execution.signal);
          if (current.planHash !== bundle.planHash) throw invalid('底稿版本在交付期间变化，不能合并不同版本视图');
          manifest.completedViews.push({ view, designHash: receipt.designHash, editable: true, previewPath: receipt.artifacts.find(item => item.format === 'png').path, files: receipt.artifacts.map(item => ({ path: item.path, format: item.format, hash: item.hash })) });
          manifest.files.push(...receipt.artifacts.map(item => item.path));
          await save();
        } catch (error) {
          manifest.status = 'partial'; manifest.failedView = view; manifest.errorCode = String(error.code || error.name || 'ERROR').slice(0, 80);
          if (error.validation) manifest.failureValidation = error.validation;
          try { await save(); } catch (saveError) { throwControl(error, execution.signal); throw saveError; }
          throwControl(error, execution.signal);
          throw Object.assign(error, { statePath: manifestPath });
        }
      }
      manifest.status = 'complete';
      await save();
      return JSON.stringify({ manifestPath, ...manifest, note: '同一底稿各视图内容范围不同，各自四格式同设计；已完成只代表实际文件/原生PPT检查，不代表客户材料或视觉业务已验收。' });
    }
  };
}
