import * as workspace from './workspace.js';
import { throwControl } from '../core/networkRequest.js';
import { architecturePathParts, isArchitectureManagedPath, isArchitectureMetadataPath, ownsManagedDiagramMetadata, architectureJsonValue } from './architectureStateOwnership.js';
export { isArchitectureManagedPath } from './architectureStateOwnership.js';

// 只限制智能体通用修改入口；工作流内部workspace写入、用户手工管理及主机权限不在此锁内。
const readonlyTools = new Set(['read_file', 'list_files', 'find_files', 'search_in_files', 'read_tool_result', 'read_task_checkpoint', 'read_task_requirements', 'preview', 'show_image', 'inspect_image', 'read_image_text', 'computer_read_file', 'computer_list_dir', 'computer_search', 'computer_capabilities', 'execution_capabilities', 'run_javascript', 'run_project_tests']);
const architectureTools = new Set(['build_architecture', 'plan_architecture', 'revise_architecture_plan', 'prepare_architecture_evidence', 'create_architecture_package', 'create_diagram', 'export_diagram', 'render_diagram']);
const pathField = /^(?:path|paths|file|files|file_?path|file_?name|target|targets|target_?path|to|from|source|sources|source_?path|destination|destination_?path|dest_?path|old_?path|new_?path|output_?path|save_?as|directory|working_?directory|dir|folder|folders|cwd|root|prefix|workspace_?path|preview_?path)$/i;
const documentField = /^(?:content|data|json|payload|body|value|document)$/i;
const protectedError = (path) => Object.assign(new Error('架构受管文件不能由通用文件或代码工具修改：' + String(path).slice(0, 400) + '；请沿用build_architecture的jobPath或正式修订工具，不删关系、改审查状态或伪造交付清单'), {
  code: 'ARCHITECTURE_STATE_PROTECTED', kind: 'input',
  diagnostics: [{ field: 'path', stage: 'content', action: '受管状态由架构工作流更新；读取和用户成果编辑保持可用，修改业务内容须经过来源/结构/语义及原生PPT检查' }]
});

/** 在实际同步回工作区之前检查，防止Python用变量/字符拼出路径绕开调度层。 */
export async function assertArchitectureWriteAllowed(path, data, { signal } = {}) {
  throwControl(null, signal);
  if (typeof path !== 'string' || !path.trim()) throw Object.assign(new Error('回写文件必须有明确路径'), { code: 'ARCHITECTURE_STATE_PATH', kind: 'input' });
  if (isArchitectureManagedPath(path)) throw protectedError(path);
  const normalized = architecturePathParts(path).join('/');
  if (!isArchitectureMetadataPath(normalized)) return;
  const proposed = await architectureJsonValue(data);
  throwControl(null, signal);
  if (ownsManagedDiagramMetadata(proposed)) throw protectedError(path);
  // 文件列表在本地目录模式限深/限条数，不是“不存在”的证明；直接核对实际目标。
  // 同时检查工作区原样路径和传输解码别名，不能借百分号文件名漏掉已有所有权。
  const candidates = [...new Set([workspace.normalize(path), normalized])];
  for (const target of candidates) {
    let blob;
    try { blob = await workspace.readBlob(target); } catch (error) {
      throwControl(error, signal);
      if (error.code === 'WORKSPACE_NOT_FOUND' || error.name === 'NotFoundError') continue;
      throw error;
    }
    const current = await architectureJsonValue(blob);
    throwControl(null, signal);
    if (ownsManagedDiagramMetadata(current)) throw protectedError(path);
  }
  throwControl(null, signal);
}
/** 先核对整个回写批次再写第一份文件，受管目标不允许产生半批副作用。 */
export async function assertArchitectureMutationBatch(changes, options = {}) {
  if (!Array.isArray(changes) || changes.length > 1000) throw Object.assign(new Error('回写文件批次超过1000项或结构无效'), { code: 'ARCHITECTURE_STATE_BATCH', kind: 'input' });
  for (const change of changes) await assertArchitectureWriteAllowed(change?.path, change?.bytes ?? change?.data ?? change?.content, options);
}

function targetPaths(args) {
  const paths = [];
  let visited = 0;
  const visit = (value, depth = 0, inheritedData) => {
    if (!value || typeof value !== 'object') return;
    if (++visited > 50000 || depth > 16) throw Object.assign(new Error('文件目标参数过深或过多，无法完整核对受管状态'), { code: 'ARCHITECTURE_STATE_ARGS', kind: 'input' });
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1, inheritedData); return; }
    const dataEntry = Object.entries(value).find(([key]) => documentField.test(key));
    const data = dataEntry ? dataEntry[1] : inheritedData;
    for (const [key, item] of Object.entries(value)) {
      if (pathField.test(key)) {
        if (typeof item === 'string') paths.push({ path: item, data });
        else if (Array.isArray(item)) for (const path of item) if (typeof path === 'string') paths.push({ path, data });
      }
      if (/^(?:patch|diff|input)$/i.test(key) && typeof item === 'string') paths.push(...patchTargets({ patch: item }));
      // 字符串正文不作路径扫描；别名常把真实参数包在payload/body里，对象不能因此漏检。
      if (!documentField.test(key) || (item && typeof item === 'object')) visit(item, depth + 1, data);
    }
  };
  visit(args);
  return paths;
}
function patchTargets(args) {
  const found = [];
  for (const key of ['patch', 'diff', 'input', 'command', 'code']) {
    const value = args?.[key];
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/^(?:\*\*\* (?:(?:Update|Add|Delete) File:|Move to:)|rename (?:from|to)|\+\+\+|---)\s+([^\r\n]+)/gm)) found.push({ path: match[1].replace(/^[ab]\//, '') });
    // 仅识别直接写出的主机命令目标；动态主机代码不能靠字符串扫描形成可靠隔离。
    if (key === 'command' && /(?:\brm\b|\bmv\b|\bcp\b|\bsed\b|writeFile|write_text|write_bytes|Set-Content|Remove-Item|Move-Item|Copy-Item|>)/i.test(value))
      for (const match of value.matchAll(/(?:[^\s"'`;]*[\\/])?文档检查[\\/][^\s"'`;]+/g)) found.push({ path: match[0] });
  }
  return found;
}
/** 按受管目标识别修改，未知别名也检查；通用read允许，架构工具的输入指针不当成写目标。 */
export async function assertArchitectureToolCall(name, args, options = {}) {
  if (readonlyTools.has(name)) return;
  if (architectureTools.has(name)) {
    const outputs = name === 'render_diagram' ? ['previewPath'] : ['path', 'directory', 'to', 'save_as'];
    for (const key of outputs) if (typeof args?.[key] === 'string') await assertArchitectureWriteAllowed(args[key], undefined, options);
    return;
  }
  const targets = [...targetPaths(args), ...patchTargets(args)];
  if (targets.length > 1000) throw Object.assign(new Error('文件目标超过1000项，不能只检查一部分'), { code: 'ARCHITECTURE_STATE_ARGS', kind: 'input' });
  for (const target of targets) await assertArchitectureWriteAllowed(target.path, target.data, options);
}
