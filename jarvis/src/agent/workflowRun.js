/**
 * 工作流（智能体编排层）：一个智能体配置里写了 steps，就按步骤顺序执行。
 * 不另造执行引擎：每一步都调用同一个底座 runAgent，带上该步的智能体配置（角色、专业方法、工具范围），
 * 前面步骤的结果作为本步材料；做完按 check 做确定性检查（公文体检、数字前后一致），不合格把问题交回去重做一次。
 * 权限不会因为编排变大：每步的工具仍是底座原有工具与该步智能体白名单的交集。
 */
import { runAgent } from './agent.js';
import { getAgent, BUILTIN_AGENTS } from './agentProfiles.js';
import { checkGongwen, gongwenIssueNote } from './gongwenCheck.js';
import { conflictingNumbers } from './numberReconcile.js';

/** 每种检查：返回问题说明，没有问题返回空 */
export const STEP_CHECKS = {
  none: () => '',
  gongwen: (text) => gongwenIssueNote(checkGongwen(text)),
  numbers: (text) => conflictingNumbers(text).join('\n')
};
export const CHECK_NAMES = { none: '不检查', gongwen: '公文体检', numbers: '数字前后一致' };

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…（已截断）` : String(s));

/** 第 i 步交给模型的要求 */
export function stepPrompt({ workflow, step, index, total, userText, previous }) {
  return [
    `【工作流「${workflow}」第 ${index + 1}/${total} 步：${step.title}】`,
    `这一步要做：${step.task}`,
    `用户的要求：${userText}`,
    previous.length ? `前面步骤的结果（作为本步材料，不要重复做）：\n${previous.map((p) => `—— 第 ${p.index + 1} 步 ${p.title} ——\n${clip(p.text, 4000)}`).join('\n\n')}` : '',
    index < total - 1 ? '只完成这一步，不要提前做后面的步骤；结果写清楚，后面的步骤会用到。' : '这是最后一步：整理成给用户的最终交付。'
  ].filter(Boolean).join('\n\n');
}

/**
 * @param {object} options  和 runAgent 一样的参数；options.agent = { profile, note }，profile.steps 是步骤
 * @param {{ run?: Function, lookup?: Function }} deps  测试时可替换
 */
export async function runWorkflow(options, { run = runAgent, lookup = getAgent } = {}) {
  const { agent, userText, emit = () => {}, signal } = options;
  const profile = agent?.profile;
  const steps = profile?.steps || [];
  if (!steps.length) return run(options);
  const base = { ...profile, steps: undefined };
  const previous = [];
  let toolCalls = 0;
  for (const [index, step] of steps.entries()) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    // 交给哪个智能体：没写就用工作流自己的角色；写了就按编号查（找不到报错，不悄悄换成别的）
    let stepProfile = base;
    if (step.agentId) {
      stepProfile = BUILTIN_AGENTS.find((p) => p.id === step.agentId) || (await lookup(step.agentId));
      if (!stepProfile) throw Object.assign(new Error(`工作流第 ${index + 1} 步要用的智能体不存在：${step.agentId}`), { name: 'ValidationError', code: 'AGENT_NOT_FOUND', kind: 'input' });
    }
    emit({ type: 'text', delta: `${index ? '\n\n' : ''}### 第 ${index + 1} 步 · ${step.title}\n\n` });
    emit({ type: 'tool_progress', id: 'workflow', text: `工作流第 ${index + 1}/${steps.length} 步：${step.title}` });
    const prompt = stepPrompt({ workflow: profile.name, step, index, total: steps.length, userText, previous });
    const once = (text) => run({ ...options, userText: text, requirementText: text, agent: { profile: { ...stepProfile, steps: undefined }, note: agent.note } });
    let result = await once(prompt);
    toolCalls += result?.toolCalls || 0;
    const issue = STEP_CHECKS[step.check || 'none']?.(result?.text || '') || '';
    if (issue) {
      emit({ type: 'text', delta: `\n\n> ${CHECK_NAMES[step.check]}发现问题，正在按问题修改这一步……\n\n` });
      result = await once(`${prompt}\n\n上一次的结果没有通过检查，请逐条改正后重新给出这一步的完整结果：\n${issue}\n\n上一次的结果：\n${clip(result?.text || '', 6000)}`);
      toolCalls += result?.toolCalls || 0;
      const still = STEP_CHECKS[step.check]?.(result?.text || '') || '';
      if (still) emit({ type: 'text', delta: `\n\n> 改了一次仍有问题，请人工核对：\n${still}\n` });
    }
    previous.push({ index, title: step.title, text: result?.text || '' });
  }
  const text = previous.map((p) => `### 第 ${p.index + 1} 步 · ${p.title}\n\n${p.text}`).join('\n\n');
  return { text, toolCalls, steps: previous.length, workflow: true };
}
