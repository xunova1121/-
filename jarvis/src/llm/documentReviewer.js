/** 文档审查独立于聊天路由；只使用用户明确选择的线路，不自动挑选付费模型。 */
import { keyedProviders } from './router.js';
import { lineValid } from './modelLibrary.js';

export function createDocumentReviewer(cfg, makeHelper) {
  const line = cfg.documentReviewer;
  if (!line) return null;
  // 延迟到真正审查时报告配置问题，避免阻断闲聊和其他工具。
  const unavailable = () => {
    throw Object.assign(new Error('文档审查模型不可用，请检查该运行位置的服务商地址、密钥及型号'), {
      kind: 'api', code: 'DOCUMENT_REVIEWER_UNAVAILABLE'
    });
  };
  if (!lineValid(line) || !keyedProviders(cfg).includes(line.provider)) return unavailable;
  const selected = { ...cfg, provider: line.provider, models: { ...cfg.models, [line.provider]: line.model } };
  const helper = makeHelper(selected);
  return helper || unavailable;
}
