import * as workspace from './workspace.js';
import { requestedArchitectureViews } from './architectureWorkflowInput.js';
import { throwControl } from '../core/networkRequest.js';
import { mediaReceipt } from './actionDelivery.js';

const sourceFile = path => /\.(?:docx?|pdf|txt|md)$/i.test(path) && !path.startsWith('文档检查/');
const jobPattern = /文档检查\/架构任务\/[\w-]+\.json/g;
const jobPathValid = path => typeof path === 'string' && /^文档检查\/架构任务\/[\w-]+\.json$/.test(path);
function mentionsPath(text, path) {
  for (let start = 0, index; (index = text.indexOf(path, start)) >= 0; start = index + path.length) {
    if (!/[\w./\\-]/.test(text[index - 1] || '') && !/[\w./\\-]/.test(text[index + path.length] || '')) return true;
  }
  return false;
}
/** 只接明确的材料型新建架构任务，讨论/排错、旧图修改、混合写作和纯文本画图保留原入口。 */
export function isArchitectureProduction(text) {
  if (typeof text !== 'string' || text.length > 4000 || !/架构图|总体架构|系统架构/.test(text)) return false;
  if (!/制作|生成|绘制|重画|重做|画一|画个|做一|做个|出图|输出/.test(text)) return false;
  if (/^(?:请|帮我|先|再|麻烦|你)?\s*(?:分析|解释|讨论|看看|检查|说说|为什么|为何|建议|计划)/.test(text.trim())) return false;
  if (/(?:是什么意思|如何理解|如何解释|是否合理)[？?]?$/.test(text.trim())) return false;
  if (/(?:不要|无需|不用|暂不|先别).{0,6}(?:制作|生成|绘制|画).{0,6}(?:架构图|总体架构)/.test(text)) return false;
  if (/(?:修改|编辑|调整|保持|保留).{0,12}(?:原图|旧图|现有|已有|这张)|(?:原图|旧图|现有|已有|这张).{0,12}(?:修改|编辑|调整|保持|保留)/.test(text)) return false;
  if (/(?:写|撰写|制作|生成).{0,12}(?:文章|文案|Word|WORD|Excel|EXCEL|\d+页PPT|多页PPT)/.test(text)) return false;
  if (/(?:制作|生成|写|做)(?:一份|一个|一套|个|份)?[^，。；\n]{0,12}(?:方案PPT|PPT)(?:[，,；;]|[，,]?(?:并|和)|里面)/i.test(text)) return false;
  return true;
}
function destination(text) {
  const match = /(?:产物存到|存到|保存到|输出到|交付目录[为是：:]?)\s*["“「`]?([^\s"”」`，。；;]+)/.exec(text);
  if (!match) return '架构图/' + crypto.randomUUID();
  const path = match[1].replace(/\/+$/, '');
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw Object.assign(new Error('架构交付目录必须是合法的工作区相对目录'), { code: 'ARCHITECTURE_DIRECTORY', kind: 'input' });
  return path;
}
export async function selectArchitectureTask(text) {
  if (!isArchitectureProduction(text)) return null;
  const catalog = (await workspace.list()).filter(file => sourceFile(file.path));
  const exact = catalog.filter(file => mentionsPath(text, file.path));
  const byName = catalog.filter(file => mentionsPath(text, file.path.split('/').at(-1)));
  const count = /([2-4二三四两])(?:份|个)(?:原始|招标|采购)?(?:文件|材料|附件)/.exec(text)?.[1];
  const expectedCount = count ? ({ 二: 2, 两: 2, 三: 3, 四: 4 }[count] || Number(count)) : null;
  let files = exact.length ? exact : byName;
  const ambiguous = files.some(file => !exact.length && catalog.filter(other => other.path.split('/').at(-1) === file.path.split('/').at(-1)).length > 1);
  if (!files.length && /原始|原文|招标|采购|上传|附件|材料|文件/.test(text)) {
    const tenders = catalog.filter(file => /招标|采购|原文/.test(file.path.split('/').at(-1)));
    if (!expectedCount && !/这几份|多个文件|全部文件|所有文件/.test(text)) {
      if (tenders.length === 1) files = tenders;
      else if (catalog.length === 1) files = catalog;
    }
  }
  if (!files.length || ambiguous || files.length > 4 || expectedCount && files.length !== expectedCount) return null;
  return { files: files.map(file => file.path), request: text, directory: destination(text), views: requestedArchitectureViews(text) };
}
const parse = output => { try { return JSON.parse(output); } catch { return null; } };
function deliveryText(receipt) {
  const labels = { overview: '总体架构', workflow: '业务闭环', dataflow: '数据流' };
  const lines = ['已生成' + receipt.completedViews.map(view => labels[view.view]).join('、') + '，各视图提供SVG、PNG、PDF和原生可编辑PPT。', ''];
  for (const view of receipt.completedViews) {
    const editable = view.files.find(file => file.format === 'pptx' && file.path.endsWith('-可编辑.pptx'));
    lines.push('- ' + labels[view.view] + '：[预览](' + view.previewPath + ')' + (editable ? ' · [可编辑PPT](' + editable.path + ')' : ''));
  }
  lines.push('', '已检查同稿导出与原生PPT对照。');
  return lines.join('\n');
}
function failureText(result, jobPath) {
  const detail = String(result?.output || '专用流程没有取得完整交付回执').replace(/^错误：/, '').split('\n定点修复：')[0].slice(0, 1800);
  return '本次未完成架构图交付。' + detail + (jobPath ? '\n\n任务与已有文件已保留：[任务记录](' + jobPath + ')。' : '');
}
/** 程序驱动有界阶段续接；不再让主模型手动找章节、重发工具说明或直接编辑状态。 */
export async function runArchitectureDirector({ text, tools, run, emit, signal, shouldYield, onStart }) {
  if (!tools.some(tool => tool.name === 'build_architecture')) return null;
  const task = await selectArchitectureTask(text);
  if (!task) return null;
  throwControl(null, signal);
  onStart?.();
  emit({ type: 'diagnostic', phase: 'architecture_director_start', sourceCount: task.files.length, mainModelCalls: 0 });
  let args = task, jobPath = null, last, calls = 0, failures = 0;
  for (; calls < 6;) {
    throwControl(null, signal);
    if (shouldYield?.()) return { yielded: true, calls, failures, jobPath, last };
    const call = { id: 'architecture_' + crypto.randomUUID(), name: 'build_architecture', args };
    [last] = await run([call]); calls++;
    if (!last.ok) failures++;
    const receipt = last.ok ? parse(last.output) : null;
    const pointer = receipt?.jobPath || String(last.output || '').match(jobPattern)?.[0];
    if (jobPathValid(pointer) && (!jobPath || pointer === jobPath) && await workspace.exists(pointer)) jobPath = pointer;
    if (shouldYield?.()) return { yielded: true, calls, failures, jobPath, last };
    if (jobPath && receipt?.jobPath === jobPath && receipt?.status === 'complete' && mediaReceipt('build_architecture', true, last.output).state === 'completed' && receipt.completedViews?.length === task.views.length &&
      task.views.every(view => receipt.completedViews.some(row => row.view === view && row.editable === true))) {
      emit({ type: 'diagnostic', phase: 'architecture_director_end', status: 'complete', calls, mainModelCalls: 0 });
      return { calls, failures, lastOk: true, text: deliveryText(receipt), receipt, jobPath };
    }
    if (last.recoveryStop || !jobPath) break;
    args = { jobPath };
  }
  emit({ type: 'diagnostic', phase: 'architecture_director_end', status: 'failed', calls, mainModelCalls: 0 });
  return { calls, failures, lastOk: false, text: failureText(last, jobPath), jobPath };
}
