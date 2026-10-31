import { LINK_MARKER } from './pageLinks.js';
import { concreteSourceRequirement, channelKinds } from './answerRequirements.js';

export function enoughPageContent(content, request) {
  const body = String(content).split(LINK_MARKER)[0];
  return body.replace(/\s+/g, '').length >= 300 || concreteSourceRequirement(request) === 'channel' && channelKinds(body).length > 0;
}

/** 同一问题最多并发三个备选来源，取得足够正文即取消其余；预算/用户停止仍立即上抛。 */
export function readPageCandidates(addresses, { read, signal, accept = () => true }) {
  const urls = [...new Set(addresses)].slice(0, 3);
  if (!urls.length) return Promise.resolve(null);
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let remaining = urls.length, settled = false;
    const errors = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', stop);
      controller.abort(Object.assign(new Error('候选读取已结束'), { name: 'AbortError' }));
      error ? reject(error) : resolve(value);
    };
    const stop = () => finish(signal.reason ?? Object.assign(new Error('已停止'), { name: 'AbortError' }));
    if (signal?.aborted) { stop(); return; }
    signal?.addEventListener('abort', stop, { once: true });
    for (const url of urls) Promise.resolve().then(async () => {
      if (settled) return;
      const text = await read(url, controller.signal);
      if (!settled && accept(text)) finish(null, { url, text });
    }).catch(error => {
      if (settled) return;
      if (error.name === 'AbortError' || ['RETRIEVAL_BUDGET', 'PRIVATE_NETWORK_BLOCKED'].includes(error.code)) finish(error);
      else errors.push(error);
    }).finally(() => {
      if (!settled && --remaining === 0) finish(errors.length === urls.length ? new AggregateError(errors, errors.map(e => e.message).join('；')) : null, null);
    });
  });
}
