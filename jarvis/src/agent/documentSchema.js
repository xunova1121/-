import * as ws from './workspace.js';
import { TEMPLATE_PATH } from './docxWriter.js';
import { throwControl } from '../core/networkRequest.js';
import { documentError } from './documentPlan.js';

export const S = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const str = (description) => ({ type: 'string', description });
export const fmtSize = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

/** Word 模板：指定了就用指定的；没指定且只有一份模板时沿用；多份时必须明确路径；"none" 不用 */
export const findTemplate = async (format, template) => {
  if (format !== 'docx' || template === 'none') return { tpl: null };
  let tplPath = template || '';
  const auto = !tplPath;
  if (auto) {
    const candidates = (await ws.list()).filter((file) => TEMPLATE_PATH.test(file.path));
    if (candidates.length > 1) throw documentError('发现多份Word模板，请先按用户用途选定template路径，或用none不套模板', 'DOCUMENT_TEMPLATE_AMBIGUOUS');
    tplPath = candidates[0]?.path || '';
  }
  if (!tplPath) return { tpl: null };
  try {
    return { tpl: new Uint8Array(await (await ws.readBlob(tplPath)).arrayBuffer()), tplPath, auto };
  } catch (error) {
    throwControl(error);
    throw Object.assign(documentError(`找不到模板文件：${tplPath}`, 'DOCUMENT_TEMPLATE'), { cause: error });
  }
};
