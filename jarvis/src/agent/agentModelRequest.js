import { modelWindow } from './lookupWindow.js';
import { OutputBoundary } from '../llm/outputBoundary.js';
import { requestUsesNativeSearch } from '../llm/nativeSearch.js';

/** 管理单次请求的搜索计时与输出边界；重试和切换决策仍由主循环负责。 */
export function createModelRequest({ current, effort, signal, lookupDeadline, lookupControl, closing, retrieval, emit, onNativeSearch, onText, onRetry }) {
  let searchTimer,
    searchTimedOut = false;
  const requestCtrl = new AbortController();
  const relayAbort = () => requestCtrl.abort(signal.reason);
  signal?.addEventListener('abort', relayAbort, { once: true });
  if (signal?.aborted) relayAbort();
  const stopSearch = () => {
    searchTimedOut = true;
    retrieval.close('本轮联网检索已达到预算');
    requestCtrl.abort();
  };
  // 工具列表在run时才确定；不能只按Claude/GPT型号猜它会不会自己联网。
  let requestWindow;
  const boundary = new OutputBoundary();
  let streamed = false;
  return {
    get searchTimedOut() {
      return searchTimedOut;
    },
    clearSearchTimer() {
      clearTimeout(searchTimer);
    },
    async run(input) {
      const searchOptions = {
        tools: input.tools,
        allowWebSearch: !closing && retrieval.left > 0,
        maxWebSearches: lookupDeadline ? Math.min(2, retrieval.left) : retrieval.left
      };
      const selfSearching = requestUsesNativeSearch(current.adapter, searchOptions);
      requestWindow = modelWindow(lookupDeadline && (closing || retrieval.active || selfSearching) ? lookupControl : null, closing, requestCtrl);
      const result = await requestWindow.race(() =>
        current.adapter.stream({
          model: current.model,
          effort,
          stallTimeouts: lookupDeadline ? { first: 20_000, between: 25_000 } : { first: 45_000, between: 60_000 },
          maxTransientRetries: lookupDeadline || closing ? 0 : 1,
          maxPartialRetries: closing ? 0 : 1, // 已输出的回答允许一次续写，仍受本轮总时限约束
          system: input.system,
          messages: input.messages,
          tools: input.tools,
          // 模型自带的联网搜索在服务商那边执行、搜一次扣一次费：剩余次数在发请求前就定好，不等搜完再拦
          allowWebSearch: searchOptions.allowWebSearch,
          maxWebSearches: searchOptions.maxWebSearches,
          signal: requestCtrl.signal,
          onRetry,
          onText: (delta, meta) => {
            if (requestCtrl.signal.aborted) return;
            if (meta?.serverTool) {
              emit({ type: 'server_tool', name: meta.serverTool });
              if (/search/.test(meta.serverTool)) {
                onNativeSearch();
                if (!retrieval.begin()) stopSearch();
                else if (Number.isFinite(retrieval.remaining)) {
                  clearTimeout(searchTimer);
                  searchTimer = setTimeout(
                    stopSearch,
                    Math.max(1, Math.min(retrieval.remaining, lookupDeadline && lookupControl ? lookupControl.retrievalRemaining() : Infinity))
                  );
                }
              }
              return;
            }
            streamed = true;
            onText(boundary.push(delta));
          }
        })
      );
      if (!streamed && result.text) onText(boundary.push(result.text));
      onText(boundary.flush());
      if (result.stop === 'max_tokens' || result.stop === 'length')
        throw Object.assign(new Error('模型输出达到长度上限，回答尚未完成'), { code: 'MODEL_OUTPUT_LIMIT', kind: 'api' });
      return result;
    },
    dispose() {
      requestWindow?.dispose();
      emit({ type: 'diagnostic', phase: 'model_end' });
      clearTimeout(searchTimer);
      signal?.removeEventListener('abort', relayAbort);
    }
  };
}

