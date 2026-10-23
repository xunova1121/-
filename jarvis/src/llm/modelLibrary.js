/** 模型库只保存短型号和线路身份：每家最多1000个型号、常用24条、备用2条。 */
import { PROVIDERS, providerById } from '../../shared/providers.js';

export const MAX_MODELS = 1000;
export const MAX_FAVORITES = 24;
export const MAX_BACKUPS = 2;
export const catalogKey = (cfg, provider = cfg.provider) => `${provider}|${providerById(provider)?.custom ? cfg.baseURLs?.[provider] || '' : ''}`;
export const providerLabel = (cfg, provider) => cfg.providerNames?.[provider] || providerById(provider)?.name || provider;
export const sameLine = (a, b) => a?.provider === b?.provider && a?.model === b?.model;
export const currentLine = (cfg) => ({ provider: cfg.provider, model: cfg.models?.[cfg.provider] || providerById(cfg.provider)?.models[0] || '' });
export const hasRouting = (cfg) => Boolean(cfg.routing?.enabled && (cfg.routing.provider === cfg.provider || cfg.routing.multi));
export const lineValid = (line) => Boolean(providerById(line?.provider) && typeof line?.model === 'string' && line.model.trim() && line.model.length <= 200);

export function boundedIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.trim() && id.length <= 200))].slice(0, MAX_MODELS);
}

export function configuredProviders(cfg, gatewayKeys = []) {
  return PROVIDERS.filter((p) => p.kind !== 'mock' && (p.id === cfg.provider || cfg.keys?.[p.id] || gatewayKeys.includes(p.id) || cfg.providerNames?.[p.id] || cfg.baseURLs?.[p.id]));
}

export function favoriteLines(cfg) {
  const lines = Array.isArray(cfg.favoriteModels) ? cfg.favoriteModels : [];
  // 升级不替用户挑模型；已有默认型号仍可见，其他型号需要主动收藏。
  return uniqueLines([currentLine(cfg), ...lines]).slice(0, MAX_FAVORITES);
}

function uniqueLines(lines) {
  const out = [];
  for (const line of lines) {
    if (lineValid(line) && !out.some((item) => sameLine(item, line))) out.push({ provider: line.provider, model: line.model });
  }
  return out;
}

export function toggleFavorite(cfg, line) {
  if (!lineValid(line)) return cfg;
  const exists = favoriteLines(cfg).some((item) => sameLine(item, line));
  const next = exists ? favoriteLines(cfg).filter((item) => !sameLine(item, line)) : [...favoriteLines(cfg), line];
  return { ...cfg, favoriteModels: uniqueLines(next).slice(0, MAX_FAVORITES) };
}

export function chooseLine(cfg, line) {
  if (!lineValid(line)) throw Object.assign(new Error('请选择有效的服务商和模型'), { code: 'INVALID_MODEL_LINE', kind: 'api' });
  return { ...cfg, provider: line.provider, models: { ...cfg.models, [line.provider]: line.model }, favoriteModels: uniqueLines([line, ...favoriteLines(cfg)]).slice(0, MAX_FAVORITES), fallbackModels: (cfg.fallbackModels || []).filter((item) => !sameLine(item, line)).slice(0, MAX_BACKUPS), routing: { ...cfg.routing, enabled: false } };
}

export function toggleBackup(cfg, line) {
  const lines = uniqueLines(cfg.fallbackModels || []);
  const exists = lines.some((item) => sameLine(item, line));
  if (!exists && lines.length >= MAX_BACKUPS) throw Object.assign(new Error('最多两条备用线路，请先移除一条'), { code: 'BACKUP_LIMIT', kind: 'api' });
  const next = exists ? lines.filter((item) => !sameLine(item, line)) : [...lines, line];
  return { ...cfg, favoriteModels: uniqueLines([...favoriteLines(cfg), line]).slice(0, MAX_FAVORITES), fallbackModels: uniqueLines(next).slice(0, MAX_BACKUPS), fallbackPolicy: 'explicit' };
}

/**
 * 删掉一个型号：从模型列表、常用、备用里去掉；能力表里用到它的那一格改回“自动”。正在用的默认型号不能删
 * （拉取来的型号下次“拉取模型”还会回来；手动添加的删了就没了）
 */
export function removeModel(cfg, line) {
  if (!lineValid(line)) return cfg;
  if (sameLine(currentLine(cfg), line)) throw Object.assign(new Error('这是正在用的默认型号，先换一个默认再删'), { code: 'MODEL_IN_USE', kind: 'api' });
  const key = catalogKey(cfg, line.provider);
  const list = cfg.modelLists?.[key];
  const abilities = Object.fromEntries(
    Object.entries(cfg.abilities || {}).map(([ability, slots]) => [
      ability,
      Object.fromEntries(Object.entries(slots || {}).filter(([, value]) => !sameLine(value, line)))
    ])
  );
  return {
    ...cfg,
    ...(list && { modelLists: { ...cfg.modelLists, [key]: { ...list, ids: (list.ids || []).filter((id) => id !== line.model) } } }),
    favoriteModels: (cfg.favoriteModels || []).filter((item) => !sameLine(item, line)),
    fallbackModels: (cfg.fallbackModels || []).filter((item) => !sameLine(item, line)),
    abilities
  };
}

/**
 * 告诉模型“你现在用的是哪个模型、模型库里还有哪些”（每轮放进系统提示）：
 * 用户问“你用的什么模型”能直接答，也不会拿网上查不到去否认用户配置里的型号
 */
export function modelNote(cfg, line) {
  if (!lineValid(line)) return '';
  const name = (l) => `${providerLabel(cfg, l.provider)} · ${l.model}`;
  const others = favoriteLines(cfg).filter((l) => !sameLine(l, line)).slice(0, 10).map(name);
  return `## 你在用的模型\n这一轮由「${name(line)}」回答${others.length ? `；模型库里还配了：${others.join('、')}` : ''}。用户问你用的什么模型就照实说。这些是配置里的服务商和型号名：底层是谁家的模型、参数多少，不知道就说不知道；不要拿网上查不到来否认配置里有的型号。`;
}

/** 每家服务商单独存的字段（删服务商时一起清掉） */
const PROVIDER_MAPS = ['keys', 'models', 'baseURLs', 'providerNames', 'serviceTiers'];

/**
 * 删掉一家服务商：Key、地址、名字、型号列表，以及常用、备用、能力表、审查里用到它的。
 * 正在用的默认服务商不能删。removedProviders 交给服务器合并配置时照着删（服务器按字典合并，不会自己少掉）
 */
export function removeProvider(cfg, provider) {
  if (provider === cfg.provider) throw Object.assign(new Error('这是正在用的默认服务商，先把默认模型换成别家再删'), { code: 'PROVIDER_IN_USE', kind: 'api' });
  const drop = (map) => Object.fromEntries(Object.entries(map || {}).filter(([id]) => id !== provider));
  const mine = (line) => line?.provider === provider;
  const abilities = Object.fromEntries(
    Object.entries(cfg.abilities || {}).map(([ability, slots]) => [ability, Object.fromEntries(Object.entries(slots || {}).filter(([, value]) => !mine(value)))])
  );
  return {
    ...cfg,
    ...Object.fromEntries(PROVIDER_MAPS.map((field) => [field, drop(cfg[field])])),
    modelLists: Object.fromEntries(Object.entries(cfg.modelLists || {}).filter(([key]) => !key.startsWith(`${provider}|`))),
    favoriteModels: (cfg.favoriteModels || []).filter((line) => !mine(line)),
    fallbackModels: (cfg.fallbackModels || []).filter((line) => !mine(line)),
    abilities,
    ...(mine(cfg.documentReviewer) && { documentReviewer: null }),
    removedProviders: [...new Set([...(cfg.removedProviders || []), provider])]
  };
}

/** 服务器合并配置时：把前端删掉的服务商真正删掉，再去掉标记 */
export function applyRemovedProviders(merged, removed = [], next = {}) {
  // 这次又填了 Key / 名字 / 地址的，是删了又加回来的：不删
  const readded = (id) => ['keys', 'providerNames', 'baseURLs'].some((field) => next[field]?.[id]);
  const ids = (Array.isArray(removed) ? removed : []).filter((id) => typeof id === 'string' && id !== merged.provider && !readded(id));
  if (!ids.length) {
    delete merged.removedProviders;
    return merged;
  }
  for (const field of PROVIDER_MAPS) if (merged[field]) merged[field] = Object.fromEntries(Object.entries(merged[field]).filter(([id]) => !ids.includes(id)));
  merged.modelLists = Object.fromEntries(Object.entries(merged.modelLists || {}).filter(([key]) => !ids.some((id) => key.startsWith(`${id}|`))));
  delete merged.removedProviders;
  return merged;
}

export function boundedCatalogs(cfg) {
  // 只保留当前各服务商地址的缓存；换地址不无限累积旧列表。
  const allowed = new Set(PROVIDERS.map((p) => catalogKey(cfg, p.id)));
  return Object.fromEntries(Object.entries(cfg.modelLists || {})
    .filter(([item]) => allowed.has(item))
    .map(([item, value]) => [item, { ids: boundedIds(value?.ids), at: value?.at }]));
}

export function saveCatalog(cfg, provider, ids) {
  const key = catalogKey(cfg, provider);
  const lists = boundedCatalogs(cfg);
  lists[key] = { ids: boundedIds(ids), at: Date.now() };
  return { ...cfg, modelLists: lists };
}

export function copyModelSettings(cfg) {
  // 不复制本机声音、搜索密钥等无关设置，也不把服务端掩码当作可用密钥。
  const keys = Object.fromEntries(Object.entries(cfg.keys || {}).filter(([, value]) => value && !String(value).startsWith('••••')));
  return { provider: cfg.provider, models: { ...cfg.models }, keys, baseURLs: { ...cfg.baseURLs }, providerNames: { ...cfg.providerNames }, imageModel: cfg.imageModel || '', videoModel: cfg.videoModel || '', documentReviewer: lineValid(cfg.documentReviewer) ? { ...cfg.documentReviewer } : null, favoriteModels: favoriteLines(cfg), fallbackModels: uniqueLines(cfg.fallbackModels || []).slice(0, MAX_BACKUPS), fallbackPolicy: cfg.fallbackPolicy || 'legacy', abilities: structuredClone(cfg.abilities || {}), pinModel: Boolean(cfg.pinModel), serviceTiers: { ...cfg.serviceTiers }, routing: { ...cfg.routing, enabled: Boolean(cfg.routing?.enabled), routes: { ...cfg.routing?.routes } } };
}
