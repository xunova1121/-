/** 收尾只恢复本轮已读回的真实产物，不复述失效草稿，不调用模型。 */
export function missingDeliveries(answer, report) {
  const formats = report.contract?.formats || [];
  const items = (report.artifacts || []).filter(item =>
    formats.includes(item.format) && !item.stale && item.readback === 'passed' && typeof item.path === 'string'
  ).slice(0, 16);
  const missing = items.filter(item => !String(answer).includes(item.path));
  if (!missing.length) return '';
  return '\n\n已保存的文件：\n' + missing.map(item => {
    const label = item.path.split('/').at(-1).replace(/[\[\]\r\n]/g, '');
    const target = encodeURI(item.path).replace(/[()]/g, value => '%' + value.charCodeAt(0).toString(16));
    return `- [${label}](${target})${item.errors ? '（仍有检查问题，作为待完善稿保留）' : '（已读回；内容及视觉验收状态见检查结果）'}`;
  }).join('\n');
}
