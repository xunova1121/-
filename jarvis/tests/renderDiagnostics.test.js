import {describe,it,expect} from 'vitest';
import {cases} from './renderDiagnostics.cases.mjs';
describe('手机崩溃诊断与隐私边界',()=>{for(const [name,run] of cases)it(name,run);});

it('兼容模式生成时只计数；后台仅在可见性变化时记一次', async () => {
  const { startScreenTrail } = await import('../src/mobile/renderDiagnostics.js');
  const notes = [];
  let tick, change;
  const doc = {
    documentElement: { classList: { contains: key => key === 'safe-render' } },
    body: { classList: { contains: key => key === 'generating' } },
    querySelectorAll: () => ({ length: 4 }),
    getElementsByTagName: () => ({ length: 3000 }),
    getAnimations() { throw Error('生成期间不应触发样式遍历'); },
    hidden: false,
    addEventListener(_, callback) { change = callback; }
  };
  startScreenTrail({ doc, timer: cb => { tick = cb; }, storage: new Map(), note: text => notes.push(text) });
  tick();
  expect(notes.at(-1)).toContain('消息 4 条 · 正在回复 · 元素 3000 个');
  doc.hidden = true;
  change();
  const count = notes.length;
  tick();
  expect(notes).toHaveLength(count);
  expect(notes.at(-1)).toContain('在后台');
});
