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
import { collection } from './store.js';
import { AGENT_FLOW_TOOLS } from './agentTurn.js';

// 待确认步骤只读资料与规划，不能靠提示语阻止模型提前生成或覆盖文件。
const REVIEW_TOOLS = new Set([...AGENT_FLOW_TOOLS, 'web_search', 'fetch_url', 'read_evidence', 'read_file', 'kb_search', 'list_files', 'get_document_template', 'read_document_structure', 'verify_numbers', 'reconcile_numbers', 'time_calc']);

/** 每段对话的工作流进度（做完的步骤和结果）：中途失败后回“继续”从失败那一步接着做 */
const progressStore = collection('kv');
const progressKey = (sessionId) => `workflow-progress:${sessionId}`;
export const RESUME_RE = /^\s*(继续|确认继续|按此提纲继续|接着做|接着|重试|从失败的地方继续)\s*[。.!！]?\s*$/;

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
  const sessionId = options.sessionId || null;
  // 回“继续”：同一个工作流上次没做完，就带上做完的步骤，从失败那一步接着做
  const progress = progressStore.bind();
  const signature = JSON.stringify(steps);
  const saved = sessionId ? await progress.get(progressKey(sessionId)) : null;
  const continueRequested = RESUME_RE.test(String(userText || ''));
  const resume = saved?.agentId === profile.id && (!saved.signature || saved.signature === signature) && saved.steps?.length < steps.length && (continueRequested || saved.paused) ? saved : null;
  const revising = resume?.paused && !continueRequested;
  const previous = resume ? [...resume.steps] : [];
  if (revising) previous.pop();
  const originalText = revising ? `${resume.userText}\n本次修改意见：${clip(userText, 4000)}` : resume?.userText || userText;
  const remember = (paused = false) => sessionId && progress.put({ id: progressKey(sessionId), agentId: profile.id, signature, paused, userText: clip(originalText, 12000), steps: previous.map(p => ({ ...p, text: clip(p.text, 6000) })) });
  let toolCalls = 0;
  if (resume) emit({ type: 'text', delta: `> 接着上次的进度：前 ${previous.length} 步已完成，从第 ${previous.length + 1} 步继续。\n\n` });
  for (const [index, step] of steps.entries()) {
    if (index < previous.length) continue;
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    // 条件步骤：上一步结果里没出现指定的话就跳过
    if (step.onlyIf && !String(previous.at(-1)?.text || '').includes(step.onlyIf)) {
      emit({ type: 'tool_start', id: `workflow-${index}`, name: 'workflow_step', args: { step: index + 1, title: step.title } });
      emit({ type: 'tool_end', id: `workflow-${index}`, name: 'workflow_step', ok: true, output: `跳过：上一步结果里没有“${step.onlyIf}”`, ms: 0 });
      previous.push({ index, title: step.title, text: `（已跳过：上一步结果里没有“${step.onlyIf}”）`, skipped: true });
      await remember();
      continue;
    }
    // 交给哪个智能体：没写就用工作流自己的角色；写了就按编号查（找不到报错，不悄悄换成别的）
    let stepProfile = base;
    if (step.agentId) {
      stepProfile = BUILTIN_AGENTS.find((p) => p.id === step.agentId) || (await lookup(step.agentId));
      if (!stepProfile) throw Object.assign(new Error(`工作流第 ${index + 1} 步要用的智能体不存在：${step.agentId}`), { name: 'ValidationError', code: 'AGENT_NOT_FOUND', kind: 'input' });
    }
    emit({ type: 'text', delta: `${index ? '\n\n' : ''}### 第 ${index + 1} 步 · ${step.title}\n\n` });
    // 每一步一张进度卡：开始、完成或失败、用时
    const startedAt = Date.now();
    emit({ type: 'tool_start', id: `workflow-${index}`, name: 'workflow_step', args: { step: index + 1, total: steps.length, title: step.title } });
    const prompt = stepPrompt({ workflow: profile.name, step, index, total: steps.length, userText: originalText, previous: previous.filter((p) => !p.skipped) });
    const once = (text) => run({ ...options,
      ...(step.review && { tools: (options.tools || []).filter(tool => REVIEW_TOOLS.has(tool.name)) }),
      userText: text, requirementText: text,
      agent: { profile: { ...stepProfile, steps: undefined, ...(step.review && { tools: [...new Set(['read_task_requirements', ...(stepProfile.tools?.length ? stepProfile.tools : [...REVIEW_TOOLS]).filter(name => REVIEW_TOOLS.has(name))])] }) }, note: agent.note }
    });
    let result;
    try {
      result = await once(prompt);
    } catch (error) {
      emit({ type: 'tool_end', id: `workflow-${index}`, name: 'workflow_step', ok: false, output: `第 ${index + 1} 步失败：${error?.message || error}`, ms: Date.now() - startedAt });
      if (error?.name !== 'AbortError') emit({ type: 'text', delta: `\n\n> 第 ${index + 1} 步没做成：${error?.message || error}。前面做完的步骤已保存，回复“继续”从这一步接着做。\n` });
      throw error;
    }
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
    emit({ type: 'tool_end', id: `workflow-${index}`, name: 'workflow_step', ok: true, output: `第 ${index + 1}/${steps.length} 步「${step.title}」完成${step.check && step.check !== 'none' ? `，已做${CHECK_NAMES[step.check]}` : ''}`, ms: Date.now() - startedAt });
    await remember();
    if (step.review && index < steps.length - 1) {
      if (!sessionId) throw Object.assign(new Error('提纲确认需要可保存的对话，请在对话中运行此工作流'), { code: 'WORKFLOW_SESSION_REQUIRED' });
      await remember(true);
      const note = '\n\n提纲已保存，请核对内容和版式。回复“确认继续”后制作；直接提出修改意见会先修改本步，不会提前生成后续作品。';
      emit({ type: 'text', delta: note });
      return { text: previous.map(p => `### 第 ${p.index + 1} 步 · ${p.title}\n\n${p.text}`).join('\n\n') + note, toolCalls, steps: previous.length, workflow: true, awaitingReview: true };
    }
  }
  if (sessionId) await progress.delete(progressKey(sessionId));
  const text = previous.map((p) => `### 第 ${p.index + 1} 步 · ${p.title}\n\n${p.text}`).join('\n\n');
  return { text, toolCalls, steps: previous.length, workflow: true };
}
