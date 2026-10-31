import { routeFor } from '../llm/router.js';
/** 只使用用户已配置的推理档，固定模型和未配置时不更换；不额外增加规划调用。 */
export function createLookupModel(cfg, makeAdapter) {
  const route = routeFor(cfg, 'reason');
  if (!route.routed) return null;
  const selected = makeAdapter(route.cfg);
  return selected.problem || !selected.adapter || !selected.model ? null : { adapter: selected.adapter, model: selected.model };
}
export function lookupPhase({ enabled, step, closing, preFound, messages, final = false }) {
  if (!enabled) return '';
  if (final || closing || preFound?.tool === 'get_today_news') return 'lookup_judgment';
  if (step === 0) return preFound ? 'lookup_judgment' : 'lookup_plan';
  const last = messages.at(-1);
  return last?.role === 'tool' && ['fetch_url', 'fetch_json'].includes(last.name) && !last.isError ? 'lookup_judgment' : '';
}
