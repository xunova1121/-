import { parseDoc, plain } from './docModel.js';
import { documentError } from './documentPlan.js';
import { openOfficePackage, xmlUnescape } from './officePackage.js';
import { collectRequirements } from './taskRequirements.js';
import * as sessions from './sessions.js';

// 只处理明确的排版任务；写作、精简、翻译仍走原工作流，不根据历史偏好猜授权。
export function formattingOnly(request = '') {
  const instruction = String(request).split(/^#\s/m)[0];
  if (/(?:不要|不是|并非)只(?:做)?(?:排版|调整排版)|(?<!不)需要(?:改写|重写)|(?<!不)允许(?:改写|重写)/.test(instruction)) return false;
  return /只(?:让你)?(?:做|需|要)?(?:个)?(?:调整|修改|改)?(?:一下)?(?:排版|版式|格式)|(?:正文|内容|原文)(?:一字)?(?:都)?(?:不要改|不改|不变|保持不变)|仅(?:排版|调整版式)/.test(
    instruction
  );
}

const MAX_SOURCE = 120000;
const fail = (message) => documentError(message, 'DOCUMENT_SOURCE');

/** 原文来自本轮会话的用户记录，不接受模型自己填写的旧稿冒充原文。 */
export async function formattingSource({ request, sessionId, sourceId, signal }) {
  if (!formattingOnly(request)) return null;
  signal?.throwIfAborted();
  const saved = sessionId ? await sessions.get(sessionId) : null;
  signal?.throwIfAborted();
  const entries = collectRequirements(saved?.messages, saved?.requirements).entries;
  // 最多看400条用户原话；最近的完整长消息若没有正文边界，就要求显式编号，不能跳过去选更早的稿。
  const recent = entries.slice(-400).filter((entry) => entry.text !== request);
  const latest = /^#\s+\S/m.test(request)
    ? { id: 'current', text: request }
    : recent.reverse().find((entry) => entry.text.length > 100 || /^#\s+\S/m.test(entry.text));
  let source;
  if (sourceId) {
    if (!/^r\d{1,12}$/.test(sourceId)) throw fail('原文编号格式无效');
    source = entries.find((entry) => entry.id === sourceId);
    if (!source) throw fail('排版原文编号不在本轮会话中；用read_task_requirements核对原文编号后重试');
    if (latest && latest.text !== source.text && !new RegExp(`\\b${sourceId}\\b`).test(request))
      throw fail('所选原文早于最近的用户正文；请核对最新原文编号，不要静默回用旧稿');
  } else {
    // 自动识别只接受完整Markdown正文边界；普通聊天不被当作原文，也不拿助手旧稿补位。
    source = latest && /^#\s+\S/m.test(latest.text) ? latest : null;
  }
  if (!source) throw fail('只排版任务缺少已绑定的完整原文；先读取用户原文，用source_requirement_id指定记录，不要拿旧稿或摘要替代');
  if (source.text.length > MAX_SOURCE) throw fail('排版原文超过12万字符处理上限，不能截断后冒充全文');
  const start = source.text.search(/^#\s+\S/m);
  if (start < 0 && formattingOnly(source.text)) throw fail('所选原话只有排版指令，没有可识别的正文；请读取并绑定正文编号');
  const prefix = start > 0 ? source.text.slice(0, start) : '';
  const content = (source.text === request && formattingOnly(prefix) ? source.text.slice(start) : source.text).trim();
  if (!content) throw fail('排版原文为空');
  return { content, id: source.id };
}

function blockText(block) {
  if (block.inlines) return [plain(block.inlines)];
  if (block.type === 'table') return [block.header, ...block.rows].flat().map(plain);
  if (block.type === 'list') return block.items.flatMap((item) => [plain(item.inlines), ...item.children.flatMap(blockText)]);
  if (block.type === 'quote') return block.blocks.flatMap(blockText);
  if (block.type === 'code') return [block.text];
  return [];
}

/** 检查真实DOCX主文档，按顺序逐段/逐格核对，不用关键词覆盖率代替正文保真。 */
export async function verifyFormattingContent(blob, source, signal) {
  signal?.throwIfAborted();
  const zip = await openOfficePackage(blob);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw fail('排版产物缺少Word主文档，不能核对正文');
  const normalize = (text) => text.replace(/\s/gu, '');
  const actual = normalize([...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => xmlUnescape(match[1])).join(''));
  const parts = parseDoc(source).flatMap(blockText).map(normalize).filter(Boolean);
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    const at = actual.indexOf(part, offset);
    if (at < 0) throw fail(`排版正文保留校验未通过：第${index + 1}个文本段或表格单元缺失/改变，未写入目标文件`);
    offset = at + part.length;
  }
  signal?.throwIfAborted();
  return { state: 'passed', segments: parts.length, scope: '主文档原文逐段逐格顺序核对；不等于视觉验收' };
}
