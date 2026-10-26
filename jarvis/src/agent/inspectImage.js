import * as workspace from './workspace.js';
import { throwControl } from '../core/networkRequest.js';
import { cropImageRegion, visualRegion, imageData } from './imageRegion.js';
import { imageFingerprint, visualReceiptText } from './visualEvidence.js';
import { visualFields } from './visualFields.js';
import { imageFormat } from './imageFormat.js';
import { diagramPreview } from './diagramReview.js';
import { assertDiagramTarget } from './diagramTarget.js';

/** 一次原图复核最多各调用视觉/OCR一次；不缓存图像或识别正文。 */
export function createInspectImageTool(ctx) {
  return {
    name: 'inspect_image',
    description:
      '重新读取工作区原图，核对场景、仪表数字或参考图。数字看不清或用户纠错时指定region局部裁剪放大；每个字段逐项给原始数字与单位，看不清不补零，冲突保留。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        question: { type: 'string', maxLength: 1000 },
        region: {
          type: 'object',
          properties: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, { type: 'number', minimum: 0, maximum: 1 }])),
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false
        },
        readText: { type: 'boolean', description: '需要读数字或文字时同时尝试OCR；没有配置则明确提示' }
      },
      required: ['path', 'question'],
      additionalProperties: false
    },
    run: async ({ path, question, region, readText = true }, { signal, rawRequestText } = {}) => {
      assertDiagramTarget(path, rawRequestText);
      visualRegion(region);
      if (!/\.(svg|png|jpe?g|webp|gif|bmp)$/i.test(path)) throw Object.assign(new Error('局部复核仅支持图片或SVG文件'), { code: 'IMAGE_INPUT', kind: 'input' });
      const original = await workspace.readBlob(path);
      if (original.size > 10e6) throw Object.assign(new Error('原图超过10MB，需先压缩'), { code: 'IMAGE_SIZE', kind: 'input' });
      const imageHash = await imageFingerprint(original);
      let image = original;
      let cropped = false;
      const notes = [];
      if ((await imageFormat(original))?.ext === 'svg') {
        image = await diagramPreview(ctx, await original.text(), { signal });
        if ((await imageFormat(image))?.ext !== 'png') throw Object.assign(new Error('SVG未转换为真实PNG'), { code: 'SVG_RENDER_INVALID', kind: 'api' });
        notes.push('已将指定SVG内容实际渲染为PNG后复核，源文件未修改。');
      }
      if (region) {
        try {
          image = await (ctx.cropImage || cropImageRegion)(image, region, { signal });
          cropped = true;
        } catch (error) {
          throwControl(error, signal);
          if (error.code !== 'IMAGE_CROP_UNAVAILABLE') throw error;
          notes.push('当前环境无法物理裁剪；视觉模型只能按指定区域查看整图，不算完成局部放大。');
        }
      }
      const results = [];
      let failure = null;
      if (ctx.visionLlm) {
        try {
          const text = String(
            (await ctx.visionLlm({
              system:
                '读取本次提供的原始图片。只写可见事实；数字逐字段写“标签：原始数字 单位”，保留前导零和小数点，看不清写看不清，不按常识补位。区分观察与推测。用户纠错后不得引用旧描述作识别依据。',
              prompt: String(question).slice(0, 1000) + (region && !cropped ? '\n仅关注归一化区域：' + JSON.stringify(region) : ''),
              images: [await imageData(image)],
              signal
            })) || ''
          ).trim();
          if (!text) throw Object.assign(new Error('视觉模型未返回识别内容'), { code: 'IMAGE_INSPECT_EMPTY', kind: 'api' });
          results.push({ kind: 'vision', text });
        } catch (error) {
          throwControl(error, signal);
          failure = error;
          notes.push('本次视觉模型读取失败，不能声称已重新看清。');
        }
      }
      if (readText && ctx.ocr && (!region || cropped)) {
        try {
          const result = await ctx.ocr({ blob: image, mime: image.type }, { signal });
          results.push({ kind: 'ocr', text: result.text, model: result.model });
        } catch (error) {
          throwControl(error, signal);
          failure = error;
          notes.push('本次OCR失败，不能声称OCR已确认。');
        }
      } else if (readText) notes.push(region && !cropped ? '未把整图OCR冒充局部识别。' : '当前未配置OCR，仅有视觉模型结果。');
      if (!results.length && failure) throw failure;
      if (!results.length)
        throw Object.assign(new Error(notes.join(' ') || '请先配置看图模型或OCR'), { code: 'IMAGE_INSPECT_UNAVAILABLE', kind: 'capability' });
      const receipt = {
        kind: results.some((result) => result.kind === 'ocr') ? 'ocr' : 'vision',
        ok: true,
        imageHash,
        cropped,
        fields: results.flatMap((result) => visualFields(result.text)).slice(0, 20)
      };
      return (
        visualReceiptText(receipt) +
        '\n' +
        notes.join('\n') +
        '\n识别结果是候选，来源冲突必须报告；数字不合理不能擅自改数。\n' +
        results.map((result) => `【${result.kind}${cropped ? ' · 已裁剪放大' : ' · 原图'}】\n${String(result.text).slice(0, 12000)}`).join('\n')
      );
    }
  };
}
