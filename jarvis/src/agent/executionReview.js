import { newsCandidates } from './newsDelivery.js';
import { mediaReceipt, mediaDelivery, blockedAfterDenial } from './actionDelivery.js';
import { createVisualEvidence, readVisualReceipt } from './visualEvidence.js';
import { taskContract } from './taskContract.js';
import { isReadOnlyTool } from '../../shared/taskCheckpoint.js';
import { creativeWithoutLookup } from '../core/imageFollowup.js';
import { answerConstraints, answerConstraintIssues, concreteSourceRequirement, sourceCandidates, sourceAnswerIssue } from './answerRequirements.js';

/** 核实文件内容的工具：同一文件验过可用后只再放行一次 */
export const VERIFY_TOOLS = /^(?:read_file|computer_read_file|check_document)$/;
/** 每轮仅存最多64条回执摘要，不保存正文、代码或网页。不同任务不共享。 */
const DOC_TOOLS = /^(?:create_document|write_long_document|write_professional_document|edit_office_document|edit_spreadsheet)$/;

export function createExecutionReview(goal = '', { visual = false } = {}) {
  let request = String(goal).slice(0, 4000);
  const receipts = [];
  const visualEvidence = createVisualEvidence(visual || /截图|识图|OCR|看图|图片识字/.test(goal));
  let visualIssue = '';
  let declinedTool = '';
  const toolBlock = (toolName) => blockedAfterDenial(request, declinedTool, toolName);
  const files = new Map();
  const artifacts = new Map();
  const reads = new Map(); // 文件路径 → 验过可用之后又读了几次（最多 32 个文件）
  let version = 0;
  let sequence = 0;
  let answerIssues = [];
  let sourceIssue = '';
  let calculationIssue = '';
  const candidateSources = new Set();
  const newsLinks = new Map(); // 仅本轮最多8条候选标题/网址，不保存摘要。
  const revise = (text) => {
    const previous = taskContract(request);
    const replaceLookup = previous.researching && !previous.formats.length && !previous.coding && !previous.remembering && !previous.askingMemory
      && !files.size && !artifacts.size && !/文档|报告|方案|表格|代码|程序/.test(request)
      && /^(?:改成|改为|换成|换为)/.test(String(text).trim()) && creativeWithoutLookup(text);
    request = (request + '\n补充：' + String(text)).slice(-4000);
    version++;
    declinedTool = '';
    answerIssues = [];
    sourceIssue = '';
    calculationIssue = '';
    candidateSources.clear();
    newsLinks.clear();
    // 仅简单查询明确转创作时替换目标；文档“改成两页”等仍须保留原交付要求。
    if (/^(?:取消|不用|别做|停止)/.test(String(text).trim()) || replaceLookup) {
      request = '用户最新修正：' + String(text).slice(0, 3900);
      files.clear();
      artifacts.clear();
    }
  };
  const record = ({ name: toolName, args = {}, ok, validation, output = '', code = '' }) => {
    if (ok && toolName === 'web_search' && answerConstraints(request).todayNews) {
      for (const item of newsCandidates(output)) {
        if (newsLinks.size < 8) newsLinks.set(item.url, item);
      }
    }
    if (ok) for (const url of sourceCandidates(request, toolName, output, args)) {
      if (candidateSources.size < 8) candidateSources.add(url);
    }
    if (toolName === 'read_image_text') visualEvidence.note(ok ? readVisualReceipt(output) || { kind: 'ocr', ok: true } : { kind: 'ocr', ok: false });
    if (!ok && code === 'NOT_APPROVED') declinedTool = toolName;
    const media = mediaReceipt(toolName, ok, output);
    const path = typeof args.path === 'string' ? args.path.slice(0, 400) : '';
    sequence++;
    receipts.push({
      tool: toolName,
      ok: Boolean(ok),
      ...(media && { media }),
      ...(['NOT_APPROVED', 'TASK_SCOPE_AFTER_DENIAL'].includes(code) && { code }),
      path,
      version,
      sequence,
      key: toolName + ':' + path + ':' + String(args.query ?? args.url ?? '').slice(0, 200)
    });
    if (receipts.length > 64) receipts.shift();
    // 文件被改了：之前的“已验过”作废；生成工具自己在这次调用里发来的验收结果（at 是这次调用的序号）保留
    if (ok && path && !isReadOnlyTool(toolName) && !VERIFY_TOOLS.test(toolName)) {
      const item = artifacts.get(path);
      if (item && item.at !== sequence) item.stale = true;
      reads.delete(path);
    }
    if (ok && path && VERIFY_TOOLS.test(toolName) && verified(path)) {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      if (reads.size > 32) reads.delete(reads.keys().next().value);
    }
    if (ok && /^(?:write_file|edit_file|computer_write_file|computer_edit_file)$/.test(toolName) && path) {
      // 每次写入都会使旧测试失效；预览和“已运行某段代码”不能证明这个文件通过测试。
      files.set(path, { path, written: sequence, verified: false });
      if (files.size > 32) files.delete(files.keys().next().value);
    }
    if (ok && /^(?:read_file|computer_read_file)$/.test(toolName) && files.has(path)) files.get(path).verified = true;
    if (ok && /^(?:read_file|computer_read_file)$/.test(toolName) && files.has(path) && /\.(?:pptx|docx|xlsx)$/i.test(path)) {
      artifact({ path, validation: { format: path.split('.').pop().toLowerCase(), readback: 'passed', structure: 'not_checked', render: 'not_checked' } }, sequence);
    }
    if (validation) return validation;
  };
  // 验收结果通常在工具运行中发来，那次调用记回执时序号才加一，所以默认记成 sequence + 1
  const artifact = (event, at = sequence + 1) => {
    if (!event || typeof event.path !== 'string') return;
    const data = event.validation ?? {};
    artifacts.set(event.path.slice(0, 400), {
      path: event.path.slice(0, 400),
      format: String(data.format || '').slice(0, 8),
      ...(data.wordCount && { wordCount: { count: data.wordCount.count, min: data.wordCount.min, max: data.wordCount.max, passed: data.wordCount.passed === true } }),
      readback: data.readback,
      structure: data.structure,
      render: data.render,
      errors: Math.max(0, Number(data.errors) || 0),
      slides: Number.isSafeInteger(data.slides) ? data.slides : null,
      expectedSlides: Number.isSafeInteger(data.expectedSlides) ? data.expectedSlides : null,
      pages: Number.isSafeInteger(data.pages) ? data.pages : null,
      pdfPageMatch: data.pdfPageMatch === 'passed' ? 'passed' : data.pdfPageMatch === 'failed' ? 'failed' : null,
      at
    });
    if (artifacts.size > 16) artifacts.delete(artifacts.keys().next().value);
  };
  /** 文件已经验过：能读回、生成器没报错，之后也没被改过 */
  function verified(path) {
    const item = artifacts.get(String(path ?? '').slice(0, 400));
    return Boolean(item && !item.stale && item.readback === 'passed' && !item.errors);
  }
  /** 同一文件验过可用后，再核实最多放行一次；之后直接告诉模型不用再读 */
  const rereadBlocked = (name, args = {}) => VERIFY_TOOLS.test(name) && verified(args.path) && (reads.get(String(args.path).slice(0, 400)) ?? 0) >= 1;
  const required = () => {
    const contract = taskContract(request);
    return Boolean(contract.media) || Boolean(concreteSourceRequirement(request)) || answerIssues.length > 0 || contract.formats.length > 0 || contract.coding || contract.remembering || contract.askingMemory || files.size > 0 || artifacts.size > 0 || receipts.some(receipt => receipt.tool === 'verify_numbers' && !receipt.ok || receipt.ok && /^(?:create_document|write_long_document|write_professional_document|edit_office_document|edit_spreadsheet|write_file|edit_file|run_javascript|run_python|computer_run|run_project_tests)$/.test(receipt.tool));
  };
  const contractNote = () => {
    if (!required()) return '';
    const contract = taskContract(request);
    return contract.criteria.length
      ? '本轮交付验收：' + contract.criteria.join('；') + '。用review_task核对真实回执；缺少验证时如实报告，不能靠计划标完成。'
      : '';
  };
  const report = () => {
    const codeFiles = [...files.values()].filter((file) => /\.(?:[cm]?js|jsx|tsx?|py|html|css|json)$/i.test(file.path));
    const lastWrite = Math.max(0, ...codeFiles.map((file) => file.written));
    const current = receipts.filter((receipt) => receipt.version === version);
    const lastNumeric = current.filter(receipt => receipt.tool === 'verify_numbers').at(-1);
    const latest = new Map(current.map((receipt) => [receipt.key, receipt]));
    // 算“失败回执”的只有改东西、跑测试的操作：查资料没查到（门票没搜到）是信息缺口，在交付里标明即可；
    // 后来同一个工具又成功了（换了文件名重新生成）也算已解决
    // 同一份文档：改失败后又用别的文档工具成功生成 / 改好了，也算已解决
    const sameDoc = (a, b) => a.path && a.path === b.path && DOC_TOOLS.test(a.tool) && DOC_TOOLS.test(b.tool);
    const unresolved = (receipt) =>
      !receipt.ok && receipt.code !== 'TASK_SCOPE_AFTER_DENIAL' &&
      (!isReadOnlyTool(receipt.tool) || receipt.tool === 'run_project_tests') &&
      !current.some((later) => later.sequence > receipt.sequence && later.ok && (later.tool === receipt.tool || sameDoc(later, receipt)));
    const ran = receipts.some(
      (receipt) => receipt.sequence > lastWrite && receipt.ok && /^(?:run_javascript|run_python|computer_run|run_project_tests)$/.test(receipt.tool)
    );
    const pending = codeFiles.filter((file) => !file.verified).map((file) => file.path);
    return {
      media: mediaDelivery(request, receipts.filter((receipt) => receipt.version === version)),
      pendingFormats: taskContract(request).formats.filter(
        (format) => ![...artifacts.values()].some((item) => item.format === format && item.readback === 'passed' && !item.errors)
      ),
      request,
      retrievalReceipts: receipts.filter((receipt) => receipt.version === version && receipt.ok && /^(?:web_search|fetch_url|fact_check|deep_research|get_weather|get_stock_kline|get_sports_scores|read_evidence)$/.test(receipt.tool)).length,
      version,
      calls: sequence,
      answerIssues: [...answerIssues],
      sourceIssue,
      visualIssue,
      visualReceipts: visualEvidence.snapshot(),
      calculationIssue,
      sourceRequirement: concreteSourceRequirement(request),
      candidateSources: [...candidateSources],
      // 说“记住了 / 记进去了”必须有真实的记忆工具回执
      memory: !taskContract(request).remembering
        ? 'not_required'
        : current.some((receipt) => receipt.ok && /^(?:remember|core_memory_update|save_skill)$/.test(receipt.tool))
          ? 'saved'
          : 'not_saved',
      memoryChecked: !taskContract(request).askingMemory || current.some((receipt) => receipt.ok && receipt.tool === 'recall'),
      calculation: lastNumeric && !lastNumeric.ok ? 'failed' : receipts.some((receipt) => receipt.version === version && receipt.ok && /^(?:verify_numbers|run_javascript|run_python)$/.test(receipt.tool))
        ? 'tool_checked'
        : 'not_checked',
      contract: taskContract(request),
      artifacts: [...artifacts.values()],
      failures: [...latest.values()].filter(unresolved).map((receipt) => receipt.tool),
      pendingReadback: pending,
      codeExecution: !codeFiles.length ? 'not_required' : ran ? 'executed_scope_needs_review' : 'not_run',
      note: '回执不是完整需求验收；运行任意代码、打开预览不等于所有交付文件测试通过。'
    };
  };
  const guidance = () => {
    const result = report();
    const issues = [];
    issues.push(...result.answerIssues);
    if (result.visualIssue) issues.push(result.visualIssue);
    if (result.media && result.media.state !== 'completed') issues.push(`用户要求生成${result.media.label}，当前${result.media.state}；应实际调用${result.media.tool}取得文件，不能只写“我来做”收尾。已有歌词/文字保留，失败明确区分，不能虚构下载或播放。`);
    if (result.sourceIssue) issues.push(result.sourceIssue);
    if (result.calculation === 'failed') issues.push('关键verify_numbers校验失败；先根据工具错误修正参数重算，无法核验则明确校验失败、请人工复核，不能声称已通过');
    if (result.pendingFormats.length)
      issues.push('这些要求的文件还没有有效产物读回回执：' + result.pendingFormats.join('、') + '；先实际生成并核对，不能只说已完成');
    if (result.contract.calculation && result.calculation === 'not_checked')
      issues.push('涉及确定性数值计算，但还没有verify_numbers或代码计算回执；先计算核对，不能自行心算冒充已验证');
    if (result.memory === 'not_saved')
      issues.push('用户要你记住，但本轮没有调用 remember 保存（做事方式的教训用 category: lesson）；现在调用，保存成功前不能说“记住了”');
    if (!result.memoryChecked) issues.push('用户问有没有记住：先用 recall 查，查到了再回答，查不到就如实说没记，并问要不要现在记');
    if (result.pendingReadback.length) issues.push('这些修改尚未读回核对：' + result.pendingReadback.join('、'));
    if (result.codeExecution === 'not_run') issues.push('已修改代码但没有实际运行记录；先运行适用测试，无法执行就明确未验证');
    if (result.artifacts.some((item) => item.errors > 0)) issues.push('文档仍有生成器报告的问题，不能宣称排版或公式全部通过');
    if (result.failures.length)
      issues.push('本轮这些操作失败后没有成功补做：' + [...new Set(result.failures)].join('、') + '；补做只指重试失败的这一步（不能改做用户这次没要求的别的事），没补救的在回答里一句话说明，不要为此重新读取已交付的文件');
    return issues.length ? '交付回执核对：' + issues.join('；') + '。不要重复操作或编造测试通过。' : '';
  };
  const tool = {
    name: 'review_task',
    description: '读取本轮原始目标、补充版本与真实执行回执摘要；结束前核对，不能用计划勾选替代实际文件/测试回执。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => JSON.stringify(report())
  };
  const checkAnswer = (text, now) => {
    answerIssues = answerConstraintIssues(request, text, now);
    visualIssue = visualEvidence.issue(text);
    sourceIssue = sourceAnswerIssue(request, text, [...candidateSources]);
    const result = report();
    calculationIssue = result.calculation === 'failed' ? '关键verify_numbers校验失败，修正输入重算；不能核验时必须明确校验失败、请人工复核' : result.contract.calculation && result.calculation === 'not_checked' ? '关键计算尚无工具校验，请先调用verify_numbers核对，不能用心算冒充工具结果' : '';
    return [...answerIssues, ...(visualIssue ? [visualIssue] : []), ...(sourceIssue ? [sourceIssue] : []), ...(calculationIssue ? [calculationIssue] : [])];
  };
  const guardsAnswer = () => {
    const rules = answerConstraints(request);
    return visualEvidence.active() || rules.noTime || rules.literals.length > 0 || rules.todayNews || Boolean(concreteSourceRequirement(request)) || taskContract(request).calculation || report().calculation === 'failed';
  };
  return { newsCandidates: () => [...newsLinks.values()], toolBlock, noteVisual: visualEvidence.note, record, revise, report, guidance, tool, artifact, contractNote, required, verified, rereadBlocked, checkAnswer, guardsAnswer };
}
