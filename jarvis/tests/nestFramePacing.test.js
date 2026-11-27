import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNestFramePacing } from '../src/ui/nestFramePacing.js';

let next, count;
beforeEach(() => {
  count = 0;
  next = null;
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('requestAnimationFrame', callback => { next = callback; return ++count; });
  vi.stubGlobal('cancelAnimationFrame', () => { next = null; });
});
afterEach(() => vi.unstubAllGlobals());

function sampleScene(desktop = true) {
  const scene = { isConnected: true, closest: () => desktop, setAttribute: vi.fn() };
  return { scene, pacing: createNestFramePacing(scene) };
}

function frame(time) {
  const callback = next;
  next = null;
  callback(time);
}

it('只在同一轮出现多次慢帧后降档，随后停止取样', () => {
  const { scene, pacing } = sampleScene();
  pacing.sample();
  for (const time of [100, 200, 216, 310]) frame(time);
  expect(scene.setAttribute).not.toHaveBeenCalled();
  frame(420);
  expect(scene.setAttribute).toHaveBeenCalledWith('data-paced-motion', '');
  pacing.sample();
  expect(next).toBeNull();
});

it('正常帧率和单次卡顿按原时序，采样有上限，离开时撤销回调', () => {
  const { scene, pacing } = sampleScene();
  pacing.sample();
  frame(10);
  for (let i = 0; i < 32; i++) frame(150 + i * 16);
  expect(next).toBeNull();
  expect(scene.setAttribute).not.toHaveBeenCalled();
  pacing.sample();
  expect(next).toBeTypeOf('function');
  pacing.stop();
  expect(next).toBeNull();
});

it('手机小窝和后台页面不启动采样', () => {
  sampleScene(false).pacing.sample();
  document.hidden = true;
  sampleScene().pacing.sample();
  expect(count).toBe(0);
});
