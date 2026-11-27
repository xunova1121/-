import { isPrivateHost } from '../../shared/providers.js';

export const deepseekFlash = /^(?:deepseek-ai\/)?deepseek-(?:flash|v4(?:\.1)?-flash(?:-1017|-vision-exp)?)$/i;

/** 官方返回的引用和用户要求读取的地址共用校验。带登录信息的地址不交给网页工具。 */
export function publicWebUrl(raw) {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 2000 ||
        !url.hostname.includes('.') || isPrivateHost(url.hostname.replace(/\.$/, '')) ||
        /\.(?:internal|localhost|local)\.?$/i.test(url.hostname) ||
        [...url.searchParams.keys()].some(key => /^(?:access_token|token|sig|signature|key|api_key|x-amz-.+)$/i.test(key))) return '';
    return url.href;
  } catch { return ''; }
}

export function deepseekWebTools(mode) {
  return [{ type: mode === 'link' ? 'deepseek_read_url' : 'deepseek_web_search' }];
}

/** 只保留本轮成功调用的公开来源；不保存签名、思考过程或抓取正文。 */
export function deepseekWebEvidence(onText) {
  const images = new Map();
  const seen = new Set();
  const sources = new Map();
  let citations = [];
  function note(call) {
    if (!call?.id || !['deepseek_web_search', 'deepseek_read_url'].includes(call.type)) return;
    if (!seen.has(call.id)) {
      seen.add(call.id);
      onText?.('', { serverTool: call.action?.type === 'search' ? 'web_search' : 'fetch_url' });
    }
    if (call.status !== 'completed') return;
    for (const source of [call.page, ...(Array.isArray(call.sources) ? call.sources : [])]) {
      const url = publicWebUrl(source?.url);
      if (!url || (!sources.has(url) && sources.size >= 80)) continue;
      const imageUrl = publicWebUrl(source?.image_url);
      if (imageUrl && ['image_search', 'deep_image_search'].includes(call.kind) && images.size < 12 && !images.has(imageUrl)) images.set(imageUrl, { url, imageUrl });
      const old = sources.get(url);
      sources.set(url, { url, title: String(source.title || old?.title || new URL(url).hostname).slice(0, 160),
        publishedAt: source.published_at || old?.publishedAt, read: Boolean(old?.read || source === call.page) });
    }
  }
  return {
    push(choice) {
      const event = choice?.server_tool_event;
      if (event?.type === 'call_started' || event?.type === 'call_completed') note(event.call);
      const delta = choice?.delta ?? choice?.message;
      for (const step of delta?.server_tool_calls || []) for (const call of step.calls || []) note(call);
      if (Array.isArray(delta?.annotations)) citations = delta.annotations;
    },
    imageResults: () => [...images.values()],
    result(text) {
      const length = Array.from(text).length;
      return citations.slice(0, 160).filter(a => a.type === 'url_citation').map(a => {
        const c = a.url_citation;
        if (!c || !Number.isInteger(c.start_index) || !Number.isInteger(c.end_index) || c.start_index < 0 || c.end_index <= c.start_index || c.end_index > length) return null;
        const source = sources.get(publicWebUrl(c.url));
        return source && { ...source, start: c.start_index, end: c.end_index };
      }).filter(Boolean);
    }
  };
}

/** 官方引用偏移按 Unicode 码点计数，中文和 emoji 都必须按同一坐标插入链接。 */
export function linkDeepseekAnswer(text, citations) {
  const chars = Array.from(text);
  const refs = new Map();
  const marks = new Map();
  for (const item of citations) {
    if (!Number.isInteger(item.start) || !Number.isInteger(item.end) || item.start < 0 || item.end <= item.start || item.end > chars.length) continue;
    if (!refs.has(item.url) && refs.size >= 24) continue;
    if (!refs.has(item.url)) refs.set(item.url, refs.size + 1);
    const href = item.url.replace(/\(/g, '%28').replace(/\)/g, '%29');
    const mark = '[' + refs.get(item.url) + '](' + href + ')';
    if (!marks.has(item.end)) marks.set(item.end, new Set());
    marks.get(item.end).add(mark);
  }
  for (const [end, links] of marks) chars[end - 1] += ' ' + [...links].join(' ');
  return refs.size ? chars.join('') : '';
}
