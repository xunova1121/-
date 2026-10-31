/** 兼容旧调用；计时与资源账本统一在lookup/clock，HTTP单请求上限独立保留。 */
export { createRetrievalBudget, QUICK_RETRIEVAL_MS, DEEP_RETRIEVAL_MS, VERIFICATION_MS, strictVerification, extensiveRetrieval } from './lookup/clock.js';
export { withWebDeadline } from './lookup/request.js';
