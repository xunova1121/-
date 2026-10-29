/** 第一轮 30 题后的 8 项修正：评测读隔离、评审换模型、证据进评审提示、补救成功不报失败、决策题算账、改字号时文档工具常驻 */
import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import * as sessions from '../src/agent/sessions.js';
import * as memory from '../src/agent/memory.js';
import { buildContext } from '../src/agent/agent.js';
import { evaluationTools } from '../server/evaluation.mjs';
import { judgeConfig, availableModels } from '../evals/joint-judge.mjs';
import { judgePrompt } from '../evals/joint-rubric.mjs';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { taskContract } from '../src/agent/taskContract.js';
import { withDocumentStyles } from '../src/agent/documentStyles.js';

describe('评测会话不读用户个人信息（第一轮：叫出“长乐”、引用真实产检报告、用上真实字号偏好）', () => {
  it('上下文里没有核心记忆里的用户信息和基本情况', async () => {
    await memory.setCore('human', '用户叫测试长乐，住南京');
    await memory.remember('用户的老婆在孕期', 'profile', { importance: 5 });
    const s = sessions.create();
    await sessions.save(s);
    const normal = await buildContext('你好', { sessionId: s.id, turns: 0 });
    const isolated = await buildContext('你好', { sessionId: s.id, turns: 0, isolated: true });
    expect(normal.dynamic).toContain('测试长乐');
    expect(isolated.dynamic).not.toContain('测试长乐');
    expect(isolated.dynamic).not.toContain('孕期');
    expect(isolated.dynamic).toContain('评测会话');
    expect(isolated.memories).toEqual([]);
  });
  it('查记忆、旧对话、持仓、知识库的工具在评测里被拦下；普通会话不受影响', async () => {
    const tools = ['recall', 'search_conversations', 'list_holdings', 'kb_search', 'web_search'].map((name) => ({ name, run: async () => '真实数据' }));
    const isolated = evaluationTools(tools, 'eval-1');
    for (const t of isolated.slice(0, 4)) expect(await t.run({})).toMatch(/评测隔离/);
    expect(await isolated[4].run({})).toBe('真实数据');
    expect(await evaluationTools(tools, null)[0].run({})).toBe('真实数据');
  });
  it('文档写作提示里也不再附真实偏好（调用方给了空偏好时）', async () => {
    const seen = [];
    const ctx = withDocumentStyles({ documentStylePreferences: async () => '', llm: async (r) => { seen.push(r.prompt); return 'ok'; } }, async () => '【用户历史写作偏好】正文四号');
    await ctx.llm({ prompt: '写' });
    expect(seen[0]).toBe('写');
    expect(await ctx.documentStylePreferences()).toBe('');
  });
});

describe('评审员：默认挑和答题不同、看着最强的模型；看得到证据', () => {
  const cfg = { provider: 'custom', models: { custom: 'gpt-6-luna' }, keys: { custom: 'k' }, abilities: { write: { main: { provider: 'custom', model: 'gpt-6.1-sol' } } } };
  it('和答题模型相同就换一个', () => {
    expect(availableModels(cfg).map((l) => l.model)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(judgeConfig(cfg, '', 'gpt-6-luna').models.custom).toBe('gpt-6.1-sol');
    expect(judgeConfig(cfg, 'custom::gpt-6-luna', 'gpt-6-luna').models.custom).toBe('gpt-6-luna'); // 显式指定照用
  });
  it('评审提示里有每轮用的工具、文件读回内容和建好的提醒，并说明以证据为准', () => {
    const p = judgePrompt({ id: 'joint-07', group: 'calculation', rubric: ['运算工具核对'] }, {
      turns: [{ prompt: '算', answer: '821.4' }],
      evidence: [{ tools: [{ name: 'verify_numbers', calls: 1, failed: 0 }], files: [{ path: 'a.xlsx', rows: 4, formulas: 3 }] }],
      createdSchedules: [{ title: '喝水', at: 1 }]
    });
    expect(p.prompt).toContain('verify_numbers');
    expect(p.prompt).toContain('"formulas":3');
    expect(p.prompt).toContain('喝水');
    expect(p.system).toContain('以【程序记录的证据】为准');
  });
});

describe('改原文件失败、另存新版成功：不再挂“这些操作没成功”', () => {
  it('同格式的文档后来生成成功就算补救了', () => {
    const review = createExecutionReview('字再小一点');
    review.record({ name: 'edit_office_document', args: { path: 'a/广告.docx' }, ok: false });
    review.record({ name: 'create_document', args: { path: 'a/广告-小字版.docx' }, ok: true });
    expect(review.report().failures).toEqual([]);
  });
  it('后面没有补救成功的照旧报', () => {
    const review = createExecutionReview('字再小一点');
    review.record({ name: 'edit_office_document', args: { path: 'a/广告.docx' }, ok: false });
    expect(review.report().failures).toEqual(['edit_office_document']);
  });
});

describe('带数字的“选哪个 / 划算吗”要用工具算（第一轮：结论对、差额算错）', () => {
  it('认得出来，普通问题不误伤', () => {
    expect(taskContract('两个方案：A一次投入20万，每月省1万；B每月租金8千，不用投入。用两年，选哪个？').calculation).toBe(true);
    expect(taskContract('买房还是租房划算？月租3000，房价200万').calculation).toBe(true);
    expect(taskContract('哪个好看').calculation).toBe(false);
    expect(taskContract('这件衣服好看吗，199元').calculation).toBe(false);
  });
});

describe('评审员不能选中语音 / 画图模型（第二轮实测：选中 fun-asr-flash-2026-06-15，每题 400）', () => {
  it('排除不能聊天的模型，日期不当版本号', () => {
    const cfg = { provider: 'custom', models: { custom: 'gpt-6-luna', qwen: 'fun-asr-flash-2026-06-15' }, keys: { custom: 'k', qwen: 'k' }, abilities: { reason: { main: { provider: 'custom', model: 'gpt-6.1-sol' } }, embed: { main: { provider: 'qwen', model: 'text-embedding-v4' } } }, fallbackModels: [{ provider: 'qwen', model: 'qwen3-max-2026-01-23' }] };
    const models = availableModels(cfg).map((l) => l.model);
    expect(models).not.toContain('fun-asr-flash-2026-06-15');
    expect(models).not.toContain('text-embedding-v4');
    expect(judgeConfig(cfg, '', 'gpt-6-luna').models.custom).toBe('gpt-6.1-sol');
  });
});

describe('第二轮 30 题：告示不误报“这一节没有内容”；被新版取代的旧文件错误不算未解决', () => {
  it('告示里写成小标题的一行不算空节，普通文档照查', async () => {
    const { lint } = await import('../src/agent/selfCheck.js');
    const md = '# 王家园门面房招租\n\n## 120平方\n\n## 价格面议\n\n## 联系电话：13800000000';
    expect(lint('docx', md, { kind: 'poster' }).filter((i) => /没有内容/.test(i.text))).toEqual([]);
    expect(lint('docx', md).filter((i) => /没有内容/.test(i.text)).length).toBe(3);
  });
  it('后来同格式、无错的新文件读回通过：旧文件的错误不进报告', () => {
    const review = createExecutionReview('字再小一点');
    review.artifact({ path: 'a/招租_排版.docx', validation: { format: 'docx', readback: 'passed', errors: 2 } }, 1);
    expect(review.report().artifacts.some((a) => a.errors > 0)).toBe(true);
    review.artifact({ path: 'a/招租.docx', validation: { format: 'docx', readback: 'passed', errors: 0 } }, 2);
    expect(review.report().artifacts.some((a) => a.errors > 0)).toBe(false);
  });
});

describe('天气来源给本次取数的链接（第二轮 30 题：只给 Open-Meteo 首页）', () => {
  it('Open-Meteo 结果带上实际请求的链接', async () => {
    const { getWeather } = await import('../src/agent/weather.js');
    const get = async (url) => new Response(JSON.stringify(url.includes('geocoding') ? { results: [{ name: '南京', latitude: 32.06, longitude: 118.78, country: '中国' }] } : { current: {}, daily: { time: ['2026-10-30'], weather_code: [0], temperature_2m_min: [12], temperature_2m_max: [22], precipitation_probability_max: [0] } }));
    const text = await getWeather('南京', { get });
    expect(text).toMatch(/本次数据链接.*https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=32\.06&longitude=118\.78/);
  });
});

describe('和风天气：来源给这个城市的预报页（接口返回的 fxLink）', () => {
  it('查城市带回链接，天气文字里给出', async () => {
    const { lookupQWeatherCity, formatQWeather } = await import('../src/core/qweather.js');
    const fetchImpl = async () => new Response(JSON.stringify({ code: '200', location: [{ name: '南京', lat: '32.04', lon: '118.76', adm1: '江苏省', adm2: '南京', country: '中国', fxLink: 'https://www.qweather.com/weather/nanjing-101190101.html' }] }));
    const [city] = await lookupQWeatherCity({ key: 'k', host: 'h', query: '南京', fetchImpl });
    expect(city.link).toBe('https://www.qweather.com/weather/nanjing-101190101.html');
    const text = formatQWeather('南京', { at: '2026-10-30T09:00', text: '晴', temp: 18, extra: {}, days: [] }, 3, city.link);
    expect(text).toContain('本次数据链接（引用来源时给这个，不要只给首页）：https://www.qweather.com/weather/nanjing-101190101.html');
  });
  it('不是和风天气域名的链接不收', async () => {
    const { lookupQWeatherCity } = await import('../src/core/qweather.js');
    const fetchImpl = async () => new Response(JSON.stringify({ code: '200', location: [{ name: '南京', lat: '32', lon: '118', fxLink: 'https://evil.example/x' }] }));
    expect((await lookupQWeatherCity({ key: 'k', host: 'h', query: '南京', fetchImpl }))[0].link).toBeUndefined();
  });
});
