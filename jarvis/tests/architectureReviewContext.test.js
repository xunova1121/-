import { it, expect, vi } from 'vitest';
import { serializeArchitectureReviewContext } from '../src/agent/architectureReviewContext.js';
import { architectureReviewInput } from '../src/agent/architectureReviewResponse.js';
import { reviewArchitecture } from '../src/agent/architectureReview.js';

const proof = { source: '虚构材料.md', excerpt: '原文明确受理后办理，保留完整事项依据。'.repeat(12) };
const plan = () => ({
  title: '虚构审查上下文',
  entities: [
    { id: 'a', title: '受理', kind: 'application', inputs: [], outputs: ['事项'], ...proof },
    { id: 'b', title: '办理', kind: 'application', inputs: ['事项'], outputs: [], ...proof }
  ],
  relations: [{ from: 'a', to: 'b', type: 'workflow', meaning: '受理后办理', ...proof }],
  requirements: [{ text: proof.excerpt.slice(0, 100), entities: ['a', 'b'], ...proof }]
});
const rawContext = (value, options = {}) => ({
  plan: architectureReviewInput(value), sourceMaterials: options.materials || [], userRequest: options.rawRequestText || '',
  ...(options.previousUserEvidence?.length && { previousUserEvidence: options.previousUserEvidence }),
  ...(options.recoveryReason && { recoveryReason: options.recoveryReason })
});

it('仅重复证据变为程序字典引用，完整原文、需求text、reviewTarget及磁盘底稿原样保留', () => {
  const value = plan(), before = structuredClone(value), options = {
    materials: [{ path: proof.source, text: '\uFEFF原文\r\n全角“引用”与零宽\u200b字符，' + proof.excerpt }],
    rawRequestText: '根据完整材料核对全部业务', previousUserEvidence: ['用户补充要求'], recoveryReason: '保留本次原因'
  }, source = structuredClone(options.materials), text = serializeArchitectureReviewContext(value, options), payload = JSON.parse(text);
  expect(text.length).toBeLessThan(JSON.stringify(rawContext(value, options)).length);
  expect(payload.sourceMaterials).toEqual(source); expect(JSON.stringify(payload.sourceMaterials)).toBe(JSON.stringify(source));
  expect(payload.userRequest).toBe(options.rawRequestText); expect(payload.previousUserEvidence).toEqual(options.previousUserEvidence);
  expect(payload.recoveryReason).toBe(options.recoveryReason); expect(Object.keys(payload.evidenceDictionary)).toHaveLength(1);
  for (const group of ['entities', 'relations', 'requirements']) for (const [index, row] of payload.plan[group].entries()) {
    const original = rawContext(value).plan[group][index], entry = payload.evidenceDictionary[row.evidenceRef];
    expect(entry).toEqual({ source: original.source, excerpt: original.excerpt }); expect(row.source).toBe(original.source);
    expect(row).not.toHaveProperty('excerpt'); expect(row.reviewTarget).toBe(original.reviewTarget);
    const { evidenceRef, ...rest } = row; expect({ ...rest, excerpt: entry.excerpt }).toEqual(original);
  }
  expect(payload.plan.requirements[0].text).toBe(value.requirements[0].text);
  expect(value).toEqual(before); expect(options.materials).toEqual(source);
});

it('不同引号/空格/来源不被当成相同证据，唯一摘录不挪动；短引用无节省则原样发送', () => {
  const value = plan();
  value.entities[1].excerpt = proof.excerpt + ' ';
  value.relations[0].source = '另一个原件.md';
  const payload = JSON.parse(serializeArchitectureReviewContext(value));
  expect(Object.values(payload.evidenceDictionary)).toEqual([proof]);
  expect(payload.plan.entities[1].excerpt).toBe(value.entities[1].excerpt);
  expect(payload.plan.relations[0].excerpt).toBe(proof.excerpt);
  const short = plan();
  for (const group of ['entities', 'relations', 'requirements']) for (const row of short[group]) row.excerpt = '甲';
  expect(serializeArchitectureReviewContext(short)).toBe(JSON.stringify(rawContext(short)));
});

it('去重后低于原200k才调用审查模型；核实仍依赖真实模型意见，不自动判通过', async () => {
  const value = plan(), materials = [{ path: proof.source, text: '' }], consume = vi.fn();
  materials[0].text = '材'.repeat(200100 - JSON.stringify(rawContext(value, { materials })).length);
  const original = JSON.stringify(rawContext(value, { materials }));
  expect(original.length).toBeGreaterThan(200000);
  const llm = vi.fn(async request => {
    expect(request.prompt.length).toBeLessThanOrEqual(200000);
    const payload = JSON.parse(request.prompt);
    expect(payload.sourceMaterials).toEqual(materials); expect(payload.evidenceDictionary).toBeTruthy();
    expect(request.system).toContain('evidenceRef'); expect(consume).toHaveBeenCalledTimes(1);
    return '{"passed":false,"issues":[{"target":"requirement:0","kind":"coverage","detail":"原文仍需核对完整业务覆盖"}]}';
  });
  const report = await reviewArchitecture({ llm }, value, { materials, retrieval: { consume } });
  expect(report).toMatchObject({ structure: 'passed', semantic: 'failed', issues: [{ target: 'requirement:0' }] });
  expect(llm).toHaveBeenCalledTimes(1);
});

it('无法无损缩至200k仍维持SIZE且零模型调用/扣费，不裁原文来凑门槛', async () => {
  const value = plan(), materials = [{ path: proof.source, text: '材'.repeat(200001) }], before = structuredClone(value);
  const payload = JSON.parse(serializeArchitectureReviewContext(value, { materials }));
  expect(payload.sourceMaterials).toEqual(materials);
  const llm = vi.fn(), consume = vi.fn();
  expect(await reviewArchitecture({ llm }, value, { materials, retrieval: { consume } })).toMatchObject({ structure: 'passed', semantic: 'not_checked', errorCode: 'ARCHITECTURE_REVIEW_SIZE' });
  expect(llm).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled(); expect(value).toEqual(before);
});

it('字典容量受240条和2MB约束，超界不裁数据也不生成无界证据索引', () => {
  const oversized = plan(); oversized.requirements = Array.from({ length: 241 }, () => ({ ...oversized.requirements[0] }));
  expect(serializeArchitectureReviewContext(oversized)).toBe(JSON.stringify(rawContext(oversized)));
  const value = plan(), materials = [{ path: proof.source, text: '甲'.repeat(700000) }];
  expect(serializeArchitectureReviewContext(value, { materials })).toBe(JSON.stringify(rawContext(value, { materials })));
});
