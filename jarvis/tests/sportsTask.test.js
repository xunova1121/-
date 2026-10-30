import { expect, it } from 'vitest';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createSportsScoresTool, clearScoresCache } from '../src/agent/sportsScores.js';
import { clearZhibo8Cache } from '../src/agent/sportsZhibo8.js';
import { useBackend } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

it('真实任务的预查赛程经专用事件传出并保存在原回答，工具文本截断不会丢卡片', async () => {
  useBackend(null); clearScoresCache(); clearZhibo8Cache();
  const date = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
  const list = [{ id: 'task-live', type: 'football', leagueid: '1', sdate: date, time: new Date(Date.now() + 28800000).toISOString().slice(11, 16), state: '2', period_cn: '中场', home_team: '虚构主队', visit_team: '虚构客队', home_score: '1', visit_score: '0' }];
  const runner = createTaskRunner({
    getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock' }),
    makeTools: ctx => [createSportsScoresTool({ ...ctx, fetchImpl: async () => ({ ok: true, json: async () => ({ list }) }), fetchViaGateway: async () => ({ ok: true, json: async () => ({ list }) }) })],
    makeAdapter: () => ({ model: 'fixture', adapter: { stream: async ({ onText }) => { const text = '这是当前赛程，已按进行中优先整理。'; onText?.(text); return { text, toolCalls: [], stop: 'end_turn' }; } } })
  });
  try {
    const task = await runner.start({ text: '足彩赛程' });
    const limit = Date.now() + 8000;
    while (!['done', 'error'].includes(runner.get(task.id).status)) { if (Date.now() > limit) throw Error('任务未结束'); await new Promise(r => setTimeout(r, 10)); }
    expect(runner.get(task.id).status).toBe('done');
    const e = runner.events(task.id).find(e => e.type === 'sports_scores');
    expect(e.value.events[0]).toMatchObject({ home: '虚构主队', score: '1 : 0', state: 'in' });
    const session = await sessions.get(task.sessionId);
    expect(session.messages.at(-1).sports).toEqual(e.value);
    expect(JSON.stringify(session.messages.at(-1).sports).length).toBeLessThan(9000);
  } finally { for (const t of runner.list()) runner.stop(t.id); await runner.settled(); }
}, 12000);
