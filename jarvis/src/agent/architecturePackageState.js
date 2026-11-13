import * as workspace from './workspace.js';
import { diagramDigest } from './diagramExport.js';
import { throwControl } from '../core/networkRequest.js';
const invalid = message => Object.assign(new Error(message), { code: 'ARCHITECTURE_PACKAGE_STATE', kind: 'input', diagnostics: [{ stage: 'render', field: 'directory', action: '读取交付清单核对版本；新版本用新目录，不覆盖或混用旧文件' }] });
/** 最多3视图、每视图6文件，只按实际摘要复用；损坏/缺失文件仅使对应视图失效。 */
export async function reusableArchitectureViews(manifestPath, bundle, selected, directory, signal) {
  throwControl(null, signal);
  if (!await workspace.exists(manifestPath)) return [];
  const blob = await workspace.readBlob(manifestPath);
  if (blob.size > 100000) throw invalid('已有交付清单超过100KB，未覆盖');
  let previous;
  try { previous = JSON.parse(await blob.text()); } catch (error) { throwControl(error, signal); throw invalid('已有交付清单不是有效JSON，未覆盖'); }
  if (previous.version !== 1 || !Array.isArray(previous.completedViews) || previous.completedViews.length > 3) throw invalid('已有清单结构无效，未覆盖');
  if (previous.planHash !== bundle.planHash || previous.architecturePath !== bundle.path) throw invalid('目录已有不同底稿或版本，请使用新版本目录保留旧交付');
  if (bundle.report.structure !== 'passed' || bundle.report.semantic !== 'passed') return [];
  const result = [];
  const seen = new Set();
  for (const view of previous.completedViews) {
    throwControl(null, signal);
    if (!selected.includes(view.view) || seen.has(view.view) || view.editable !== true || typeof view.designHash !== 'string' || view.designHash.length > 100 || !Array.isArray(view.files) || view.files.length > 6) continue;
    seen.add(view.view);
    if (['svg', 'png', 'pdf', 'pptx'].some(format => !view.files.some(item => item.format === format)) || !view.files.some(item => item.format === 'pptx' && item.path?.endsWith('-可编辑.pptx'))) continue;
    let reusable = true;
    const files = [];
    for (const item of view.files) {
      if (typeof item.path !== 'string' || item.path.length > 400 || !item.path.startsWith(directory + '/') || item.path.includes('\\') || item.path.split('/').includes('..') || !['svg', 'png', 'pdf', 'pptx'].includes(item.format) || typeof item.hash !== 'string' || item.hash.length > 100 || !await workspace.exists(item.path)) { reusable = false; break; }
      const file = await workspace.readBlob(item.path);
      if (!file.size || file.size > 20e6 || await diagramDigest(file) !== item.hash) { reusable = false; break; }
      files.push({ path: item.path, format: item.format, hash: item.hash });
    }
    if (reusable) result.push({ view: view.view, designHash: view.designHash, editable: true, previewPath: files.find(item => item.format === 'png').path, files });
  }
  throwControl(null, signal);
  return result;
}
