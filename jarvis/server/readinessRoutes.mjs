import { readinessReport } from '../shared/capabilityReadiness.js';
import { createRuntimeReadiness } from './runtimeReadiness.mjs';

/** 由外层完成鉴权；GET只读依赖，POST额外检查固定的断网代码容器。 */
export function createReadinessRoutes({ getConfig, appDir, json, runtime = createRuntimeReadiness({ appDir }) }) {
  return async function readinessRoutes(req, res) {
    if (!['GET', 'POST'].includes(req.method)) {
      json(res, 405, { error: '能力自检仅支持GET或POST' });
      return true;
    }
    const environment = await runtime.check({ probeRuntime: req.method === 'POST' });
    const report = readinessReport({ scope: 'server', cfg: await getConfig(), runtime: environment });
    json(res, 200, report);
    return true;
  };
}
