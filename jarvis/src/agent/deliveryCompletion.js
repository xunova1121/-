/** 只把真实回执已经证明的读回/交付步骤勾完；内容编写、视觉审查和其它业务步骤仍由模型执行。 */
export function completedDeliverySteps({ report, guidance, receipts = [], steps, answer }) {
  const r = report, contract = r.contract;
  // 多件交付、逐条原文核验不属于快速收尾；不能凭一个成功文件推定整件事完成。
  if (/PDF|PPT|Excel|SVG|HTML|代码|多份|两份|两张|多个文件|分别|另外|还要|同时|以及|逐[项条一]|核[实验对]|查原文|比对原文/i.test(r.request)) return null;
  if (guidance || r.version || contract.coding || contract.remembering || contract.askingMemory || contract.calculation || r.sourceRequirement || r.visualIssue || r.calculationIssue || r.sourceIssue || r.answerIssues.length || r.styleIssues.length || r.failures.length || r.pendingReadback.length || r.pendingFormats.length) return null;
  const documents = r.artifacts.filter(a => !a.stale && !a.errors && a.readback === 'passed' && a.structure === 'passed' && a.render === 'passed' && a.format === 'docx' && a.pages === 1);
  let path;
  if (contract.formats.length === 1 && contract.formats[0] === 'docx' && r.artifacts.length === 1 && documents.length === 1) path = documents[0].path;
  else if (!contract.formats.length && r.media?.kind === 'image' && r.media.state === 'completed' && r.media.files.length === 1) {
    const generated = receipts.filter(x => x.ok && x.media?.kind === 'image' && x.media.state === 'completed').at(-1);
    const candidate = r.media.files[0];
    if (generated && receipts.some(x => x.ok && x.sequence > generated.sequence && x.path === candidate && x.tool === 'read_file')) path = candidate;
  }
  // 已写出的回答必须确实交付此文件，不把“以后再做”或旧路径当本次交付。
  if (!path || !String(answer).includes(path)) return null;
  const pending = steps.filter(s => ['todo', 'doing'].includes(s.status));
  const administrative = /^(?:(?:核对|检查|读回|验证)(?:生成结果|生成文件|文件|产物|文档)(?:并交付(?:文件)?)?|(?:交付|提供|发送)(?:最终)?(?:文件|产物|文档|结果))$/;
  if (!pending.length || pending.some(s => !administrative.test(s.text))) return null;
  return steps.map(s => pending.includes(s) ? { ...s, status: 'done' } : s);
}
