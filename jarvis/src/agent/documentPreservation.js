import { parseDoc, plain } from './docModel.js';
import { documentError } from './documentPlan.js';
import { openOfficePackage, xmlUnescape } from './officePackage.js';
import { collectRequirements } from './taskRequirements.js';
import * as sessions from './sessions.js';
import { formattingFileSource, uploadedWordPaths } from './documentFileSource.js';

// 只处理明确的排版任务；写作、精简、翻译仍走原工作流，不根据历史偏好猜授权。
export function formattingOnly(request = '') {
  const instruction = String(request).split(/^#\s/m)[0];
  if (/(?:不要|不是|并非)只(?:做)?(?:排版|调整排版)|(?<!不)需要(?:改写|重写)|(?<!不)允许(?:改写|重写)/.test(instruction)) return false;
  if (/(?:不要|不用|别)重新排版/.test(instruction)) return false;
  for (const clause of instruction.split(/[，。；;\n]/)) {
    if (/(?:改写|重写|重新写)/.test(clause) && !/(?:不|别|勿|无需|不必)[^，。；;]{0,8}(?:改写|重写|重新写)/.test(clause)) return false;
  }
  const explicit =
    /只(?:让你)?(?:做|需|要)?(?:个)?(?:调整|修改|改)?(?:一下)?(?:排版|版式|格式)|(?:正文|内容|原文)(?:一字)?(?:都)?(?:不要改|不改|不变|保持不变)|仅(?:排版|调整版式)/.test(
      instruction
    );
  if (explicit) return true;
  // 写作风格/语气重做仍允许改文字，不能因为“偏好”二字就降级为只换格式。
  if (/写作(?:偏好|喜好)|文风|语气|润色|翻译|精简|扩写/.test(instruction)) return false;
  return /重新排版|重排版|(?:按(?:照)?|根据).{0,12}(?:偏好|喜好).{0,8}(?:重新做|重做|重排|做成\s*Word)/i.test(instruction);
}

const MAX_SOURCE = 120000;
const fail = (message) => documentError(message, 'DOCUMENT_SOURCE');

/** 原文来自本轮会话的用户记录，不接受模型自己填写的旧稿冒充原文。 */
export async function formattingSource({ request, sessionId, sourceId, sourcePath, signal }) {
  // 自动锁稿只用于纯排版；显式绑定是本步保文契约，复杂任务可先套版、再用编辑工具改文字。
  if (!formattingOnly(request) && !sourceId && !sourcePath) return null;
  signal?.throwIfAborted();
  const saved = sessionId ? await sessions.get(sessionId) : null;
  signal?.throwIfAborted();
  const entries = collectRequirements(saved?.messages, saved?.requirements).entries;
  // 最多看400条用户原话；最近的完整长消息若没有正文边界，就要求显式编号，不能跳过去选更早的稿。
  const recent = entries.slice(-400).filter((entry) => entry.text !== request);
  const latest = /^#\s+\S/m.test(request)
    ? { id: 'current', text: request }
    : recent.reverse().find((entry) => entry.text.length > 100 || /^#\s+\S/m.test(entry.text) || uploadedWordPaths(entry.text).length);
  if (sourceId && sourcePath) throw fail('原文编号与Word原文件只能绑定一种来源：已有Word请只传source_path（如 上传/原稿.docx）；聊天原文请只传source_requirement_id，另一项删除或留空');
  if (!sourceId) {
    const instruction = request.split(/^#\s/m)[0];
    const preferText = formattingOnly(request) && /内容我发你了|我发给你的(?:完整)?(?:正文|原文)/.test(instruction);
    const file = await formattingFileSource({ request, sourcePath, latest, messages: saved?.messages, signal, preferText });
    if (file) return file;
  }
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
  if (!source) throw fail('排版任务缺少已绑定的完整原文；用source_requirement_id指定用户原文，或source_path绑定原Word，不要拿旧稿或摘要替代');
  if (source.text.length > MAX_SOURCE) throw fail('排版原文超过12万字符处理上限，不能截断后冒充全文');
  const start = source.text.search(/^#\s+\S/m);
  if (start < 0 && uploadedWordPaths(source.text).length) throw fail('该原话编号指向上传附件，请用source_path绑定Word原文件，不能把附件说明当成正文');
  if (start < 0 && formattingOnly(source.text)) throw fail('所选原话只有排版指令，没有可识别的正文；请读取并绑定正文编号');
  const prefix = start > 0 ? source.text.slice(0, start) : '';
  const layoutCommand = /^\s*(?:只(?:调整|做)?排版|只调整版式)(?:[，,]\s*(?:正文|内容)(?:不改|不变))?[。！!\s]*$/.test(prefix);
  const content = (source.text === request && layoutCommand ? source.text.slice(start) : source.text).trim();
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
