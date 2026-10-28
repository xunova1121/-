import * as ws from './workspace.js';
import { parseFile, generate } from './docs.js';
import { THEME_IDS } from './themes.js';
import { writeLongDocument, outlineMarkdown } from './longDoc.js';
import { lint } from './selfCheck.js';
import { deliverDocument } from './documentDelivery.js';
import { documentTypography } from './documentTypography.js';
import { S, str, fmtSize, findTemplate } from './documentSchema.js';
import { createProfessionalDocumentTools } from './professionalDocumentTools.js';
import { documentDepth } from '../app/doc/workflowPolicy.js';

/** 长文保留原有分节写作与试读；交付统一走实际文件验收。 */
export function createLongDocumentTool(ctx) {
  return {
    name: 'write_long_document',
    description: `写长文档（约 3000 字以上的报告、方案、总结、标书、调研分析等）：先列大纲，再逐节写（每节都带着大纲和前文摘要，前后连贯），通读统一术语和衔接，然后请一位不了解背景的“读者”试读，按读者意见把有问题的节改一轮，最后生成文件。耗时 1–5 分钟。
用户说“先看大纲 / 先给我大纲”时 outline_only=true，只返回大纲给用户确认；用户确认或修改后，把定下来的大纲放进 outline 再调用一次。短文档（通知、函、几百字的说明）直接用 create_document。`,
    input_schema: S(
      {
        task: str('写作要求，写完整：写什么、给谁看、用途、重点、风格、特殊要求'),
        format: { type: 'string', enum: ['docx', 'pdf', 'html', 'md'], description: '输出格式，默认 docx' },
        path: str('保存路径（扩展名会自动修正）'),
        title: str('文档标题（可选，不填由模型拟定）'),
        material: str('用户在对话里直接给的材料、数据、要点（原样放进来，不要概括）'),
        material_files: {
          type: 'array',
          items: { type: 'string' },
          description: '用户给的参考文件（工作区路径，Word/PDF/PPT/Excel/文本都行）。有文件时一定放这里，程序会读取全文，不要自己读了再概括进 material'
        },
        words: { type: 'number', description: '目标字数（可选）' },
        outline_only: { type: 'boolean', description: '只出大纲，等用户确认' },
        outline: {
          type: 'array',
          description: '已确认的大纲（跳过列大纲）',
          items: {
            type: 'object',
            properties: { heading: str('一级标题'), points: { type: 'array', items: { type: 'string' } }, words: { type: 'number' } },
            required: ['heading'],
            additionalProperties: false
          }
        },
        review: { type: 'boolean', description: '读者试读并修改（默认 true）' },
        theme: { type: 'string', enum: THEME_IDS, description: '配色主题，不填自动选' },
        cover: { type: 'boolean', description: '加封面' },
        subtitle: str('副标题（可选）'),
        author: str('署名（可选）')
      },
      ['task', 'path']
    ),
    run: async (
      {
        task,
        format = 'docx',
        path,
        title,
        material,
        material_files: materialFiles,
        words,
        outline_only: outlineOnly,
        outline,
        review = true,
        theme,
        cover,
        subtitle,
        author
      },
      execution = {}
    ) => {
      const { progress, signal, checkpoint } = execution;
      // 参考文件由程序读全文，不经模型转述（模型转述时会压缩，长材料还会被截断）
      const files = [];
      for (const f of Array.isArray(materialFiles) ? materialFiles.slice(0, 8) : []) {
        try {
          const blob = await ws.readBlob(f);
          files.push(`【参考文件：${f}】\n${ws.isText(f) ? await blob.text() : (await parseFile(blob, f)).text}`);
        } catch (e) {
          throw new Error(`读不到参考文件 ${f}：${e.message}`);
        }
      }
      if (files.length) material = [material, ...files].filter(Boolean).join('\n\n');
      if (!outlineOnly && !outline?.length && ctx.llm && documentDepth({task, format}) === 'expert') {
        const professional = createProfessionalDocumentTools(ctx).find(item => item.name === 'write_professional_document');
        return professional.run({task: words ? `${task}\n目标字数：${words}` : task, material, format, path, title, depth:'expert'}, execution);
      }
      const r = await writeLongDocument({
        task,
        title,
        material,
        words: Number(words) || 0,
        outline: Array.isArray(outline) ? outline : null,
        outlineOnly: Boolean(outlineOnly),
        review: review !== false,
        llm: ctx.llm ?? null,
        readerLlm: ctx.reasonLlm ?? null,
        onProgress: (t) => progress?.(t),
        signal
      });
      if (outlineOnly) {
        return `大纲如下（还没有写正文）。把大纲给用户看，问是否需要调整；用户确认后，把最终大纲放进 outline 参数，再调用一次 write_long_document（其他参数照旧）。\n\n${outlineMarkdown(r.title, r.outline)}`;
      }
      const { tpl, tplPath } = await findTemplate(format);
      const out = await generate(format, {
        typography: format === 'docx' ? await documentTypography(ctx, execution.requestText || execution.rawRequestText || task, signal) : {},
        title: r.title,
        content: r.markdown,
        theme,
        cover: Boolean(cover),
        subtitle,
        author,
        loadImage: async (src) => {
          try {
            return new Uint8Array(await (await ws.readBlob(src)).arrayBuffer());
          } catch {
            return null;
          }
        },
        toPdf: ctx.toPdf ?? null,
        template: tpl
      });
      const target = path.replace(/\.[a-z0-9]+$/i, '') + `.${out.ext}`;
      const w = await deliverDocument(ctx, out, target, { progress, signal, checkpoint, issues: lint(format, r.markdown), requirements: execution.requestText || execution.rawRequestText || task });
      const previewNotes = w.notes;
      const chars = r.markdown.replace(/[\s#|*\-`>]/g, '').length;
      const lines = [`已生成 ${w.path}（${fmtSize(out.blob.size)}，${r.outline.length} 节，约 ${chars} 字，主题：${out.theme.name}）`];
      lines.push('已检查真实文件结构并读回有效内容', ...previewNotes);
      if (tpl) lines.push(`沿用了工作区里的模板 ${tplPath}`);
      const left = lint(format, r.markdown);
      if (left.length) lines.push(`自查还需要注意：${left.map((x) => x.text).join('；')}`);
      if (r.edits) lines.push(`通读后统一修改了 ${r.edits} 处术语 / 衔接`);
      if (r.review?.issues?.length) {
        lines.push(`读者试读发现 ${r.review.issues.length} 个问题，已修改的节：${r.review.revised.join('、') || '无（改动没通过检查，保留原文）'}`);
        lines.push(...r.review.issues.map((x) => `- 【${x.type}】${x.section ? `${x.section}：` : ''}${x.problem}`));
      } else if (r.review) lines.push(r.review.failed ? '读者试读没有完成（模型出错），未修改' : '读者试读没有发现明显问题');
      if (out.note) lines.push(out.note);
      lines.push('请用几句话告诉用户文件位置、结构和需要用户确认的地方（如“待确认”的数据），不要复述全文。');
      return lines.join('\n');
    }
  };
}

