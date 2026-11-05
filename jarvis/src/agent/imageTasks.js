/**
 * 图片处理（智能体专业化第 3、5 批）：抠图去背景、证件照换底色、老照片修复、放大清晰化。
 * 走已配置的“原图编辑”能力（与 generate_image 传参考图同一条线路），每种处理用固定的专业要求；
 * 原图永远保留，结果另存一份；没有编辑能力时明确报错，不拿“重新生成”冒充处理。
 * 本地离线抠图模型（开源分割模型）需要先核实许可证和体积，本批未内置。
 */
import * as ws from './workspace.js';
import { assertImageExtension } from './imageFormat.js';

export const ID_PHOTO = { '一寸': [295, 413], '二寸': [413, 579], '小二寸': [413, 531] };
const COLORS = { 白: '#FFFFFF', 蓝: '#438EDB', 红: '#D9001B' };

/** 每种处理交给编辑模型的要求和参数 */
export function imageTaskPrompt(task, { color = '白', spec = '一寸' } = {}) {
  switch (task) {
    case 'remove_background':
      return { prompt: '只去除背景，背景完全透明；主体（人物或物品）的轮廓、头发丝、颜色和细节保持原样，不改变主体，不增加任何东西。', background: 'transparent', outputFormat: 'png' };
    case 'id_photo': {
      const [w, h] = ID_PHOTO[spec] || ID_PHOTO['一寸'];
      return { prompt: `做成标准${spec}证件照：背景换成纯${color}色（${COLORS[color] || COLORS.白}），无渐变无阴影；人物正面居中，头顶留少量空白，露出双肩；保持本人五官、发型、肤色、衣着不变，不美颜不改脸；比例 ${w}:${h}。`, size: '1024x1536', outputFormat: 'png' };
    }
    case 'restore':
      return { prompt: '修复这张老照片：去除划痕、折痕、污渍和噪点，修复褪色，适度提升清晰度；严格保持人物相貌、表情、服装、背景和构图不变，不添加不存在的细节；原来是黑白照片就保持黑白。', quality: 'high' };
    case 'upscale':
      return { prompt: '在不改变任何内容的前提下提升清晰度和细节：边缘锐利、纹理自然，不改变构图、颜色、文字和人物相貌。', quality: 'high' };
    default:
      throw Object.assign(new Error(`不支持的图片处理：${task}`), { name: 'ValidationError', code: 'INVALID_IMAGE_TASK', kind: 'input' });
  }
}

const TASK_NAMES = { remove_background: '抠图去背景', id_photo: '证件照', restore: '老照片修复', upscale: '清晰化' };

export function createImageTaskTool(ctx = {}) {
  return {
    name: 'process_image',
    description: '图片处理：remove_background 抠图去背景（透明 PNG）、id_photo 证件照换底色（白 / 蓝 / 红，一寸 / 二寸 / 小二寸）、restore 老照片修复、upscale 清晰化。必须是用户上传或工作区里的原图；原图保留，结果另存；需要已配置的原图编辑能力。',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', enum: Object.keys(TASK_NAMES) },
        path: { type: 'string', description: '工作区里的原图（PNG / JPEG / WebP，10MB 以内）' },
        color: { type: 'string', enum: Object.keys(COLORS), description: '证件照底色' },
        spec: { type: 'string', enum: Object.keys(ID_PHOTO), description: '证件照规格' }
      },
      required: ['task', 'path'],
      additionalProperties: false
    },
    run: async ({ task, path, color = '白', spec = '一寸' } = {}, { signal, retrieval } = {}) => {
      if (!ctx.imageEdit) throw Object.assign(new Error('当前线路没有原图编辑能力：请在“模型 → 能力表”给“画图”配置支持图片编辑的模型（如 gpt-image 系列），或换用支持编辑的服务商；不会拿重新生成冒充处理'), { code: 'IMAGE_EDIT_UNAVAILABLE', kind: 'capability' });
      if (!/\.(png|jpe?g|webp)$/i.test(String(path))) throw Object.assign(new Error('原图需为 PNG / JPEG / WebP'), { name: 'ValidationError', code: 'IMAGE_EDIT_INPUT', kind: 'input' });
      const source = await ws.readBlob(path);
      if (source.size > 10e6) throw Object.assign(new Error('原图需在 10MB 以内'), { name: 'ValidationError', code: 'IMAGE_EDIT_INPUT', kind: 'input' });
      const { prompt, ...options } = imageTaskPrompt(task, { color, spec });
      const r = await ctx.imageEdit({ prompt, images: [source], size: options.size || 'auto', signal, beforeRequest: () => retrieval?.consume?.('model'), ...options });
      const ext = /jpe?g/.test(r.blob.type) ? 'jpg' : /webp/.test(r.blob.type) ? 'webp' : 'png';
      await assertImageExtension('image.' + ext, r.blob);
      const base = String(path).replace(/^.*\//, '').replace(/\.[^.]+$/, '');
      const saved = await ws.write(`images/${base}-${TASK_NAMES[task]}${task === 'id_photo' ? `-${spec}${color}底` : ''}-${Date.now().toString(36)}.${ext}`, r.blob);
      ctx.onFileChanged?.(saved.path);
      ctx.onImage?.(URL.createObjectURL(r.blob), saved.path);
      return `${TASK_NAMES[task]}完成（${r.model}），原图 ${path} 未改动，结果另存为 ${saved.path}。这是模型处理的结果，请用 inspect_image 看一眼主体有没有被改动（五官、文字、边缘）${task === 'id_photo' ? `；${spec}标准像素是 ${ID_PHOTO[spec].join('×')}，打印或上传前按要求裁切` : ''}。`;
    }
  };
}
