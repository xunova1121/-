import { it, expect } from 'vitest';
import { architectureReferences, architectureCitation } from '../src/agent/architectureReferences.js';
import { compileArchitectureContent } from '../src/agent/architectureWorkflowInput.js';
it('程序块完整连续、稳定、不拆代理对；全角标点无需模型抄写', () => {
  const text = ('示范园区按“统一入口、多端接入”的规则登记用户，用户分为两组。\n' + '甲'.repeat(180) + '😀\n').repeat(20);
  const materials = [{ path: '虚构.md', text }],
    refs = architectureReferences(materials);
  expect(refs[0].blocks.map((b) => b.text).join('')).toBe(text);
  expect(architectureReferences(materials)).toEqual(refs);
  for (const b of refs[0].blocks) {
    expect(b.text.length).toBeLessThanOrEqual(240);
    expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(b.text)).toBe(false);
  }
  expect(architectureCitation({ material: 0, block: 0 }, materials).excerpt).toBe(refs[0].blocks[0].text);
  expect(() => architectureCitation({ material: 0, quote: '示范园区按“统一入口、多端接入”的规则登记用户。' }, materials)).toThrow();
});
it('拒绝伪编号、跨材料编号和引文混填；仅可绑定当前实际材料', () => {
  const materials = [{ path: '虚构.md', text: '真实文字' }];
  for (const citation of [
    { material: 2, block: 0 },
    { material: 0, block: 9 },
    { material: 0, block: -1 },
    { material: 0, block: '0' },
    { material: 0, block: 0, quote: '真实文字' }
  ])
    expect(() => architectureCitation(citation, materials)).toThrow();
  expect(() => architectureReferences([{ path: 'x', text: '甲'.repeat(180001) }])).toThrow();
});
it('所有引用错误一次回显，实际需求取程序原文而非模型概括', () => {
  const materials = [{ path: '虚构.md', text: '真实文字，事实1项。' }];
  const content = {
    title: '图',
    entities: [{ id: 'a', citation: { material: 0, block: 0 } }],
    relations: [{ from: 'a', to: 'b', citation: { material: 0, block: 99 } }],
    requirements: [{ entities: ['a'], citation: { material: 0, block: 98 } }]
  };
  let error;
  try {
    compileArchitectureContent(content, [], materials);
  } catch (e) {
    error = e;
  }
  expect(error.diagnostics.map((d) => d.field)).toEqual(['relations[0].citation', 'requirements[0].citation']);
  content.relations[0].citation.block = 0;
  content.requirements[0].citation.block = 0;
  content.requirements[0].text = '模型概括';
  const result = compileArchitectureContent(content, [], materials);
  expect(result.requirements[0].text).toBe(materials[0].text);
  expect(result.entities[0].excerpt).toBe(materials[0].text);
});
