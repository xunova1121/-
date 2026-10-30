import { openOfficePackage } from './officePackage.js';
import { generate } from './docs.js';
import { restyleDocx } from './docxRestyle.js';
import { deliverDocument } from './documentDelivery.js';
import { findTemplate, fmtSize } from './documentSchema.js';
import { documentError } from './documentPlan.js';
import { normalize } from './workspace.js';
import { documentTypography } from './documentTypography.js';

/** 原文件排版只换样式部件；不进入Markdown扩写，也不重建图片、表格或关系。 */
/** 去掉 Word 正文段落和样式里的上下边框（横线）；表格边框、左边框不动 */
export async function withoutParagraphRules(blob, { signal } = {}) {
  const zip = await openOfficePackage(blob);
  signal?.throwIfAborted();
  const strip = (xml) => xml.replace(/<w:pBdr\b[^>]*>[\s\S]*?<\/w:pBdr>/g, (bdr) => {
    const kept = bdr.replace(/<w:(?:top|bottom)\b[^>]*\/>/g, '').replace(/<w:(?:top|bottom)\b[^>]*>[\s\S]*?<\/w:(?:top|bottom)>/g, '');
    return /<w:(?:left|right|between|bar)\b/.test(kept) ? kept : '';
  });
  for (const name of ['word/document.xml', 'word/styles.xml']) {
    const xml = await zip.file(name)?.async('string');
    if (xml) zip.file(name, strip(xml));
  }
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return new Blob([bytes], { type: blob.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

export async function formatDocumentFile(ctx, source, args, execution = {}) {
  const { signal, progress, checkpoint, sessionId } = execution;
  if (args.cover || args.toc === 'yes') throw documentError('原文件样式调整保留原有封面/目录；新增封面目录须单独编辑，不能悄悄重建正文', 'DOCUMENT_SOURCE');
  signal?.throwIfAborted();
  const { tpl, tplPath } = await findTemplate('docx', args.template);
  const typography = args.typography || await documentTypography(ctx, execution.requestText || execution.rawRequestText || args.requirements || '', signal);
  // 只在内存里取现有生成器的样式，不把这份示例正文写入任何产物。
  const profile = await generate('docx', {
    title: '样式',
    content: '# 样式\n\n样式。',
    theme: args.theme,
    kind: args.kind,
    toc: false,
    cover: false,
    template: tpl,
    typography,
    noRules: Boolean(args.noRules)
  });
  const out = await restyleDocx(source.blob, profile.blob, { signal });
  // 用户说“不要横线”：原文件段落里的上下边框（标题下装饰线、分隔线）也去掉，正文文字不动
  if (args.noRules) out.blob = await withoutParagraphRules(out.blob, { signal });
  const sourceDigest = globalThis.crypto?.subtle
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await source.blob.arrayBuffer())), (value) => value.toString(16).padStart(2, '0')).join(
        ''
      )
    : null;
  const preservation = {
    ...out.preservation,
    sourceId: source.id,
    sourceSessionId: typeof sessionId === 'string' ? sessionId.slice(0, 160) : null,
    sourceDigest,
    stylesChanged: out.changed
  };
  const artifact = { blob: out.blob, ext: 'docx', theme: profile.theme, info: { typographyProfile: typography } };
  let target = args.path.replace(/\.[a-z0-9]+$/i, '') + '.docx';
  if (normalize(target) === normalize(source.path)) target = target.replace(/\.docx$/i, '_排版.docx');
  const delivered = await deliverDocument(ctx, artifact, target, {
    progress,
    signal,
    checkpoint,
    preservation,
    requirements: execution.requestText || execution.rawRequestText || args.requirements || ''
  });
  return `${delivered.path}（${fmtSize(out.blob.size)}）。绑定原文件${source.path}；仅调整样式，正文、表格、图片及关联等${out.preservation.parts}个非样式部件逐字节保持；保留直接格式和原有封面/目录${tplPath ? '；样式模板：' + tplPath : ''}；${delivered.notes.join('；')}`;
}
