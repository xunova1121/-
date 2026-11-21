import { routeFor } from './router.js';
import { TASK_ABILITY } from './abilities.js';

/** 只用用户明确设置的能力线路，绝不从模型库按名字挑昂贵型号；不发请求。 */
export function capabilityUpgradeRoutes(cfg, makeAdapter, current = {}) {
  if (cfg.pinModel || cfg.capabilityUpgrade === false) return [];
  const routes = [];
  for (const task of ['code', 'reason']) {
    const explicit = cfg.abilities?.[TASK_ABILITY[task]]?.main || cfg.routing?.enabled && cfg.routing.routes?.[task];
    if (!explicit) continue;
    const route = routeFor(cfg, task);
    if (route.cfg.provider === current.provider && route.model === current.model) continue;
    const selected = makeAdapter(route.cfg);
    if (selected.problem || !selected.adapter || !selected.model) continue;
    routes.push({ task, provider: route.cfg.provider, model: selected.model, adapter: selected.adapter });
  }
  return routes;
}
