/**
 * 识别图片里的字：工作区里的截图、照片、扫描版 PDF → 原样的文字和表格（Markdown），用能力表“文字识别”（智谱 GLM-OCR）。
 * 看懂画面（场景、人物、物体）还是用 read_file 看图；这里只抄字，大段文字、复杂表格更准。
 */
import * as ws from './workspace.js';
import { visualFields } from './visualFields.js';
import { imageFingerprint, scoreRows, visualReceiptText } from './visualEvidence.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', pdf: 'application/pdf' };

/** @param {{ ocr?: Function | null }} ctx  ocr(file, { signal }) → { text, model } */
export function createOcrTool(ctx) {
  return {
    name: 'read_image_text',
    description:
      '识别工作区里图片或扫描版 PDF 中的文字和表格，原样输出（Markdown，表格保留行列）。用户要提取截图、照片、扫描件里的文字，把表格照片整理成 Excel / Word，或 read_file 读 PDF 没读出字时使用。只要看懂画面内容时用 read_file。',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: '工作区里的图片或 PDF 路径' } }, required: ['path'], additionalProperties: false },
    run: async ({ path }, { signal } = {}) => {
      if (!ctx.ocr) throw Object.assign(new Error('还没有能做文字识别的服务商：在模型页填上智谱的 Key（会自动用 GLM-OCR）；也可以先用 read_file 看图读字'), { code: 'OCR_UNAVAILABLE', kind: 'api' });
      const ext = String(path).split('.').pop().toLowerCase();
      if (!MIME[ext]) throw Object.assign(new Error('只能识别图片（png / jpg / webp / gif / bmp）和 PDF'), { code: 'OCR_INPUT', kind: 'input' });
      const blob = await ws.readBlob(path);
      const { text, model } = await ctx.ocr({ blob, mime: MIME[ext] }, { signal });
      const receipt = visualReceiptText({ kind: 'ocr', ok: true, imageHash: await imageFingerprint(blob), model, rows: scoreRows(text), fields: visualFields(text) });
      return `${receipt}\n识别成功不代表内容已核实；表格须逐行核对，看不清或来源冲突不要猜。\n【${path} 里的文字（${model} 识别，原样抄录）】\n${text}`;
    }
  };
}
