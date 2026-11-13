/** 原生搜索与应用搜索互斥；请求生成和计时必须共用这个判断。 */
export function nativeSearchAllowed({ enabled, tools = [], allowWebSearch = true, maxWebSearches = Infinity }) {
  return Boolean(enabled && allowWebSearch && maxWebSearches >= 1 && !tools.some((tool) => tool.name === 'web_search'));
}

/** 真实适配器报告本次请求能力；旧的测试/扩展适配器保持保守兼容。 */
export function requestUsesNativeSearch(adapter, options) {
  if (typeof adapter.usesNativeSearch === 'function') return adapter.usesNativeSearch(options);
  return nativeSearchAllowed({
    ...options,
    enabled: adapter.webSearchOn !== false && !['openai', 'mock'].includes(adapter.kind)
  });
}
