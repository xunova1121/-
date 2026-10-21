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
  return { provider: cfg.provider, models: { ...cfg.models }, keys, baseURLs: { ...cfg.baseURLs }, providerNames: { ...cfg.providerNames }, imageModel: cfg.imageModel || '', videoModel: cfg.videoModel || '', documentReviewer: lineValid(cfg.documentReviewer) ? { ...cfg.documentReviewer } : null, favoriteModels: favoriteLines(cfg), fallbackModels: uniqueLines(cfg.fallbackModels || []).slice(0, MAX_BACKUPS), fallbackPolicy: cfg.fallbackPolicy || 'legacy', routing: { ...cfg.routing, enabled: Boolean(cfg.routing?.enabled), routes: { ...cfg.routing?.routes } } };
}
