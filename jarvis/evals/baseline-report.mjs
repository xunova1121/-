/** 机械检查只能发现明显失败；语义、实时事实及实际Office产物必须复核。 */
export function checkResult(item, result) {
  const answer = String(result.answer || '');
  const failures = [];
  if (result.status !== 'done' || result.protocolIssue) failures.push('执行未完整成功');
  if (!answer.trim()) failures.push('无回答正文');
  for (const text of item.checks.contains || []) {
    if (!answer.includes(text)) failures.push(`缺少检查文本：${text}`);
  }
  for (const text of item.checks.excludes || []) {
    if (answer.includes(text)) failures.push(`残留错误文本：${text}`);
  }
  if (item.checks.maxChars && answer.length > item.checks.maxChars) failures.push('超过简短回答长度');
  if (item.checks.links && !/https?:\/\/[^\s)）]+/.test(answer)) failures.push('缺少来源网址');
  // 文件名只证明服务器报告有产物；不可冒充可打开、公式或视觉验收通过。
  if (item.checks.artifact && !(result.files || []).some((file) => String(file).toLowerCase().endsWith(item.checks.artifact))) {
    failures.push(`未报告${item.checks.artifact}产物`);
  }
  return { mechanical: failures.length ? 'failed' : 'passed', failures, semantic: 'pending', quality: failures.length ? 'failed' : 'not_reviewed' };
}

export function metricsFor(item, turns) {
  const numbers = (field) => turns.map((turn) => turn.timing?.[field]);
  const sum = (field) => numbers(field).every(Number.isFinite) ? numbers(field).reduce((a, b) => a + b, 0) : null;
  return {
    firstTextMs: turns[0]?.timing?.firstTextMs ?? null,
    turnFirstTextMs: turns.map((turn) => turn.timing?.firstTextMs ?? null),
    totalMs: turns.reduce((total, turn) => total + (turn.clientTotalMs || 0), 0),
    mainModelCalls: sum('modelCalls'),
    mainInputChars: sum('inputChars'),
    inputTextChars: sum('inputTextChars'),
    systemChars: sum('systemChars'),
    toolSchemaChars: sum('toolSchemaChars'),
    userInputChars: turns.every((turn) => typeof turn.prompt === 'string') ? turns.reduce((total, turn) => total + turn.prompt.length, 0) : null,
    allModelCalls: turns.every((turn) => turn.timing?.measurementVersion >= 2 && Number.isFinite(turn.timing?.helperModelCalls)) ? sum('modelCalls') + sum('helperModelCalls') : null,
    helperModelCalls: sum('helperModelCalls'),
    helperInputChars: sum('helperInputChars'),
    note: 'mainInputChars是主循环消息正文字符累计，不含系统提示、工具schema、图片和辅助模型；allModelCalls统计主循环及工具内辅助逻辑调用，不含后台记忆、协议内部HTTP重试；旧服务器为null。首字包含过程说明；多轮耗时为各轮之和。',
  };
}

export function baselineSummary(results) {
  const mean = (key) => {
    const values = results.map((item) => item.metrics[key]).filter(Number.isFinite);
    return { value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, known: values.length };
  };
  const passed = results.filter((item) => item.quality === 'passed' && item.status === 'done');
  return {
    count: results.length,
    passed: passed.length,
    failed: results.filter((item) => item.quality === 'failed').length,
    pending: results.filter((item) => item.quality === 'not_reviewed').length,
    verifiedPassRate: results.length ? passed.length / results.length : null,
    firstTextMs: mean('firstTextMs'),
    totalMs: mean('totalMs'),
    mainModelCalls: mean('mainModelCalls'),
    mainInputChars: mean('mainInputChars'),
    inputTextChars: mean('inputTextChars'),
    allModelCalls: mean('allModelCalls'),
  };
}

export function compareBaseline(before, after) {
  const ids = (report) => report.results.map((item) => item.id).sort().join(',');
  const comparable = !before.mixedModel && !after.mixedModel && before.suiteVersion === after.suiteVersion && before.model === after.model && before.provider === after.provider && ids(before) === ids(after) && before.location === after.location;
  const oldItems = new Map(before.results.map((item) => [item.id, item]));
  const regressions = after.results.filter((item) => oldItems.get(item.id)?.quality === 'passed' && (item.quality !== 'passed' || item.status !== 'done')).map((item) => item.id);
  const reviewed = [before, after].every((report) => report.results.length === 30 && report.results.every((item) => ['passed', 'failed'].includes(item.quality)));
  return { comparable, regressions, decision: !comparable || !reviewed ? 'blocked_pending_comparable_review' : regressions.length || baselineSummary(after.results).verifiedPassRate < baselineSummary(before.results).verifiedPassRate ? 'reject_regression' : 'no_quality_regression', before: baselineSummary(before.results), after: baselineSummary(after.results) };
}
