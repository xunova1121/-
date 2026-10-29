import * as ws from './workspace.js';
import { editOffice } from './officeEdit.js';
import { editSpreadsheet } from './spreadsheetEdit.js';
import { deliverDocument } from './documentDelivery.js';
import { documentError } from './documentPlan.js';
import { S, str } from './documentSchema.js';

/** 精确修改工具与新建流程分离，减少大改时误覆盖现有文件。 */
export function createDocumentEditingTools(ctx) {
  return [
    {
      name: 'edit_office_document',
      description:
        '修改工作区里已有的 Word（.docx）或 PPT（.pptx），保留原来的排版和格式：替换文字（正文、表格、页眉页脚、每页幻灯片和备注都会找），Word 还可以在末尾追加段落（格式照抄最后一段）。适合“把文档里的 2025 改成 2026”“在合同里把甲方名称换掉”“在报告最后加一段说明”。要大改结构、或用户说“重新做 / 重做 / 再做一版”时用 create_document 重新生成。它只换文字，**改不了字号、横线、版式**：用户说“字大点 / 小点 / 不要横线 / 铺满一页”时不要先试它，直接用 create_document 按原内容重新生成，path 用原文件路径覆盖。',
      input_schema: S(
        {
          path: str('文件路径（.docx / .pptx）'),
          slides: {
            type: 'array',
            maxItems: 100,
            items: { type: 'integer', minimum: 1 },
            description: 'PPT指定实际页码（含封面，从1开始），只改这些页可见文字，不改备注；不填则沿用全文件替换'
          },
          expected_count: { type: 'integer', minimum: 0, description: '预期替换总次数，不符则整批不保存，防止误改同名文字' },
          replacements: {
            type: 'array',
            description: '要替换的文字',
            items: {
              type: 'object',
              properties: { find: str('原文（一字不差）'), replace: str('替换成') },
              required: ['find', 'replace'],
              additionalProperties: false
            }
          },
          append: { type: 'array', items: { type: 'string' }, description: '追加到 Word 末尾的段落（每项一段，可选）' },
          save_as: str('另存为（可选，不填就改原文件；原文件会自动备份）')
        },
        ['path']
      ),
      run: async ({ path, replacements = [], append = [], slides = [], expected_count: expectedCount, save_as: saveAs }, options = {}) => {
        const kind = ws.ext(path);
        if (!['docx', 'pptx'].includes(kind)) throw new Error('只能修改 .docx 或 .pptx 文件；文本文件用 edit_file');
        const r = await editOffice(await ws.readBlob(path), kind, {
          replacements: Array.isArray(replacements) ? replacements : [],
          append: Array.isArray(append) ? append : [],
          slides,
          expectedCount,
          signal: options.signal
        });
        const hit = r.replaced.filter((x) => x.count);
        const miss = r.replaced.filter((x) => !x.count);
        if (!hit.length && !r.appended)
          throw new Error(`文件里没有找到要替换的文字：${miss.map((x) => `“${x.find}”`).join('、') || '（没有给出修改）'}。先用 read_file 看准原文`);
        const target = saveAs ? saveAs.replace(/\.[a-z0-9]+$/i, '') + `.${kind}` : path;
        const w = await deliverDocument(ctx, { blob: r.blob, ext: kind }, target, { ...options, requirements: options.requestText || options.rawRequestText || options.requirements || '' });
        const parts = hit.map((x) => `“${x.find}”替换了 ${x.count} 处`);
        if (r.appended) parts.push(`追加了 ${r.appended} 段`);
        if (miss.length) parts.push(`没找到：${miss.map((x) => `“${x.find}”`).join('、')}`);
        return `已保存 ${w.path}（格式保留）：${parts.join('；')}；${w.notes.join('；')}${w.backup === 'saved' ? '。原文件已自动备份，可在“工作区 → 改动记录”里恢复' : ''}`;
      }
    },
    {
      name: 'edit_spreadsheet',
      description:
        '精确修改已有Excel的指定格，保留其他部件；可带expected核对旧值，任何冲突整批不保存。修改公式缓存会失效，打开Office时重算，不伪造结果。不能插入或删除行：新内容比原来行数少时，把多出来的行设为value:null清空，改完不能留下重复行。新增行列或大改结构用create_document。',
      input_schema: S(
        {
          path: str('工作区xlsx路径'),
          save_as: str('另存路径，可选'),
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: S(
              {
                sheet: str('实际工作表名'),
                cell: str('A1式地址'),
                value: { type: ['string', 'number', 'boolean', 'null'] },
                formula: str('公式，与value二选一'),
                expected: { type: ['string', 'number', 'boolean', 'null'] }
              },
              ['sheet', 'cell']
            )
          }
        },
        ['path', 'edits']
      ),
      run: async ({ path, edits, save_as: saveAs }, options = {}) => {
        if (ws.ext(path) !== 'xlsx') throw documentError('只支持xlsx工作簿');
        const edited = await editSpreadsheet(await ws.readBlob(path), edits, { signal: options.signal });
        const target = saveAs ? saveAs.replace(/\.[a-z0-9]+$/i, '') + '.xlsx' : path;
        const saved = await deliverDocument(ctx, { blob: edited.blob, ext: 'xlsx' }, target, options);
        return `已修改${edited.changed}个单元格，保存${saved.path}；${saved.notes.join('；')}`;
      }
    }
  ];
}
