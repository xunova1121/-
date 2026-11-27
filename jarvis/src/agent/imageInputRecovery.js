/** 原图复核参数最多纠正一次；只保存本轮有界计数，不把问题原文或图片放进状态。 */
import { normalize } from './workspace.js';

const STATE = Symbol('imageInputRecovery');
const INPUT_CODES = new Set(['INVALID_TOOL_ARGS', 'IMAGE_REGION', 'IMAGE_INPUT']);
const MAX_TARGETS = 24;

function target(args) {
  const path = typeof args?.path === 'string' ? args.path : '';
  try { return normalize(path).slice(0, 400); }
  catch { return path.trim().slice(0, 400) || '未指定图片'; }
}

export function resetImageInputRecovery(scope) {
  scope?.[STATE]?.clear();
}

/** executionScope（或旧调用的seen）由每轮执行器持有，轮次之间没有共享失败计数。 */
export function recordImageInputRecovery(scope, name, args, failure) {
  if (name !== 'inspect_image' || !scope || typeof scope !== 'object') return null;
  if (!Object.hasOwn(scope, STATE)) Object.defineProperty(scope, STATE, { value: new Map() });
  const counts = scope[STATE], key = target(args);
  if (!failure) { counts.delete(key); return null; }
  // 参数错误与视觉模型/网络错误分开；后者不消耗参数纠正机会。
  if (failure.name === 'AbortError' || !INPUT_CODES.has(failure.code)) return null;
  if (failure.kind !== 'input' && !(failure.code === 'IMAGE_REGION' && failure.kind == null)) return null;
  const failures = Math.min(2, (counts.get(key) || 0) + 1);
  counts.delete(key);
  counts.set(key, failures);
  if (counts.size > MAX_TARGETS) counts.delete(counts.keys().next().value);
  return {
    failures,
    stopped: failures === 2,
    message: failures === 2
      ? '原图复核参数连续未通过，本次没有完成复核；已有描述不等于本次复核结果。已停止本轮重复调用，已有文件和此前实际成功的核验结果仍保留。'
      : '请按最小参数纠正一次：path为原图工作区路径，question为要核对的问题；无需裁剪时省略region/regions。需要局部时region用{x:0,y:0,width:1,height:1}这类0～1数字，不能越界。不要只换问题文字重复失败调用。'
  };
}
