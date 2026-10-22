/** 模型按能力配置：每项能力一个常用、一个备用；填了哪家 Key 就按能力表自动排；老配置照旧 */
import { describe, it, expect } from 'vitest';
import { abilityLines, autoLine, setAbility, CAPABILITIES } from '../src/llm/abilities.js';
import { routeFor, fallbackRoutes, visionRoute, seesImages } from '../src/llm/router.js';
import { generateImage } from '../src/llm/images.js';
import { resolveEmbedding, createEmbedder } from '../src/llm/embeddings.js';
import { copyModelSettings, catalogKey } from '../src/llm/modelLibrary.js';

// 用户的情况：对话 DeepSeek，看图和向量用智谱，画图用 GPT
const USER = { provider: 'deepseek', models: { deepseek: 'deepseek-v4-pro' }, keys: { deepseek: 'sk-d', zhipu: 'zp', openai: 'sk-o' }, baseURLs: {} };

describe('自动排', () => {
  it('看图、向量排到智谱，画图排到 GPT；对话、思考、写代码都用当前的 DeepSeek', () => {
    expect(abilityLines(USER, 'chat').main).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    expect(abilityLines(USER, 'reason').main).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    expect(abilityLines(USER, 'code').main).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    expect(abilityLines(USER, 'vision').main).toEqual({ provider: 'zhipu', model: 'glm-4.5v' });
    expect(abilityLines(USER, 'embed').main).toEqual({ provider: 'zhipu', model: 'embedding-3' });
    expect(abilityLines(USER, 'image').main).toEqual({ provider: 'openai', model: 'gpt-image-1' });
  });
  it('备用自动找另一家', () => {
    expect(abilityLines(USER, 'vision').backup.provider).toBe('openai');
    expect(abilityLines(USER, 'image').backup).toEqual({ provider: 'zhipu', model: 'cogview-4' });
    expect(abilityLines(USER, 'embed').backup).toEqual({ provider: 'openai', model: 'text-embedding-3-small' });
  });
  it('拉取过模型列表的，按实际列表挑最新的同类型号；向量只挑向量模型', () => {
    const cfg = { ...USER, modelLists: { 'zhipu|': { ids: ['glm-4.5', 'glm-4.5v', 'glm-4.6v', 'embedding-2', 'embedding-3', 'cogview-3'] } } };
    expect(autoLine(cfg, 'vision')).toEqual({ provider: 'zhipu', model: 'glm-4.6v' });
    expect(autoLine(cfg, 'embed')).toEqual({ provider: 'zhipu', model: 'embedding-3' });
    expect(seesImages('glm-4.6v')).toBe(true);
  });
  it('中转站没有推荐型号：模型列表里有 gpt-image 才排它画图', () => {
    const relay = { provider: 'relay-multi', models: { 'relay-multi': 'claude-sonnet-5' }, keys: { 'relay-multi': 'k' }, baseURLs: { 'relay-multi': 'https://r.example' } };
    expect(autoLine(relay, 'image')).toBeNull();
    const listed = { ...relay, modelLists: { [catalogKey(relay, 'relay-multi')]: { ids: ['gpt-image-1', 'gpt-image-2', 'gpt-5.1'] } } };
    expect(autoLine(listed, 'image')).toEqual({ provider: 'relay-multi', model: 'gpt-image-2' });
  });
  it('一家能做的都没有：null；能力表的每一行都有认型号的规则', () => {
    expect(abilityLines({ provider: 'deepseek', models: {}, keys: { deepseek: 'k' } }, 'image').main).toBeNull();
    for (const rows of Object.values(CAPABILITIES)) for (const r of rows) expect(r.pick).toBeInstanceOf(RegExp);
  });
});

describe('亲手设过的优先', () => {
  it('设了常用就用设的，不再自动排；设成“没有备用”就不找备用', () => {
    let cfg = setAbility(USER, 'vision', 'main', { provider: 'openai', model: 'gpt-5.1' });
    cfg = setAbility(cfg, 'vision', 'backup', null);
    expect(abilityLines(cfg, 'vision')).toEqual({ main: { provider: 'openai', model: 'gpt-5.1' }, backup: null, set: true });
    expect(visionRoute(cfg)).toMatchObject({ provider: 'openai', model: 'gpt-5.1', auto: false });
  });
  it('写代码设成别家：这一轮按写代码换模型，出错先换写代码的备用', () => {
    let cfg = setAbility(USER, 'code', 'main', { provider: 'zhipu', model: 'glm-4.6' });
    cfg = setAbility(cfg, 'code', 'backup', { provider: 'openai', model: 'gpt-5.1' });
    const r = routeFor(cfg, 'code');
    expect(r).toMatchObject({ routed: true, provider: 'zhipu', model: 'glm-4.6' });
    expect(r.cfg.provider).toBe('zhipu');
    expect(routeFor(cfg, 'chat').routed).toBe(false);
    expect(fallbackRoutes(cfg, { provider: 'zhipu', model: 'glm-4.6', task: 'code' })[0]).toMatchObject({ provider: 'openai', model: 'gpt-5.1' });
  });
  it('设的那家 Key 被删了：退回自动', () => {
    const cfg = setAbility(USER, 'vision', 'main', { provider: 'qwen', model: 'qwen-vl-max' });
    expect(abilityLines(cfg, 'vision').main).toEqual({ provider: 'zhipu', model: 'glm-4.5v' });
  });
  it('复制到服务器时带上能力表', () => {
    const cfg = setAbility(USER, 'image', 'main', { provider: 'openai', model: 'gpt-image-1' });
    expect(copyModelSettings(cfg).abilities.image.main).toEqual({ provider: 'openai', model: 'gpt-image-1' });
  });
});

describe('老配置照旧', () => {
  it('模型分工里设过的看图、写代码继续生效', () => {
    const cfg = { ...USER, routing: { enabled: true, provider: 'deepseek', routes: { vision: 'qwen::qwen-vl-max', code: 'deepseek-v4-flash' } }, keys: { ...USER.keys, qwen: 'q' } };
    expect(abilityLines(cfg, 'vision').main).toEqual({ provider: 'qwen', model: 'qwen-vl-max' });
    expect(abilityLines(cfg, 'code').main).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(routeFor(cfg, 'code')).toMatchObject({ routed: true, model: 'deepseek-v4-flash' });
  });
  it('旧的备用线路仍是对话的备用', () => {
    const cfg = { ...USER, fallbackPolicy: 'explicit', fallbackModels: [{ provider: 'zhipu', model: 'glm-4.6' }] };
    expect(abilityLines(cfg, 'chat').backup).toEqual({ provider: 'zhipu', model: 'glm-4.6' });
    expect(fallbackRoutes(cfg, { provider: 'deepseek', model: 'deepseek-v4-pro' })[0]).toMatchObject({ provider: 'zhipu' });
  });
  it('选过的画图模型（当前服务商）照旧', () => {
    expect(abilityLines({ ...USER, imageModel: 'my-image' }, 'image').main).toEqual({ provider: 'deepseek', model: 'my-image' });
  });
});

describe('画图：常用出错换备用', () => {
  it('GPT 画图失败，换智谱再画一次；两个都说清楚是谁', async () => {
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push(String(url));
      if (String(url).startsWith('https://api.openai.com')) return new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
      expect(JSON.parse(init.body).model).toBe('cogview-4');
      return new Response(JSON.stringify({ data: [{ b64_json: btoa('png') }] }), { status: 200 });
    };
    const r = await generateImage(USER, { prompt: '一只猫', fetchImpl });
    expect(r.model).toBe('cogview-4');
    expect(urls).toEqual(['https://api.openai.com/v1/images/generations', 'https://open.bigmodel.cn/api/paas/v4/images/generations']);
  });
  it('都失败：报常用那家的错', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 500 });
    await expect(generateImage(USER, { prompt: '一只猫', fetchImpl })).rejects.toThrow('gpt-image-1');
  });
});

describe('记忆向量', () => {
  it('自动用智谱 embedding-3；手机 App、服务器直连，网页没有网关时不用（跨域）', async () => {
    expect(resolveEmbedding(USER, null)).toBeNull();
    expect(resolveEmbedding(USER, null, { direct: true })).toMatchObject({ id: 'zhipu', model: 'embedding-3' });
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, auth: init.headers.Authorization ?? init.headers.authorization, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] })); };
    const e = createEmbedder(USER, { direct: true, fetchImpl });
    expect(e.model).toBe('zhipu:embedding-3');
    expect(await e.embed(['你好', '再见'])).toEqual([[0.1, 0.2]]);
    expect(calls[0]).toMatchObject({ url: 'https://open.bigmodel.cn/api/paas/v4/embeddings', auth: 'Bearer zp', body: { model: 'embedding-3' } });
  });
  it('只填了硅基流动：和以前一样用 bge-m3，向量标记不变（已存的记忆向量不作废）', () => {
    const cfg = { provider: 'deepseek', models: {}, keys: { deepseek: 'k', siliconflow: 's' } };
    expect(createEmbedder(cfg, { direct: true }).model).toBe('siliconflow:BAAI/bge-m3');
  });
  it('指定了引擎或关掉的老配置照旧', () => {
    expect(resolveEmbedding({ ...USER, embedding: { engine: 'off' } }, null, { direct: true })).toBeNull();
    expect(resolveEmbedding({ ...USER, keys: { ...USER.keys, siliconflow: 's' }, embedding: { engine: 'siliconflow' } }, { keys: [] })).toMatchObject({ id: 'siliconflow' });
  });
});
