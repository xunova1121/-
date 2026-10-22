import { modelWindow } from './lookupWindow.js';
import { OutputBoundary } from '../llm/outputBoundary.js';

/** 管理单次请求的搜索计时与输出边界；重试和切换决策仍由主循环负责。 */
export function createModelRequest({ current, effort, signal, lookupDeadline, lookupControl, closing, retrieval, emit, onNativeSearch, onText, onRetry }) {
  let searchTimer,
    searchTimedOut = false;
  const requestCtrl = new AbortController();
  const relayAbort = () => requestCtrl.abort(signal.reason);
  signal?.addEventListener('abort', relayAbort, { once: true });
  const stopSearch = () => {
    searchTimedOut = true;
    retrieval.close('本轮联网检索已达到预算');
    requestCtrl.abort();
  };
  // “查资料时间到了”什么时候打断模型：
  //   - 已经在查资料、正在收尾，或模型会自己联网（Claude、GPT Responses：卡在搜索里看不到进度）：照旧到点打断
  //   - 不会自己联网的接口（DeepSeek 官方等 Chat Completions）还没查资料：它只是在思考，只受整轮总时限约束，
  //     否则会思考的模型想得久一点就被打断，最后什么都没写出来
  const selfSearching = !['openai', 'mock'].includes(current.adapter?.kind);
  const requestWindow = modelWindow(lookupDeadline && (closing || retrieval.active || selfSearching) ? lookupControl : null, closing, requestCtrl);
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
          allowWebSearch: !closing && retrieval.left > 0,
          maxWebSearches: lookupDeadline ? Math.min(2, retrieval.left) : retrieval.left,
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
      requestWindow.dispose();
      emit({ type: 'diagnostic', phase: 'model_end' });
      clearTimeout(searchTimer);
      signal?.removeEventListener('abort', relayAbort);
    }
  };
}
