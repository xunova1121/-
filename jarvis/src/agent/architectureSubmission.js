import * as ws from './workspace.js';
import { resolveArchitectureEvidence } from './architectureEvidence.js';
import { excerptDiagnostics } from './architectureDiagnostics.js';
import { evidence } from './architecturePlan.js';
import { throwControl } from '../core/networkRequest.js';
const groups = ['entities', 'relations', 'requirements'];
const limits = { entities: 60, relations: 100, requirements: 80 };
const failure = (message) => Object.assign(new Error(message), { code: 'ARCHITECTURE_PLAN', kind: 'input' });
const compact = (text) => String(text || '').replace(/\s+/g, '');
// 仅恢复本工具生成的有界输入草稿；每次仍重新读取材料、核号和审查，不能当作正式底稿。
export async function loadArchitectureSubmission(input) {
  if (!input.draftPath) return input;
  if (['title', 'sources', ...groups].some((key) => Object.hasOwn(input, key))) throw failure('恢复时仅填draftPath/corrections，不混用完整底稿字段');
  if (!/^文档检查\/架构输入\/[\w-]+\.submission\.json$/.test(input.draftPath)) throw failure('只能恢复架构输入草稿路径');
  const blob = await ws.readBlob(input.draftPath);
  if (blob.size > 1e6) throw failure('输入草稿超过1MB');
  const saved = JSON.parse(await blob.text());
  if (saved.version !== 1 || saved.state !== 'invalid' || !saved.input) throw failure('不是可恢复的输入草稿');
  const result = structuredClone(saved.input);
  if (!Array.isArray(input.corrections) || input.corrections.length > 240) throw failure('corrections需0～240项');
  for (const patch of input.corrections) {
    const row = result[patch.group]?.[patch.index];
    if (!groups.includes(patch.group) || !Number.isInteger(patch.index) || !row) throw failure('修补位置不存在');
    // 切换证据模式必须清除旧模式；不从端点继承依据，不自动删除用户假设来当事实。
    if (['evidenceId', 'basisEvidenceId', 'assumption', 'source', 'excerpt'].some((key) => Object.hasOwn(patch, key))) {
      for (const key of ['evidenceId', 'basisEvidenceId', 'assumption', 'source', 'excerpt', 'basis']) delete row[key];
    }
    if (patch.useEvidenceText) {
      if (patch.group !== 'requirements' || !patch.evidenceId || patch.text !== undefined)
        throw failure('useEvidenceText仅用于需求，须同传真实evidenceId且不传text');
      delete row.text;
    }
    for (const key of ['evidenceId', 'basisEvidenceId', 'assumption', 'source', 'excerpt', 'text']) {
      if (Object.hasOwn(patch, key)) row[key] = patch[key];
    }
  }
  return result;
}
// 一次检查全部证据字段，最多240条；不调用模型、不修改原始需求、不将概括自动替换为原文。
export async function validateArchitectureSubmission(input, materials, checks, execution = {}) {
  const diagnostics = [];
  const resolved = { ...input };
  for (const group of groups) {
    if (!Array.isArray(input[group]) || input[group].length > limits[group]) throw failure(group + '结构或数量无效');
    resolved[group] = [];
    for (const [index, row] of input[group].entries()) {
      throwControl(null, execution.signal);
      try {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw failure('该项必须是对象');
        const bound = await resolveArchitectureEvidence({ [group]: [row] }, materials, checks, execution.signal);
        const item = bound[group][0];
        if (item?.basis && !item.basisEvidenceId) throw failure('设计依据必须通过真实编号核验');
        if (!item?.evidenceId && !item?.assumption && !(item?.source && item?.excerpt)) {
          throw Object.assign(failure('缺少完整依据'), {
            diagnostics: [
              {
                field: '',
                stage: 'excerpt',
                action: '事实填evidenceId；设计推导填assumption，可配basisEvidenceId；旧方式须同时有source和excerpt。关系也逐条填写，不能只填端点。'
              }
            ]
          });
        }
        const proof = evidence(item, materials, execution.rawRequestText, execution.previousUserEvidence);
        if (
          group === 'requirements' &&
          (proof.evidence !== 'excerpt_matched' || (item.text !== undefined && !compact(proof.excerpt).includes(compact(item.text))))
        ) {
          throw Object.assign(failure('需求text不是所引原文连续内容'), {
            diagnostics: [
              {
                ...excerptDiagnostics(item.text, proof.excerpt, materials),
                field: 'text',
                stage: 'fact',
                action: '采购需求只填evidenceId并省略text可沿用该片段原文；概括放对象职责，不自动把概括改成采购事实。'
              }
            ]
          });
        }
        resolved[group].push(item);
      } catch (error) {
        throwControl(error, execution.signal);
        if (!['ARCHITECTURE_PLAN', 'ARCHITECTURE_EVIDENCE'].includes(error.code)) throw error;
        const detail = error.diagnostics?.[0] || { stage: 'arguments', action: '修正该项证据字段' };
        const suffix = String(detail.field || '').replace(/^(entities|relations|requirements)\[0\]\.?/, '');
        diagnostics.push({ ...detail, field: `${group}[${index}]${suffix ? '.' + suffix : ''}`, message: String(error.message).slice(0, 240) });
      }
    }
  }
  if (!diagnostics.length) return resolved;
  const base = '文档检查/架构输入/' + crypto.randomUUID();
  const serialized = JSON.stringify({ version: 1, state: 'invalid', input });
  if (new TextEncoder().encode(serialized).length > 1e6) throw failure('输入草稿超过1MB，请拆分提交');
  const draft = await ws.write(base + '.submission.json', serialized);
  const receipt = await ws.write(base + '.issues.json', JSON.stringify({ total: diagnostics.length, diagnostics }));
  for (const file of [draft, receipt]) await execution.checkpoint?.({ type: 'file', path: file.path });
  const error = Object.assign(
    failure(
      `输入预检共${diagnostics.length}项失败；完整清单：${receipt.path}。输入已保留：${draft.path}。用draftPath和corrections逐项修补；不要重发整份底稿。`
    ),
    {
      code: diagnostics[0].stage === 'excerpt' ? 'ARCHITECTURE_EVIDENCE' : 'ARCHITECTURE_PLAN',
      diagnostics
    }
  );
  throw error;
}
