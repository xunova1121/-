import { withWebDeadline } from '../../agent/retrievalBudget.js';
import { generateTaskBrief } from './taskBrief.js';
import { reviewDocument } from './contentReview.js';
import { reviseDocument } from './targetedRevision.js';
import { boundedText, LIMITS, workflowError } from './workflowSchema.js';
import { documentDepth, WRITING_RULES } from './workflowPolicy.js';
import { detectRole, roleGuide, roleKey, ROLES } from './writingRoles.js';
import { createWorkflowStore } from './workflowStore.js';
import { writeLongDocument } from '../../agent/longDoc.js';
import { STYLE_IDS } from '../../agent/pptStyles.js';

function newState(input, execution) {
  const task = boundedText(input.task, LIMITS.task, '原始要求', true);
  const material = boundedText(input.material, LIMITS.material, '用户材料');
  const format = input.format || 'docx';
  const role = input.role === 'internal' ? null : roleKey(input.role) || detectRole(task);
  if (!['docx', 'pdf', 'html', 'md', 'pptx', 'xlsx'].includes(format)) throw workflowError('不支持的文档格式', 'DOCUMENT_INPUT');
  if (input.style && (format !== 'pptx' || !STYLE_IDS.includes(input.style))) throw workflowError('PPT风格参数无效', 'DOCUMENT_INPUT');
  const id = globalThis.crypto.randomUUID();
  const referenceTime = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return {
    version: 3,
    id,
    folder: `文档流程/${id}`,
    sessionId: execution.sessionId ?? null,
    phase: 'new',
    calls: 0,
    revisionAttempts: 0,
    timings: [],
    // 写作角色：调用方指定的优先，internal 表示明确要内部分析口吻；auto / 没填按原话认
    input: { task, material, format, allowResearch: input.research !== false, referenceTime, role, ...(input.style ? { style: input.style } : {}) },
    // 有写作角色的（给客户的方案、合同、实施方案……）走完整流程：要按角色审一遍、查推辞话术
    depth: role && ['auto', undefined].includes(input.depth) ? 'expert' : documentDepth({ task, format, depth: input.depth }),
    business: 'not_checked',
    tokens: null
  };
}

function resultSummary(state) {
  return {
    stateFile: state.stateFile,
    phase: state.phase,
    depth: state.depth,
    calls: state.calls,
    business: state.business,
    tokens: null,
    unresolved: state.review?.issues?.filter((item) => item.severity === 'must_fix').length ?? 0,
    warningCount: state.review?.issues?.filter((item) => item.severity === 'warning').length ?? 0,
    reviewMode: state.reviewMode || 'not_checked',
    reviewNote:
      state.reviewMode === 'same_model'
        ? '审查与写作为同一模型'
        : state.reviewMode === 'configured_reviewer'
          ? '使用已配置的文档审查线路（是否为不同模型取决于所选型号）'
          : '尚未进行内容审查',
    researchStatus: state.research?.status || 'not_run'
  };
}

// 工厂不提前摘取其他模块，实际调用时才从app取得模型和工作区。
export function createDocumentWorkflow(app) {
  async function run(input, execution = {}, prepareOnly = false) {
    const store = createWorkflowStore(app, execution);
    const state = input.state_file ? await store.load(input.state_file) : newState(input, execution);
    if (state.phase === 'completed') return { ...resultSummary(state), draft: state.draft };
    const save = () => store.save(state);
    const ask = createAsk(app, state, execution, save);
    if (state.depth === 'expert') execution.retrieval?.upgrade?.(state.input.task);
    await save();
    try {
      if (state.phase === 'new' && state.depth === 'expert' && !state.research && app.documentResearch) {
        state.pendingStage = 'researching';
        await save();
        if (state.input.allowResearch === false) {
          state.research = { status: 'not_requested', reason: 'USER_SOURCE_LIMIT', sources: [] };
        } else {
          state.research = await app.documentResearch({ id: state.id, ...state.input }, execution);
        }
        state.timings = [...state.timings, { stage: 'researching', elapsedMs: state.research.elapsedMs || 0 }].slice(-(LIMITS.calls + 1));
        await save();
      }
      if (state.phase === 'new' && state.depth === 'expert') {
        execution.progress?.('分析任务要求与业务场景…');
        state.plan = await generateTaskBrief(state.input, ask);
        state.phase = 'planned';
        await save();
      }
      if (prepareOnly) return { ...resultSummary(state), plan: state.plan };
      if (state.phase === 'new' || state.phase === 'planned') {
        state.draft = await draftDocument(state, ask, execution);
        state.original = state.draft;
        state.phase = 'drafted';
        await save();
      }
      if (state.depth === 'expert') await inspectAndRevise(state, ask, save, execution);
      state.phase = 'completed';
      await save();
      return { ...resultSummary(state), draft: state.draft };
    } catch (error) {
      // 不把停止、预算、模型故障改写成通过；上一成功阶段仍可按文件恢复。
      error.stateFile = state.stateFile;
      if (!error.code && error.name !== 'AbortError') error.code = 'DOCUMENT_WORKFLOW';
      if (error.name !== 'AbortError' && error.code !== 'RETRIEVAL_BUDGET') error.message += `；恢复文件：${state.stateFile}`;
      throw error;
    }
  }
  return { run, prepare: (input, execution) => run({ ...input, depth: 'expert' }, execution, true) };
}

function createAsk(app, state, execution, save) {
  return async (stage, request, { timeoutMs = 180000 } = {}) => {
    execution.signal?.throwIfAborted();
    if (state.calls >= LIMITS.calls) throw workflowError('文档调用次数已达上限，保留已完成内容', 'DOCUMENT_CALL_LIMIT');
    // 默认同一写作模型；只有显式提供documentReviewer才使用独立审查配置。
    const isReview = ['reviewing', 'verifying'].includes(stage);
    const llm = isReview ? (app.documentReviewer ?? app.llm) : app.llm;
    if (!llm) throw workflowError('专业文档工作流需要配置真实模型', 'DOCUMENT_MODEL_REQUIRED');
    const research = await app.documentResearchContext?.(state.research, execution);
    execution.signal?.throwIfAborted();
    execution.retrieval?.consume('model');
    state.calls++;
    state.pendingStage = stage;
    if (isReview) state.reviewMode = app.documentReviewer ? 'configured_reviewer' : 'same_model';
    await save();
    const started = Date.now();
    try {
      const text = await withWebDeadline(
        (signal) =>
          llm({
            ...request,
            prompt: request.prompt + (research ? `\n${research}` : ''),
            system: request.system + `\n任务建立时的北京时间：${state.input.referenceTime || '未记录，不猜当前日期'}`,
            signal,
            allowWebSearch: false,
            maxWebSearches: 0,
            maxTransientRetries: 0,
            maxPartialRetries: 0
          }),
        { signal: execution.signal, timeoutMs }
      );
      return boundedText(text, LIMITS.response, '模型响应', true);
    } finally {
      state.timings = [...state.timings, { stage, elapsedMs: Date.now() - started }].slice(-(LIMITS.calls + 1));
    }
  };
}

/** 长文（Word / PDF / 网页 / Markdown）按推演出的章节分节写：整篇一次写完，长方案在时限内写不完、写不深 */
function sectionOutline(state) {
  const structure = state.plan?.scenarios?.structure || [];
  if (state.depth !== 'expert' || !['docx', 'pdf', 'md', 'html'].includes(state.input.format) || structure.length < 3) return null;
  return structure.slice(0, 10).map((item) => {
    const text = String(item).trim();
    const cut = text.search(/[：:]/);
    const heading = (cut > 0 && cut <= 30 ? text.slice(0, cut) : text.slice(0, 30)).trim();
    return { heading, points: cut > 0 ? [text.slice(cut + 1).trim()].filter(Boolean) : [] };
  });
}

async function draftBySections(state, outline, ask, execution) {
  execution.progress?.(`按推演出的 ${outline.length} 个章节分头起草（同时写 3 节）…`);
  const task = `${state.input.task}\n\n任务底稿与业务推演（写作依据，不要原样抄进正文）：${JSON.stringify(state.plan)}\n\n${WRITING_RULES}每节写深写透，先给明确建议，再用流程、数据和可验证场景支撑。${roleGuide(state.input.role)}`;
  // 每节的模型调用照样计数、扣预算、可停止；单节最多 4 分钟
  const llm = ({ system, prompt }) => ask('drafting', { system, prompt }, { timeoutMs: 240000 });
  const r = await writeLongDocument({
    task,
    material: state.input.material,
    outline,
    review: false,
    llm,
    onProgress: (t) => execution.progress?.(t),
    signal: execution.signal
  });
  return boundedText(r.markdown.replace(/^# .*\n+/, ''), LIMITS.draft, '正文', true);
}

async function draftDocument(state, ask, execution) {
  const outline = sectionOutline(state);
  if (outline) return draftBySections(state, outline, ask, execution);
  execution.progress?.('根据业务推演起草正文…');
  const text = await ask(
    'drafting',
    {
      system: `你是专业文档撰稿人${ROLES[state.input.role] ? `，这篇以${ROLES[state.input.role].name}的身份写` : ''}，先给明确建议，用流程和可验证场景支撑。${WRITING_RULES}${roleGuide(state.input.role)}只输出交付正文，不附底稿或内部分析。`,
      prompt: `格式：${state.input.format}，输出适合现有Office生成器的Markdown（Excel输出分工作表的Markdown表格，公式用=开头；PPT用##分页面，观点标题、每页简洁）。\n用户原始要求：${state.input.task}\n用户材料：${state.input.material}\n${state.plan ? '任务底稿与业务推演：' + JSON.stringify(state.plan) : '这是简单任务，直接完成，不扩成冗长报告。'}\n保持精简且足够深入，不增加未经要求的封面、声明或重复免责声明。`
    },
    { timeoutMs: 240000 }
  );
  return boundedText(text.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, ''), LIMITS.draft, '正文', true);
}

async function inspectAndRevise(state, ask, save, execution) {
  if (state.phase === 'drafted') {
    execution.progress?.('对照原始要求审查业务内容…');
    state.review = await reviewDocument(state.input, state.plan, state.draft, ask);
    state.business = state.review.outcome;
    state.phase = 'reviewed';
    await save();
  }
  if (state.phase === 'reviewed' && state.business === 'needs_revision' && state.revisionAttempts < 1) {
    execution.progress?.('修订具体问题，保留原始初稿…');
    state.revisionAttempts++;
    await save();
    state.initialReview = state.review;
    const report = {};
    state.draft = await reviseDocument(state.input, state.plan, state.draft, state.review, ask, report);
    state.revisionSkipped = report.skipped || 0; // 对不上原文、没改的修改意见条数
    state.phase = 'revised';
    await save();
  }
  if (state.phase === 'revised') {
    execution.progress?.('复核修订后的需求覆盖…');
    state.review = await reviewDocument(state.input, state.plan, state.draft, ask, 'verifying');
    state.business = state.review.outcome;
    await save();
  }
}
