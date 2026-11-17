/** 2026-11-17 用户：别人做的确实比我们好看。宣传类字少的海报由画图模型整图出稿，程序逐字核对 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { aiPosterTexts, aiPosterPrompt, compareTexts, deliverAiPoster } from '../src/agent/aiPoster.js';
import { createPosterDeliveryTool } from '../src/agent/posterDeliveryTool.js';
import { posterReceipt, POSTER_GUIDANCE } from '../src/agent/posterRouting.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { collection, useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';

beforeEach(async () => { useBackend(null); for (const name of ['files', 'kv', 'sessions']) await collection(name).clear(); });
const png = (type = 'image/png') => { const c = createCanvas(320, 480), g = c.getContext('2d'); g.fillStyle = '#123456'; g.fillRect(0, 0, 320, 480); return new Blob([c.toBuffer(type)], { type }); };
const spec = { prompt: '夜晚灯光球场，国家队球员冲刺，科技蓝', texts: { title: '今晚国足出战', subtitle: '中国男足 vs 巴林', lines: ['20:00 开球', '直播吧全程直播'], footer: '赛程以官方为准' } };

describe('AI整图出稿', () => {
  it('只适合字少的宣传海报：超量直接要求改用design程序排字', () => {
    expect(aiPosterTexts(spec.texts).all).toEqual(['今晚国足出战', '中国男足 vs 巴林', '20:00 开球', '直播吧全程直播', '赛程以官方为准']);
    expect(() => aiPosterTexts({ title: 't', lines: Array(6).fill('一') })).toThrow(/design/);
    expect(() => aiPosterTexts({ title: '标'.repeat(17) })).toThrow(/16字/);
    expect(() => aiPosterTexts({ title: 't', lines: Array(5).fill('字'.repeat(20)) })).toThrow(/90字/);
    expect(() => aiPosterTexts({})).toThrow(/标题/);
  });
  it('要求里逐字列出文字并禁止多写；重画时写明上次错的字', () => {
    const p = aiPosterPrompt(spec.prompt, aiPosterTexts(spec.texts), ['20:00 开球']);
    for (const w of ['「今晚国足出战」', '逐字照写', '不加任何其它文字', '上一次这些字没写对', '「20:00 开球」']) expect(p).toContain(w);
  });
  it('核对忽略空格、标点和大小写差异，但错字算错', () => {
    expect(compareTexts(['中国男足 vs 巴林', '20:00 开球'], '中国男足VS巴林\n20：00开球').status).toBe('passed');
    expect(compareTexts(['直播吧全程直播'], '直播吧全程直撥')).toEqual({ status: 'failed', missing: ['直播吧全程直播'] });
  });
  it('第一次有错字：带着修正要求重画一次，第二次全对就交付', async () => {
    const reads = ['今晚国足出战 中国男足vs巴林 20:00开球 直播吧全程直撥 赛程以官方为准', '今晚国足出战 中国男足vs巴林 20:00开球 直播吧全程直播 赛程以官方为准'];
    const imageGen = vi.fn(async () => ({ blob: png(), model: 'fixture' })), ocr = vi.fn(async () => ({ text: reads.shift(), model: 'ocr' }));
    const r = JSON.parse(await deliverAiPoster({ ai_full: spec, path: '海报/国足.png' }, { imageGen, ocr, renderVisualScene }));
    expect(imageGen).toHaveBeenCalledTimes(2);
    expect(imageGen.mock.calls[1][0].prompt).toContain('「直播吧全程直播」');
    expect(r).toMatchObject({ renderer: 'ai_full', status: 'complete', width: 320, height: 480, textCheck: { status: 'passed', method: 'ocr', missing: [] } });
    expect(r.textCheck.tries).toEqual([{ status: 'failed', missing: ['直播吧全程直播'] }, { status: 'passed', missing: [] }]);
    expect(await ws.exists('海报/国足.png')).toBe(true);
    expect(posterReceipt(true, JSON.stringify(r)).state).toBe('completed');
  });
  it('重画后仍不对、或没有识别能力：标为待核对，不当成品，建议改用design', async () => {
    const imageGen = async () => ({ blob: png(), model: 'fixture' });
    const bad = JSON.parse(await deliverAiPoster({ ai_full: spec, path: 'a/x.png' }, { imageGen, ocr: async () => ({ text: '乱码', model: 'o' }), renderVisualScene }));
    expect(bad.status).toBe('partial');
    expect(bad.errors[0].code).toBe('POSTER_AI_TEXT_MISMATCH');
    expect(bad.guidance).toContain('design');
    expect(posterReceipt(true, JSON.stringify(bad)).state).not.toBe('completed');
    const none = JSON.parse(await deliverAiPoster({ ai_full: spec, path: 'a/y.png' }, { imageGen, renderVisualScene }));
    expect(none.errors[0].code).toBe('POSTER_AI_TEXT_UNVERIFIED');
  });
  it('画图服务回JPEG也统一交付PNG', async () => {
    const r = JSON.parse(await deliverAiPoster({ ai_full: spec, path: 'a/j.png' }, { imageGen: async () => ({ blob: png('image/jpeg') }), ocr: async () => ({ text: spec.texts.title + spec.texts.subtitle + spec.texts.lines.join('') + spec.texts.footer }), renderVisualScene }));
    expect(r.files[0].path).toBe('a/j.png');
    expect(new Uint8Array(await (await ws.readBlob('a/j.png')).arrayBuffer()).slice(1, 4)).toEqual(new Uint8Array([80, 78, 71]));
  });
  it('走海报交付会话：成品进入交付索引；海报指引写明何时用整图、何时用程序排字', async () => {
    const tool = createPosterDeliveryTool({ imageGen: async () => ({ blob: png() }), ocr: async () => ({ text: aiPosterTexts(spec.texts).all.join('') }), renderVisualScene });
    const r = JSON.parse(await tool.run({ title: '今晚国足出战', ai_full: spec }, { executionScope: {}, rawRequestText: '做一张图文并茂的海报' }));
    expect(r.delivery.primaryPath).toMatch(/\.png$/);
    expect(r.delivery.attempts).toBe(1);
    for (const w of ['ai_full', '信息多的用design']) expect(POSTER_GUIDANCE).toContain(w);
  });
});

it('图文并茂请求：有看图模型时复核画面切题、文字清楚，通过才算成品', async () => {
  const visionLlm = vi.fn(async () => JSON.stringify({ relatedToTopic: true, readable: true, issues: [] }));
  const tool = createPosterDeliveryTool({ imageGen: async () => ({ blob: png() }), ocr: async () => ({ text: aiPosterTexts(spec.texts).all.join('') }), visionLlm, renderVisualScene });
  const r = JSON.parse(await tool.run({ title: '今晚国足出战', ai_full: spec }, { executionScope: {}, rawRequestText: '做一张图文并茂的海报' }));
  expect(r.contentCheck).toMatchObject({ status: 'passed', semantic: 'passed' });
  expect(r.status).toBe('complete');
  const off = createPosterDeliveryTool({ imageGen: async () => ({ blob: png() }), ocr: async () => ({ text: aiPosterTexts(spec.texts).all.join('') }), visionLlm: async () => JSON.stringify({ relatedToTopic: false, readable: true }), renderVisualScene });
  expect(JSON.parse(await off.run({ title: '今晚国足出战', ai_full: spec }, { executionScope: {}, rawRequestText: '做一张图文并茂的海报' })).status).toBe('partial');
});
