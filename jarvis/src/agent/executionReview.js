import { taskContract } from './taskContract.js';
/** 每轮仅存最多64条回执摘要，不保存正文、代码或网页。不同任务不共享。 */
export function createExecutionReview(goal = '') {
  let request = String(goal).slice(0, 4000);
  const receipts = [];
  const files = new Map();
  const artifacts = new Map();
  let version = 0;
  let sequence = 0;
  const revise = (text) => {
    request = (request + '\n补充：' + String(text)).slice(-4000);
    version++;
    if (/^(?:取消|不用|别做|停止)/.test(String(text).trim())) {
      request = '用户最新修正：' + String(text).slice(0, 3900);
      files.clear();
      artifacts.clear();
    }
  };
  const record = ({ name: toolName, args = {}, ok, validation }) => {
    const path = typeof args.path === 'string' ? args.path.slice(0, 400) : '';
    sequence++;
    receipts.push({
      tool: toolName,
      ok: Boolean(ok),
      path,
      version,
      sequence,
      key: toolName + ':' + path + ':' + String(args.query ?? args.url ?? '').slice(0, 200)
    });
    if (receipts.length > 64) receipts.shift();
    if (ok && /^(?:write_file|edit_file|computer_write_file|computer_edit_file)$/.test(toolName) && path) {
      // 每次写入都会使旧测试失效；预览和“已运行某段代码”不能证明这个文件通过测试。
      files.set(path, { path, written: sequence, verified: false });
      if (files.size > 32) files.delete(files.keys().next().value);
    }
    if (ok && /^(?:read_file|computer_read_file)$/.test(toolName) && files.has(path)) files.get(path).verified = true;
    if (ok && /^(?:read_file|computer_read_file)$/.test(toolName) && files.has(path) && /\.(?:pptx|docx|xlsx)$/i.test(path)) {
      artifact({ path, validation: { format: path.split('.').pop().toLowerCase(), readback: 'passed', structure: 'not_checked', render: 'not_checked' } });
    }
    if (validation) return validation;
  };
  const artifact = (event) => {
    if (!event || typeof event.path !== 'string') return;
    const data = event.validation ?? {};
    artifacts.set(event.path.slice(0, 400), {
      path: event.path.slice(0, 400),
      format: String(data.format || '').slice(0, 8),
      readback: data.readback,
      structure: data.structure,
      render: data.render,
      errors: Math.max(0, Number(data.errors) || 0)
    });
    if (artifacts.size > 16) artifacts.delete(artifacts.keys().next().value);
  };
  const contractNote = () => {
    const contract = taskContract(request);
    return contract.criteria.length
      ? '本轮交付验收：' + contract.criteria.join('；') + '。用review_task核对真实回执；缺少验证时如实报告，不能靠计划标完成。'
      : '';
  };
  const report = () => {
    const codeFiles = [...files.values()].filter((file) => /\.(?:[cm]?js|jsx|tsx?|py|html|css|json)$/i.test(file.path));
    const lastWrite = Math.max(0, ...codeFiles.map((file) => file.written));
    const latest = new Map(receipts.filter((receipt) => receipt.version === version).map((receipt) => [receipt.key, receipt]));
    const ran = receipts.some(
      (receipt) => receipt.sequence > lastWrite && receipt.ok && /^(?:run_javascript|run_python|computer_run|run_project_tests)$/.test(receipt.tool)
    );
    const pending = codeFiles.filter((file) => !file.verified).map((file) => file.path);
    return {
      pendingFormats: taskContract(request).formats.filter(
        (format) => ![...artifacts.values()].some((item) => item.format === format && item.readback === 'passed' && !item.errors)
      ),
      request,
      retrievalReceipts: receipts.filter((receipt) => receipt.version === version && receipt.ok && /^(?:web_search|fetch_url|fact_check|deep_research|get_weather|get_stock_kline|read_evidence)$/.test(receipt.tool)).length,
      version,
      calls: sequence,
      calculation: receipts.some((receipt) => receipt.version === version && receipt.ok && /^(?:verify_numbers|run_javascript|run_python)$/.test(receipt.tool))
        ? 'tool_checked'
        : 'not_checked',
      contract: taskContract(request),
      artifacts: [...artifacts.values()],
      failures: [...latest.values()].filter((receipt) => !receipt.ok).map((receipt) => receipt.tool),
      pendingReadback: pending,
      codeExecution: !codeFiles.length ? 'not_required' : ran ? 'executed_scope_needs_review' : 'not_run',
      note: '回执不是完整需求验收；运行任意代码、打开预览不等于所有交付文件测试通过。'
    };
  };
  const guidance = () => {
    const result = report();
    const issues = [];
    if (result.pendingFormats.length)
      issues.push('这些要求的文件还没有有效产物读回回执：' + result.pendingFormats.join('、') + '；先实际生成并核对，不能只说已完成');
    if (result.contract.calculation && result.calculation === 'not_checked')
      issues.push('涉及确定性数值计算，但还没有verify_numbers或代码计算回执；先计算核对，不能自行心算冒充已验证');
    if (result.pendingReadback.length) issues.push('这些修改尚未读回核对：' + result.pendingReadback.join('、'));
    if (result.codeExecution === 'not_run') issues.push('已修改代码但没有实际运行记录；先运行适用测试，无法执行就明确未验证');
    if (result.artifacts.some((item) => item.errors > 0)) issues.push('文档仍有生成器报告的问题，不能宣称排版或公式全部通过');
    if (result.failures.length) issues.push('本轮有失败回执，逐项核实是否解决，不把失败直接算完成');
    return issues.length ? '交付回执核对：' + issues.join('；') + '。不要重复操作或编造测试通过。' : '';
  };
  const tool = {
    name: 'review_task',
    description: '读取本轮原始目标、补充版本与真实执行回执摘要；结束前核对，不能用计划勾选替代实际文件/测试回执。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => JSON.stringify(report())
  };
  return { record, revise, report, guidance, tool, artifact, contractNote };
}
