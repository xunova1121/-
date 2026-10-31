import * as ws from './workspace.js';
import { collectSessionWork } from './sessionWork.js';
import { documentError } from './documentPlan.js';

const fail = (text) => documentError(text, 'DOCUMENT_SOURCE');

export function uploadedWordPaths(text = '') {
  const paths = [];
  for (const match of String(text).matchAll(/\[已上传到工作区[：:]([^\]\n]+)\]/g)) {
    const items = match[1].split('、');
    if (items.length > 32) throw fail('附件超过32个处理上限，请分批绑定原文件');
    for (const item of items) {
      if (!/\.docx$/i.test(item.trim()) || paths.includes(item.trim())) continue;
      if (paths.length >= 32) throw fail('附件超过32个处理上限，请分批绑定原文件');
      paths.push(item.trim());
    }
  }
  return paths.slice(0, 32);
}

function pathBinding(request, path) {
  const text = request.split(/^#\s/m)[0].replace(/\[已上传到工作区[：:][^\]\n]+\]/g, '');
  let offset = 0;
  let binding = 0;
  // 最多32次明确引用，按最后一次更正；附件索引和正文提及不是新指令。
  for (let index = 0; index < 32; index++) {
    const start = text.indexOf(path, offset);
    if (start < 0) break;
    offset = start + path.length;
    const before = text.slice(0, start).at(-1) || '';
    const after = text[offset] || '';
    if ((before && !/[\s“"'`（(\[【<{：:，,]/.test(before)) || (after && !/[\s，,。；;:：”"'`）)\]】}>]/.test(after))) continue;
    const prefix = text.slice(Math.max(0, start - 20), start).replace(/[\s“"'`（(\[【]/g, '');
    const corrected = /(?:而是|\.docx[^，。；;]*?(?:改用|改为(?:使用|用)?|换成))[^，。；;:：]{0,4}$/i.test(prefix);
    binding = !corrected && /(?:不要|不用|别用|不是|不选|排除|弃用|勿用)[^，。；;:：]{0,10}$/.test(prefix) ? -1 : 1;
  }
  return binding;
}

/** 只绑定本轮明确路径、最新上传或最近文件回执；助手正文中的任意文件名不算来源。 */
export async function formattingFileSource({ request, sourcePath, latest, messages = [], signal, preferText = false }) {
  const currentFiles = uploadedWordPaths(request);
  const latestFiles = uploadedWordPaths(latest?.text);
  const uploads = currentFiles.length ? currentFiles : latestFiles;
  if (!sourcePath && uploads.length === 1) sourcePath = uploads[0];
  if (!sourcePath) return null;
  if (typeof sourcePath !== 'string' || sourcePath.length > 400 || !/\.docx$/i.test(sourcePath)) throw fail('原文件需绑定400字符以内的工作区DOCX路径');
  const binding = pathBinding(request, sourcePath);
  if (binding < 0) throw fail('本轮明确排除的Word不能作为排版来源，请使用本轮指定原件');
  const explicit = binding > 0;
  const work = collectSessionWork(messages).flatMap((record) => record.files.filter((path) => /\.docx$/i.test(path)));
  const latestWork = work.at(-1);
  const bodyIndex = messages.findLastIndex((message) => message.role === 'user' && message.content === latest?.text);
  const fileIndex = messages.findLastIndex((message) => message.role === 'assistant' && message.files?.includes(sourcePath));
  // 新粘贴正文优先于旧文件；刚生成的Word仍可据真实文件回执重排，不能据助手口头声称选择。
  const hasBody = /^#\s+\S/m.test(latest?.text || '') || (String(latest?.text || '').length > 100 && !latestFiles.length);
  const newBody = hasBody && (latest.text === request || bodyIndex > fileIndex);
  if ((newBody || (preferText && hasBody)) && !explicit) return null;
  const recentOutput = !currentFiles.length && latestWork === sourcePath && fileIndex >= 0 && fileIndex > bodyIndex;
  if (!explicit && !recentOutput && (uploads.length ? !uploads.includes(sourcePath) : latestWork !== sourcePath)) {
    const candidates = (uploads.length ? uploads : latestWork ? [latestWork] : []).slice(-6).map((path) => path.slice(0, 240));
    throw fail(
      'source_path不属于本轮指定/最新上传/最近回执文件；可绑定原件：' +
        (candidates.length ? candidates.join('、') : '未找到，请回读本段文件回执') +
        '；不要回用旧稿'
    );
  }
  signal?.throwIfAborted();
  const blob = await ws.readBlob(sourcePath);
  if (blob.size > 20_000_000) throw fail('Word原文件超过20MB处理上限，不能截断重做');
  signal?.throwIfAborted();
  return { kind: 'docx', id: 'file:' + sourcePath, path: sourcePath, blob, content: '' };
}
