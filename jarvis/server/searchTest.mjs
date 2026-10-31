/** 登录后主动测试固定公开内容，最多两个并发；不回传密钥或网页正文。 */
import { testDeepseekSearch } from '../src/agent/deepseekSearch.js';
import { publicFetch } from './taskRunner.mjs';

export function createSearchTest({ getConfig, readJson, json, fetchViaGateway = publicFetch }) {
  let active = 0;
  return async (req, res) => {
    if (active >= 2) return json(res, 429, { error: '正在测试搜索，请稍后重试' });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    active++;
    try {
      const { kind } = await readJson(req, 4096);
      const result = await testDeepseekSearch(getConfig(), kind, { signal: controller.signal, fetchViaGateway });
      json(res, 200, result);
    } catch (error) {
      if (error.name === 'AbortError' || error.code === 'RETRIEVAL_BUDGET') throw error;
      const configuration = ['INVALID_SEARCH_TEST', 'DEEPSEEK_SEARCH_DISABLED', 'DEEPSEEK_SEARCH_KEY_MISSING'].includes(error.code);
      // 服务商鉴权失败不能让客户端误以为未央登录已过期。
      json(res, configuration ? 400 : error.name === 'TimeoutError' ? 504 : 502, {
        error: error.message,
        kind: error.kind,
        code: error.code,
        upstreamStatus: error.status
      });
    } finally {
      active--;
      res.off('close', cancel);
    }
  };
}
