import { diagramDigest } from './diagramExport.js';
import { throwControl } from '../core/networkRequest.js';
const invalid = message => Object.assign(new Error(message), { code: 'ARCHITECTURE_EVIDENCE', kind: 'input', diagnostics: [{ field: 'evidenceId', stage: 'excerpt', action: '用prepare_architecture_evidence从当前sources读取编号；材料变化后重新取编号，不手写或改写摘录' }] });
export const EVIDENCE_LIMITS = Object.freeze({ sources: 4, chars: 120000, span: 240, entries: 4096, page: 20 });

/** 无正文快照/全局注册表：编号绑定路径、当前读取范围全文和连续位置，重新读材料即可核验。 */
async function evidenceMaterials(materials, checks = [], signal) {
  if (!Array.isArray(materials) || !materials.length || materials.length > EVIDENCE_LIMITS.sources) throw invalid('证据编号需要1～4份实际材料');
  const prepared = [];
  const hashes = new Set();
  for (let index = 0; index < materials.length; index++) {
    throwControl(null, signal);
    const material = materials[index];
    if (typeof material.path !== 'string' || typeof material.text !== 'string') throw invalid('材料缺少路径或正文');
    if (checks[index]?.truncated || material.text.length > EVIDENCE_LIMITS.chars) throw invalid('材料未完整读取或超过12万字；请用唯一章节起止明确范围后再编号');
    if (!material.text.trim()) throw invalid('材料没有可编号的正文');
    const hash = await diagramDigest(JSON.stringify([material.path, material.text]));
    if (hashes.has(hash)) throw invalid('来源范围重复，请去掉重复材料');
    hashes.add(hash);
    prepared.push({ ...material, hash });
  }
  return prepared;
}

/** 查询连续全文，避免关键词恰好跨分页边界时漏查；旧的无查询编号保持不变。 */
export async function architectureEvidence(materials, checks = [], signal, query = '') {
  if (typeof query !== 'string' || query.length > 120) throw invalid('证据关键词最多120字符');
  const prepared = await evidenceMaterials(materials, checks, signal);
  const items = [];
  for (const material of prepared) {
    const { hash } = material;
    if (query) {
      let position = material.text.indexOf(query);
      while (position >= 0) {
        throwControl(null, signal);
        let start = Math.max(0, position - Math.floor((EVIDENCE_LIMITS.span - query.length) / 2));
        if (start && /[\uDC00-\uDFFF]/.test(material.text[start])) start--;
        let end = Math.min(material.text.length, start + EVIDENCE_LIMITS.span);
        if (end < material.text.length && /[\uD800-\uDBFF]/.test(material.text[end - 1])) end--;
        if (items.length >= EVIDENCE_LIMITS.entries) throw invalid('关键词命中超过4096处，请缩小章节或使用更具体的关键词');
        const evidenceId = `ev:${hash}:${start}:${end - start}`;
        if (items.at(-1)?.evidenceId !== evidenceId) items.push({ evidenceId, source: material.path, start, end, text: material.text.slice(start, end).trim() });
        position = material.text.indexOf(query, position + query.length);
      }
      continue;
    }
    for (let start = 0; start < material.text.length;) {
      let end = Math.min(start + EVIDENCE_LIMITS.span, material.text.length);
      // 优先落在后半段的句子/段落边界；固定上限，不因全文无标点而无界增长。
      const window = material.text.slice(start, end);
      const boundary = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('；'));
      if (end < material.text.length && boundary >= 120) end = start + boundary + 1;
      if (end < material.text.length && /[\uD800-\uDBFF]/.test(material.text[end - 1])) end--;
      const raw = material.text.slice(start, end);
      if (raw.trim()) {
        if (items.length >= EVIDENCE_LIMITS.entries) throw invalid('证据片段超过4096条，请拆分章节范围');
        items.push({ evidenceId: `ev:${hash}:${start}:${end - start}`, source: material.path, start, end, text: raw.trim() });
      }
      start = end;
    }
  }
  throwControl(null, signal);
  return items;
}

/** 只把真实编号替换为程序读到的路径与原文，再交原校验/业务审查；旧手填方式保持兼容。 */
export async function resolveArchitectureEvidence(input, materials, checks, signal) {
  const groups = ['entities', 'relations', 'requirements'];
  for (const [key, max] of [['entities', 60], ['relations', 100], ['requirements', 80]])
    if (Array.isArray(input[key]) && input[key].length > max) throw invalid(key + '超过底稿条数上限');
  if (!groups.some(key => Array.isArray(input[key]) && input[key].some(item => (item?.evidenceId !== undefined || item?.basisEvidenceId !== undefined)))) return input;
  const prepared = await evidenceMaterials(materials, checks, signal);
  // 编号不依赖分页方式或全局注册表，但必须绑定本次重读全文摘要和有效连续范围。
  const proofFor = id => {
    if (typeof id !== 'string' || id.length > 120) return null;
    const match = /^ev:((?:sha256:[a-f0-9]{64}|checksum:[a-f0-9]{2,16})):(0|[1-9]\d*):([1-9]\d*)$/.exec(id);
    if (!match) return null;
    const material = prepared.find(item => item.hash === match[1]);
    const start = Number(match[2]), end = start + Number(match[3]);
    if (!material || end > material.text.length || end - start > EVIDENCE_LIMITS.span || !Number.isSafeInteger(end)) return null;
    if (start && /[\uDC00-\uDFFF]/.test(material.text[start]) || end < material.text.length && /[\uD800-\uDBFF]/.test(material.text[end - 1])) return null;
    const text = material.text.slice(start, end).trim();
    return text ? { source: material.path, text } : null;
  };
  const result = { ...input };
  for (const key of groups) {
    if (!Array.isArray(input[key])) continue;
    result[key] = input[key].map((item, index) => {
      if (item?.evidenceId === undefined && item?.basisEvidenceId === undefined) return item;
      const isBasis = item.basisEvidenceId !== undefined;
      const proof = proofFor(isBasis ? item.basisEvidenceId : item.evidenceId);
      const fail = message => {
        const error = invalid(message);
        error.diagnostics[0].field = `${key}[${index}].evidenceId`;
        throw error;
      };
      if (isBasis) {
        if (key === 'requirements' || !item.assumption || item.evidenceId !== undefined || item.source !== undefined || item.excerpt !== undefined) fail('设计推导需assumption和basisEvidenceId，不得同时声明事实编号或手填原文；采购需求不能是推导');
        if (!proof) fail('设计依据编号不存在或原文已变化，请重新取号');
        return { ...item, basis: { source: proof.source, excerpt: proof.text, evidenceId: item.basisEvidenceId } };
      }
      if (!proof) fail('证据编号不存在或材料/读取范围已变化，请重新取当前编号');
      if (item.assumption || item.source !== undefined && item.source !== proof.source || item.excerpt !== undefined && item.excerpt !== proof.text)
        fail('编号与手填来源/摘录冲突，或同时声明假设；请只引用编号，不混用其他证据');
      return { ...item, source: proof.source, excerpt: proof.text, ...(key === 'requirements' && item.text === undefined && { text: proof.text }) };
    });
  }
  return result;
}

/** 编号已核验后，用对应连续原文填来源定位摘录；显式错误摘录绝不覆盖。 */
export function bindEvidenceSources(sources, checks, materials, resolved) {
  return checks.map((check, index) => {
    const bound = ['entities', 'relations', 'requirements'].flatMap(key => Array.isArray(resolved[key]) ? resolved[key] : [])
      .find(item => item.evidenceId && item.source === check.path && materials[index].text.includes(item.excerpt));
    const excerpt = sources[index].excerpt || bound?.excerpt || '';
    const compact = text => text.replace(/\s+/g, '');
    return { ...check, excerpt, matched: Boolean(excerpt && compact(materials[index].text).includes(compact(excerpt))) };
  });
}
