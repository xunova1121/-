/**
 * 任务清单（update_plan 工具）：复杂任务先列步骤，做一步勾一步，界面上实时显示。
 * 做完前对照清单：还有没勾掉的步骤，提醒模型接着做或说明原因（见 agent.js 的收尾核对）。
 */
export const PLAN_STATUS = { todo: '未开始', doing: '进行中', done: '已完成', skip: '不做了' };
const ALIAS = { pending: 'todo', in_progress: 'doing', completed: 'done', cancelled: 'skip', 未开始: 'todo', 进行中: 'doing', 已完成: 'done', 不做了: 'skip' };

/** 整理模型给的步骤：去空、限长、状态统一成 todo / doing / done / skip，最多 12 步 */
export function normalizePlan(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map((s) => (typeof s === 'string' ? { text: s } : s || {}))
    .map((s) => ({ text: String(s.text ?? s.step ?? s.title ?? '').trim().slice(0, 80), status: PLAN_STATUS[s.status] ? s.status : ALIAS[s.status] || 'todo' }))
    .filter((s) => s.text)
    .slice(0, 12);
}

export const unfinished = (steps) => steps.filter((s) => s.status === 'todo' || s.status === 'doing');

/** @param {(steps: Array<{ text: string, status: string }>) => void} onChange */
export function createPlanTool(onChange = () => {}) {
  let steps = [];
  const tool = {
    name: 'update_plan',
    description: '任务清单：要 3 步以上才能做完的任务，先用它列出 3–8 个步骤（每步写成做完后能检查的结果），之后每开始 / 做完一步就再调用一次，把整份清单连同最新状态一起传进来。用户在界面上能看到清单和进度。简单问题、闲聊不要用。',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '完整的步骤清单（每次都传全部步骤）',
          items: { type: 'object', properties: { text: { type: 'string', description: '这一步要得到什么结果' }, status: { type: 'string', enum: ['todo', 'doing', 'done', 'skip'], description: 'todo 未开始 / doing 进行中 / done 已完成 / skip 不做了' } }, required: ['text', 'status'], additionalProperties: false }
        }
      },
      required: ['steps'],
      additionalProperties: false
    },
    run: async ({ steps: next }) => {
      steps = normalizePlan(next);
      if (!steps.length) throw new Error('清单是空的：请给出 3–8 个步骤');
      onChange(steps);
      const done = steps.filter((s) => s.status === 'done').length;
      const left = unfinished(steps);
      return `清单已更新（完成 ${done}/${steps.length}）${left.length ? `；接下来：${left[0].text}` : '；全部完成，可以对照用户的要求检查后给出最终回答'}`;
    }
  };
  return { tool, get steps() { return steps; } };
}
