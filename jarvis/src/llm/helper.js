/** 前后端共用辅助调用，显式传递搜索和重试限制，不能在工具内部偷偷联网。 */
export function createHelperLlm(adapter, model) {
  return async ({ system, prompt: inputText, signal, images, allowWebSearch, maxWebSearches, maxTransientRetries, maxPartialRetries }) => {
    let text = '';
    const result = await adapter.stream({
      model,
      system: [system],
      messages: [{ role: 'user', content: inputText, ...(images?.length && { images }) }],
      tools: [], signal, allowWebSearch, maxWebSearches, maxTransientRetries, maxPartialRetries,
      onText: delta => { text += delta; }
    });
    return result?.text || text;
  };
}
