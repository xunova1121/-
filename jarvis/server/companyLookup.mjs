/** 已登录用户的表单企业直查；每个用户最多两个并发，请求结束后不保留查询或结果。 */
import { runCompanyLookup } from '../src/agent/companyQuery.js';
import { publicFetch } from './taskRunner.mjs';
import { chargeEvaluation } from './evaluationAccess.mjs';
import { currentUser } from './userScope.mjs';

export function createCompanyLookup({ getConfig, readJson, json, get = publicFetch, lookup = runCompanyLookup, watchAccess } = {}) {
  const active = new Map();
  return async (req, res) => {
    const userId = currentUser();
    if ((active.get(userId) || 0) >= 2) {
      json(res, 429, { error: '你的企业查询正在进行，请等查询结束后再试', code: 'COMPANY_QUERY_BUSY' });
      return;
    }
    active.set(userId, (active.get(userId) || 0) + 1);
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    const unwatch = watchAccess?.(req, () => controller.abort(Object.assign(new Error('当前登录授权已失效，企业查询已停止'), { code: 'COMPANY_QUERY_REVOKED', status: 401 })));
    res.once('close', cancel);
    req.once('aborted', cancel);
    try {
      const args = await readJson(req, 4096);
      const result = await lookup(await getConfig(), args, {
        get, signal: controller.signal,
        openaiSearchFetch: (url, init) => {
          init?.signal?.throwIfAborted();
          // 与任务中的自定义搜索一致；即使以后复用评测上下文，也不能漏掉两类调用。
          chargeEvaluation('model');
          chargeEvaluation('search');
          return get(url, init);
        }
      });
      if (!res.destroyed) json(res, 200, result);
    } catch (error) {
      if (res.destroyed) return;
      const code = /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : error.name === 'AbortError' ? 'ABORT_ERR' : error.status === 400 ? 'COMPANY_QUERY_INPUT' : error.status === 413 ? 'COMPANY_QUERY_BODY_LIMIT' : 'COMPANY_QUERY_FAILED';
      const controlled = ['COMPANY_QUERY_INPUT', 'COMPANY_QUERY_REVOKED', 'RETRIEVAL_BUDGET', 'EVAL_QUOTA', 'EVAL_EXPIRED', 'ABORT_ERR'].includes(code);
      const status = code === 'COMPANY_QUERY_REVOKED' ? 401 : code === 'COMPANY_QUERY_INPUT' || error.status === 400 ? 400
        : error.status === 413 ? 413 : ['RETRIEVAL_BUDGET', 'EVAL_QUOTA'].includes(code) ? 429
          : code === 'EVAL_EXPIRED' ? 403 : code === 'ABORT_ERR' ? 499 : error.name === 'TimeoutError' ? 504 : 502;
      json(res, status, {
        error: controlled ? code === 'ABORT_ERR' ? '企业查询已停止' : error.message : '企业查询未完成，请稍后重试或检查该来源配置',
        code, ...(error.kind && { kind: error.kind }),
        ...(Number.isInteger(error.status) && !controlled && { upstreamStatus: error.status })
      });
    } finally {
      const count = (active.get(userId) || 1) - 1;
      if (count) active.set(userId, count); else active.delete(userId);
      res.off('close', cancel);
      req.off('aborted', cancel);
      unwatch?.();
    }
  };
}
