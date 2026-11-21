import * as ws from './workspace.js';
import { documentError } from './documentPlan.js';
/** 仅新建允许缺省路径；保留原文件及重名文件，不拿默认新文件假装编辑成功。 */
export async function documentOutputPath(path, title, format, { signal } = {}) {
  if (typeof path === 'string' && path.trim()) return path.trim();
  if (!/^(docx|pptx|xlsx|pdf|html|md|txt|csv)$/.test(format)) throw documentError('请指定支持的文档格式', 'DOCUMENT_FORMAT');
  const stem = String(title || '未命名文档').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 80) || '未命名文档';
  for (let i = 0; i < 1000; i++) {
    signal?.throwIfAborted();
    const candidate = `outputs/${stem}${i ? '-' + (i + 1) : ''}.${format}`;
    if (!await ws.exists(candidate)) return candidate;
  }
  throw documentError('同名文档过多，请指定新标题或保存路径', 'DOCUMENT_PATH');
}
