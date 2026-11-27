/** 仅明确作为排版素材的生图才加范围限制；直接画整张带字图时保持原请求。 */
import { textPosterRequest, directModelTextRequest } from './posterRouting.js';
import { visualSceneRequest } from './visualSceneRouting.js';

export function compositionToolArgs(toolName, args, requirementText) {
  if (toolName !== 'generate_image' || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  if (directModelTextRequest(requirementText)) return args.purpose === 'poster_art' ? { ...args, purpose: 'general' } : args;
  // 卡槽底图（poster_slots）本身就是给程序填字用的无字底图，保留其版式计划，不改成poster_art
  if (args.purpose === 'poster_slots') return args;
  return textPosterRequest(requirementText) || visualSceneRequest(requirementText) ? { ...args, purpose: 'poster_art' } : args;
}

export function imageCompositionPrompt(text, purpose = 'general') {
  if (!['general', 'poster_art'].includes(purpose)) throw Object.assign(new Error('图片用途需为general或poster_art'), { code: 'IMAGE_PURPOSE', kind: 'input' });
  if (purpose !== 'poster_art') return text;
  if (typeof text !== 'string' || text.length > 11000) throw Object.assign(new Error('海报素材描述需为11000字以内的文本'), { code: 'IMAGE_PURPOSE', kind: 'input' });
  return text + '\n\n制作范围：这张只用作后续程序排版的视觉素材，只画主体、场景、光线和材质。不要任何文字、字母、数字、标题、徽标、水印；不要新闻列表、按钮、白色空卡片、空胶囊框或UI占位框，也不要预留一组等待填字的卡片。标题、正文和装饰卡片会在下一步独立排版。不要把完整宣传页截图当成素材。';
}
