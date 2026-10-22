/**
 * 按“能力”配模型：日常对话、深度思考/写作、写代码、看图、画图、记忆向量，每项一个常用、一个备用。
 *
 *   配置   cfg.abilities = { 能力: { main: { provider, model } | null, backup: 同上 | null } }，null 表示自动
 *   自动   日常对话用当前模型；思考、写代码跟日常对话一样；看图、画图、向量按下面的能力表，从填了 Key 的服务商里挑
 *   能力表 各家会什么、推荐型号（型号更新快：拉取过模型列表的按实际列表挑，没拉取过的用推荐型号）
 *   兼容   没设过 abilities 的老配置照旧读模型分工（routing）、备用线路（fallbackModels）、画图模型（imageModel）
 */
import { providerById } from '../../shared/providers.js';
import { catalogKey } from './modelLibrary.js';
import { modelKind } from './images.js';
import { keyedProviders as keyed, seesImages } from './router.js';

export const ABILITIES = {
  chat: { name: '日常对话', hint: '闲聊、问答，选快的' },
  reason: { name: '深度思考 / 写作', hint: '分析、写文档、长文' },
  code: { name: '写代码', hint: '编程、改 bug、做网页' },
  vision: { name: '看图', hint: '发了图片、截图分析' },
  ocr: { name: '文字识别', hint: '截图、扫描件、表格照片里的字' },
  image: { name: '画图', hint: '“画一张…”' },
  embed: { name: '记忆向量', hint: '记忆按意思找，不填只按关键字' }
};
/** 模型分工的任务 → 能力（写作和深度思考合成一项） */
export const TASK_ABILITY = { chat: 'chat', code: 'code', write: 'reason', reason: 'reason', vision: 'vision' };

/**
 * 能力表：每家能做哪几项（只列对话以外要单独找模型的三项），按顺序是自动挑选的先后。
 * pick：在拉取到的模型列表里认型号；model：没拉取过列表时用的推荐型号
 */
export const CAPABILITIES = {
  vision: [
    { provider: 'zhipu', pick: /^glm-[\d.]+v/i, model: 'glm-4.5v' },
    { provider: 'qwen', pick: /qwen.*vl/i, model: 'qwen-vl-max' },
    { provider: 'doubao', pick: /seed|vision/i, model: 'doubao-seed-1-6-250615' },
    { provider: 'siliconflow', pick: /vl/i, model: 'Qwen/Qwen2.5-VL-72B-Instruct' },
    { provider: 'openai', pick: /^gpt-(4o|4\.1|[5-9])/i, model: 'gpt-4.1-mini' },
    { provider: 'gemini', pick: /gemini/i, model: 'gemini-2.5-flash' },
    { provider: 'deepseek', pick: /vision/i, model: 'deepseek-v4-flash-vision-exp' }
  ],
  image: [
    { provider: 'openai', pick: /gpt-image/i, model: 'gpt-image-1' },
    { provider: 'relay-multi', pick: /gpt-image/i },
    { provider: 'openrouter', pick: /gpt-image/i },
    { provider: 'custom', pick: /gpt-image/i },
    { provider: 'zhipu', pick: /cogview/i, model: 'cogview-4' },
    { provider: 'doubao', pick: /seedream/i, model: 'doubao-seedream-4-0-250828' },
    { provider: 'siliconflow', pick: /kolors|flux/i, model: 'Kwai-Kolors/Kolors' }
  ],
  // 文字识别：目前只接了智谱的文档解析接口（见 ocr.js）
  ocr: [{ provider: 'zhipu', pick: /ocr/i, model: 'glm-ocr' }],
  embed: [
    { provider: 'zhipu', pick: /^embedding-\d/i, model: 'embedding-3' },
    { provider: 'qwen', pick: /text-embedding/i, model: 'text-embedding-v4' },
    { provider: 'siliconflow', pick: /bge-m3/i, model: 'BAAI/bge-m3' },
    { provider: 'openai', pick: /text-embedding-3/i, model: 'text-embedding-3-small' },
    { provider: 'doubao', pick: /embedding/i, model: 'doubao-embedding-text-240715' }
  ]
};

const valid = (line) => Boolean(line && providerById(line.provider) && typeof line.model === 'string' && line.model.trim() && line.model.length <= 200);
const same = (a, b) => a?.provider === b?.provider && a?.model === b?.model;
const lineOf = (provider, model) => (provider && model ? { provider, model } : null);
const current = (cfg) => lineOf(cfg.provider, cfg.models?.[cfg.provider] || providerById(cfg.provider)?.models?.[0] || '');

/** 模型列表里这项能力该是哪类模型（看图模型也是对话模型） */
const KIND = { vision: 'chat', ocr: 'chat', image: 'image', embed: 'embed' };

/** 在拉取过的模型列表里按能力表认型号；没拉取过就用推荐型号（中转站没有推荐型号，必须拉取过） */
function pickModel(cfg, row, ability) {
  const ids = cfg.modelLists?.[catalogKey(cfg, row.provider)]?.ids || [];
  const hits = ids.filter((id) => row.pick.test(id) && modelKind(id) === KIND[ability] && (ability !== 'vision' || seesImages(id) || row.provider === 'doubao'));
  if (hits.length) return hits.sort((a, b) => version(b) - version(a) || a.length - b.length)[0];
  return row.model || '';
}
const version = (id) => Number(String(id).match(/(\d+(?:\.\d+)?)/)?.[1] || 0);

/** 自动挑：能力表里第一个填了 Key 的；except 排除常用那条（给备用用） */
export function autoLine(cfg, ability, except = null) {
  const have = keyed(cfg);
  for (const row of CAPABILITIES[ability] || []) {
    if (!have.includes(row.provider)) continue;
    const line = lineOf(row.provider, pickModel(cfg, row, ability));
    if (line && !same(line, except) && (!except || line.provider !== except.provider)) return line;
  }
  return null;
}

/** 老配置里这项能力设过什么（模型分工 / 画图模型） */
function legacyLine(cfg, ability) {
  const r = cfg.routing;
  if (ability === 'image' && cfg.imageModel) return lineOf(cfg.provider, cfg.imageModel);
  if (!r?.enabled || !(r.provider === cfg.provider || r.multi)) return null;
  const task = Object.keys(TASK_ABILITY).find((t) => TASK_ABILITY[t] === ability && r.routes?.[t]);
  const raw = String(r.routes?.[task] || '');
  const i = raw.indexOf('::');
  return i > 0 && providerById(raw.slice(0, i)) ? lineOf(raw.slice(0, i), raw.slice(i + 2).trim()) : lineOf(r.provider || cfg.provider, raw.trim());
}

/**
 * 这项能力实际用谁
 * @returns {{ main: {provider, model} | null, backup: {provider, model} | null, set: boolean }}
 *   set：用户在能力表里亲手设过常用
 */
export function abilityLines(cfg, ability) {
  const own = cfg.abilities?.[ability] || {};
  const have = keyed(cfg);
  const usable = (line) => valid(line) && have.includes(line.provider) ? { provider: line.provider, model: line.model.trim() } : null;
  const setMain = usable(own.main);
  let main = setMain;
  if (!main) {
    if (ability === 'chat') main = current(cfg);
    else if (ability === 'reason' || ability === 'code') main = usable(legacyLine(cfg, ability)) || abilityLines(cfg, 'chat').main;
    else if (ability === 'vision') main = usable(legacyLine(cfg, ability)) || (seesImages(current(cfg)?.model) ? current(cfg) : autoLine(cfg, 'vision'));
    else main = usable(legacyLine(cfg, ability)) || autoLine(cfg, ability);
  }
  let backup = usable(own.backup);
  if (same(backup, main)) backup = null;
  if (!backup && own.backup === undefined) {
    // 没设过备用：对话类沿用旧的备用线路，看图、画图、向量自动找另一家
    if (ability === 'chat') backup = usable((cfg.fallbackModels || []).find((l) => !same(l, main))) || null;
    // 思考、写代码：没设就用日常对话的备用
    else if (ability === 'reason' || ability === 'code') backup = [abilityLines(cfg, 'chat').backup, ...(cfg.fallbackModels || [])].map(usable).find((l) => l && !same(l, main)) || null;
    else if (main) backup = autoLine(cfg, ability, main);
  }
  return { main, backup, set: Boolean(setMain) };
}

/** 一条线路对应的配置（换成那家服务商、那个型号；不再套模型分工） */
export const cfgForLine = (cfg, line) => ({ ...cfg, provider: line.provider, models: { ...cfg.models, [line.provider]: line.model }, routing: { ...cfg.routing, enabled: false } });

/** 设置某项能力的常用或备用（null = 自动） */
export function setAbility(cfg, ability, slot, line) {
  if (!ABILITIES[ability] || !['main', 'backup'].includes(slot)) return cfg;
  const next = { ...(cfg.abilities?.[ability] || {}), [slot]: line && valid(line) ? { provider: line.provider, model: line.model.trim() } : null };
  return { ...cfg, abilities: { ...cfg.abilities, [ability]: next } };
}
