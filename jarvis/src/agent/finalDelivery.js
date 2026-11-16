/** 收尾只恢复本轮已读回的真实产物，不复述失效草稿，不调用模型。 */
export function missingDeliveries(answer, report) {
  const poster = ['poster', 'visual_demo'].includes(report.media?.kind) && report.media.delivery;
  if (poster?.primaryPath) {
    const html = report.media.kind === 'visual_demo' && report.media.outputs?.find(f => f.format === 'html' && f.readback === 'passed')?.path;
    if (String(answer).includes(poster.primaryPath) && (!html || String(answer).includes(html))) return '';
    const target = encodeURI(poster.primaryPath).replace(/[()]/g, value => '%' + value.charCodeAt(0).toString(16));
    const demoLink = html && !String(answer).includes(html) ? `\n\n[打开同稿Demo](${encodeURI(html).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16))})` : '';
    return (String(answer).includes(poster.primaryPath) ? '' : `\n\n[${poster.quality === 'complete' ? '查看海报' : '查看候选海报（待核验）'}](${target})`) + demoLink + '\n\n源文件和历史稿可在文件空间展开。';
  }
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
