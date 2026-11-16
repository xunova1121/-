/** 2000字发送预算内仍保持海报JSON协议，几何/逐像素详情留在可回读原件。 */
export function compactPosterModelReceipt(message, archive) {
  if (!['make_poster', 'create_visual_demo'].includes(message.name)) return null;
  let value;
  try { value = JSON.parse(String(message.content)); } catch { return null; }
  if (!['poster', 'visual_demo'].includes(value?.kind) || !['complete', 'partial'].includes(value.status)) return null;
  if (!Array.isArray(value.files) || value.errors !== undefined && !Array.isArray(value.errors)) return null;
  const short = (v, n) => typeof v === 'string' ? v.slice(0, n) : undefined;
  const state = v => ['passed', 'failed', 'not_checked'].includes(v) ? v : 'not_checked';
  const png = value.files?.find(f => f.format === 'png' && typeof f.path === 'string' && f.path.length <= 400);
  const receipt = {
    kind: value.kind, status: value.status, renderer: short(value.renderer, 30), designVersion: short(value.designVersion, 40),
    width: value.width, height: value.height, textRendering: value.textRendering,
    fontCheck: state(value.fontCheck), visual: state(value.visual),
    files: png ? [{ format: 'png', path: png.path, readback: state(png.readback), structure: state(png.structure), render: state(png.render) }] : [],
    availableFormats: [...new Set((value.files || []).map(f => f.format))].filter(f => ['png', 'svg', 'pptx', 'html', 'zip'].includes(f)),
    designPath: short(value.designPath, 400),
    errorCount: Array.isArray(value.errors) ? value.errors.length : 0,
    errors: (value.errors || []).slice(0, 3).map(e => ({ code: short(e.code, 80), phase: short(e.phase, 30), message: short(e.message, 100) })),
    guidance: '只展示主PNG，源文件/历史稿在文件空间展开；不重复导出，不把技术通过说成审美通过。详情用read_tool_result按receiptId回读。'
  };
  for (const key of ['layout', 'layoutCheck', 'copyCheck', 'presentation', 'contrast']) {
    if (value[key]) receipt[key] = { status: state(value[key].status) };
  }
  if (value.backgroundCheck) receipt.backgroundCheck = { status: state(value.backgroundCheck.status), changedOutsideText: value.backgroundCheck.changedOutsideText };
  if (value.detection) receipt.detection = { confidence: value.detection.confidence };
  if (value.contentCheck) receipt.contentCheck = { status: state(value.contentCheck.status), semantic: state(value.contentCheck.semantic) };
  if (value.delivery) receipt.delivery = { id: short(value.delivery.id, 36), primaryPath: short(value.delivery.primaryPath, 400),
    quality: short(value.delivery.quality, 30), attempts: value.delivery.attempts, corrections: value.delivery.corrections, retryAllowed: value.delivery.retryAllowed };
  if (value.kind === 'visual_demo') {
    const html = value.files.find(f => f.format === 'html' && typeof f.path === 'string' && f.path.length <= 400);
    if (html) receipt.files.push({ format: 'html', path: html.path, readback: state(html.readback), structure: state(html.structure), render: state(html.render) });
    receipt.dataMode = value.dataMode;
    receipt.interaction = state(value.interaction);
    receipt.guidance = '按真实状态展示PNG与HTML；可编辑源稿与其它格式按需读取，不把文件生成说成视觉/交互验收通过。';
  }
  if (value.retryAllowed === false) receipt.retryAllowed = false;
  const id = archive?.remember(message);
  if (id) receipt.receiptId = id;
  let json = JSON.stringify(receipt);
  if (json.length > 1900) {
    receipt.errors = receipt.errors.map(({ code, phase }) => ({ code, phase }));
    json = JSON.stringify(receipt);
  }
  if (json.length > 1900) { delete receipt.designPath; json = JSON.stringify(receipt); }
  if (json.length > 2000) {
    // 主图路径在files内已保留，删除重复路径；不截JSON，不把缺失字段伪造成成功。
    if (receipt.delivery) delete receipt.delivery.primaryPath;
    json = JSON.stringify(receipt);
  }
  return json.length <= 2000 ? json : null;
}
