import { it, expect, vi } from 'vitest';
vi.mock('../src/app/env.js', () => ({ DESKTOP: true, COMPACT: false, $: () => null }));
import { createTurnInputs } from '../src/app/turnInputs.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

it('真实PC选路入口：服务器仓库禁删测试走服务器；明确桌面操作仍走本机工具', () => {
  const app = { history: [], session: {}, server: {}, llmConfig: { ...DEFAULT_CONFIG, provider: 'mock' }, settings: { teamMode: 'off' }, helperLlm: () => null, hud: { think: () => {} } };
  const inputs = createTurnInputs(app), media = { imgs: [], withImages: new Set() };
  const turn = {}, state = {};
  const remote = inputs.chooseTurnModel('继续原商城工作副本，运行 npm test；不要删除测试，不修改锁文件。', turn, state, media);
  expect(remote).toMatchObject({ here: false, remotePC: false, computerKind: null });
  expect(turn.remote).toBe(true);
  const local = inputs.chooseTurnModel('打开桌面上的仓库文件夹', turn, state, media);
  expect(local.here).toBe(true);
  expect(turn.remote).toBe(false);
});
