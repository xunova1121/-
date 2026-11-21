import { imageData } from './imageRegion.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';

export const PORTRAIT_TASKS = { portrait_retouch: '人像美颜', portrait_slim: '人像显瘦' };
export const PORTRAIT_STRENGTHS = ['natural', 'moderate', 'strong'];
export const isPortraitTask = task => Object.hasOwn(PORTRAIT_TASKS, task);

export function portraitTaskPrompt(task, { strength = 'natural', instructions = '' } = {}) {
  if (!isPortraitTask(task) || !PORTRAIT_STRENGTHS.includes(strength)) throw Object.assign(new Error('请选择有效的人像处理方式和力度'), { code: 'INVALID_PORTRAIT_TASK', kind: 'input' });
  if (typeof instructions !== 'string' || instructions.length > 1200) throw Object.assign(new Error('人像补充要求最多1200字'), { code: 'INVALID_PORTRAIT_TASK', kind: 'input' });
  const amount = { natural: '轻微自然，尽量看不出修图痕迹', moderate: '适度明显，仍符合真实人体比例', strong: '按用户要求增强效果，但不得极端拉伸、扭曲或改变五官骨骼' }[strength];
  const goal = task === 'portrait_slim'
    ? '在原图上做自然显瘦：针对用户指定人物和部位微调身形与衣物轮廓；未指定部位时只轻微调整腰身、肩臂和轮廓，不擅自瘦脸或拉长腿。保持衣服纹理、背景直线和四肢结构，不出现液化变形。可适度优化肤色与光线。'
    : '在原图上自然美颜：适度均匀肤色、改善光线，淡化临时痘印与细小瑕疵；保留皮肤纹理、自然细纹、表情和个人特征，不磨成塑料皮肤，不擅自改变脸型或身体形状。';
  return {
    prompt: `这是用户原片的局部修图，不是重新生成一个人。${goal}\n力度：${amount}。\n严格保留原人物的五官外观、年龄特征、发型、衣着、姿势、构图、镜头透视和背景；不要换脸、变年轻、换装、改背景，不添加文字或水印，不删除原有标识。多人照片只处理用户明确指定的对象；对象不明确时不擅自改变其他人。保持原图方向和比例，输出尽量清晰的原始文件，不用缩略图冒充高清。${instructions.trim() ? '\n用户的本次补充要求：' + instructions.trim() : ''}`,
    quality: 'high', outputFormat: 'png'
  };
}

const FIELDS = ['appearancePreserved', 'naturalSkin', 'naturalProportions', 'backgroundPreserved', 'noArtifacts', 'requestedChangeVisible'];

export function parsePortraitReview(text) {
  if (String(text || '').length > 6000) return { state: 'not_checked', issues: ['视觉检查回执过长，未当作有效的对照结论'] };
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { return { state: 'not_checked', issues: ['视觉检查未返回有效的对照结论'] }; }
  const checks = Object.fromEntries(FIELDS.map(field => [field, typeof parsed?.[field] === 'boolean' ? parsed[field] : null]));
  const validIssues = Array.isArray(parsed?.issues) && parsed.issues.every(item => typeof item === 'string');
  const issues = Array.isArray(parsed?.issues) ? parsed.issues.filter(item => typeof item === 'string').slice(0, 6).map(item => item.slice(0, 160)) : [];
  const state = Object.values(checks).some(value => value === false) || issues.length ? 'needs_review' : validIssues && Object.values(checks).every(value => value === true) ? 'reviewed' : 'not_checked';
  return { state, checks, issues, basis: '模型对两张原文件的视觉对照，不是绝对保真或身份鉴定' };
}

/** 只检查一次；失败保留候选，不自动再修一张、重试收费或偷偷联网。 */
export async function reviewPortrait(ctx, original, edited, { signal, retrieval, task, instructions = '' } = {}) {
  if (!ctx.visionLlm) return { state: 'not_checked', issues: ['当前没有配置视觉对照能力，请对照原片确认效果'] };
  if (original.size + edited.size > 20e6) return { state: 'not_checked', issues: ['原片和结果合计超过对照上限，已保留原文件，未压缩后冒充原图核验'] };
  try {
    throwControl(null, signal);
    const images = await Promise.all([original, edited].map(blob => imageData(blob, { detail: 'high' })));
    throwControl(null, signal);
    retrieval?.consume?.('model');
    const result = await withWebDeadline(activeSignal => ctx.visionLlm({
      system: '比较图1原片与图2修图候选，仅核对可见外观，不识别真实身份，不猜年龄数字。五官外观或年龄特征非预期变化、塑料皮肤、身体比例异常、衣物或背景扭曲、手指/四肢伪影均须标记；还须判断用户要求的美颜或显瘦变化是否实际可见，不能把完全没变化当修图成功。不因为提示要求“保真”就声称已保真。只返回JSON，六个字段必须各为true/false/null：appearancePreserved、naturalSkin、naturalProportions、backgroundPreserved、noArtifacts、requestedChangeVisible；issues数组最多6条，看不清或不能判断用null。',
      prompt: `任务：${PORTRAIT_TASKS[task]}。用户补充：${String(instructions).slice(0, 1200)}。只判断这两张实际图片，输出对照结论。`,
      images, signal: activeSignal, allowWebSearch: false, maxWebSearches: 0, maxTransientRetries: 0, maxPartialRetries: 0
    }), { signal, timeoutMs: 25000 });
    return parsePortraitReview(result);
  } catch (error) {
    throwControl(error, signal);
    return { state: 'not_checked', issues: ['本次视觉对照没有完成，修图候选已保留，未自动重试或重新生成'], code: String(error.code || error.name || 'PORTRAIT_REVIEW').slice(0, 80) };
  }
}
