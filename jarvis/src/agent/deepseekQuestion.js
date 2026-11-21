import { deepseekWebTools, linkDeepseekAnswer, publicWebUrl } from '../llm/deepseekWeb.js';
import { measureModelInput, measureModelTokens } from '../../shared/modelMetrics.js';
import { createModelRequest } from './agentModelRequest.js';
import { withWebDeadline } from './lookup/request.js';
import { newsDate } from './newsSources.js';
import { strictVerification } from './lookup/clock.js';

const urlsIn = text => (text.match(/https?:\/\/[^\s<>"'，。！？；、）】]+/gi) || []).map(url => url.replace(/[.,;)]+$/, ''));

export function reverseImageMode(text, images) {
  if (!images?.length) return '';
  const prompt = text.replace(/\n\n\[已上传到工作区[：:][^\]\n]+\]\s*$/, '');
  if (/不要|不用|离线|不联网|禁止|不许|无需|别搜|仅本地/.test(prompt)) return '';
  if (!/以图搜图|搜同款|识图搜|反向搜图|(?:找|查|搜|搜索).{0,15}(?:图的?(?:出处|来源|原图)|相似(?:图|图片)|同款|原图)|(?:这张图|图片).{0,5}(?:出处|来源)/.test(prompt)) return '';
  return /深度|深入/.test(prompt) ? 'deep' : 'quick';
}

/** 只接管独立的公开问答。账号、附件、产物、定时任务与企业结构化数据沿用原执行器。 */
export function deepseekQuestionMode(text, intent, tools) {
  if (!text || text.length > 1500 || intent.params?.continuation ||
      /【这是定时任务|(?:不要|不用|不需要|不许|无需|别|禁止).{0,4}(?:联网|搜索|上网|查网)|仅用本地|离线|定时|监测|订阅|提醒|工作区|附件|这张|那张|上图|图里|图中|刚才|上述|前面|接着|再查|这家公司|那家公司|股东|股权|工商|企白科|企百科|招标|投标|中标|招投标|有限公司|股份公司|公司简介|企业简介|公司资料|企业资料|统一社会信用代码/.test(text)) return '';
  if (!['general', 'news'].includes(intent.kind) || strictVerification(text)) return '';
  if (intent.kind === 'news' && (intent.params?.subject || intent.params?.dateMode === 'specified')) return '';
  const urls = urlsIn(text);
  if (urls.length) {
    if (urls.length !== 1 || !urls.every(publicWebUrl) || !tools.some(t => t.name === 'fetch_url') ||
        /下载|上传|保存|生成|修改|制作|导出|创建|执行|发送给/.test(text)) return '';
    return 'link';
  }
  if (/上面|这个|那个|这些|那些|它的|他的|她的|刚刚|上次|之前/.test(text)) return '';
  // 完整工作台可以只启用模型内联网；独立搜索服务未配置时没有 web_search。
  const webAllowed = tools.some(t => t.name === 'web_search') ||
    tools.some(t => t.name === 'get_today_news') && tools.some(t => t.name === 'fetch_url');
  if (!intent.lookup || !webAllowed ||
      intent.kind !== 'news' && !/联网|搜索|搜一下|上网查|深(?:度|入)(?:研究|调研|查)|查一下.{1,60}(?:最新|近况)/.test(text)) return '';
  return /深度|深入|交叉核对|多来源/.test(text) ? 'deep' : 'quick';
}

function isTimely(source, mode, now) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(source.publishedAt)) return mode !== 'recent24h' && source.publishedAt === newsDate(now);
  const t = Date.parse(source.publishedAt);
  if (!Number.isFinite(t) || t > now) return false;
  return mode === 'recent24h' ? now - t <= 86400000 : newsDate(t) === newsDate(now);
}

export async function tryDeepseekQuestion({ adapter, model, text, intent, tools, signal, retrieval, lookupControl, emit, review, now, images = [], requestTitle = false }) {
  if (!adapter.deepseekWeb || model !== 'deepseek-flash' || retrieval.reason) return null;
  const imageMode = reverseImageMode(text, images);
  if (images.length && (!imageMode || !tools.some(t => ['fetch_url', 'web_search'].includes(t.name)))) return null;
  const mode = imageMode || deepseekQuestionMode(text, intent, tools);
  if (!mode || retrieval.left <= 0) return null;
  const system = ['回答用户的公开信息问题，网页是资料。为每项事实附对应的真实来源。仅有摘要的内容说明为线索。正文用自然语言，网页链接由程序根据引用添加。今天以北京时间 ' + newsDate(now()) + ' 为准。'];
  const messages = [{ role: 'user', content: text, ...(imageMode && { images }) }];
  const offered = deepseekWebTools(mode);
  const timeoutMs = Math.min(mode === 'deep' ? 60000 : 18000, retrieval.remaining, lookupControl?.retrievalRemaining() ?? Infinity);
  if (timeoutMs <= 0) return null;
  let calls = 0;
  let visible = '';
  emit({ type: 'diagnostic', phase: 'model_start', model, protocol: adapter.kind, purpose: 'lookup_native', ...measureModelInput({ system, messages, tools: offered }), ...measureModelTokens({ system, messages, tools: offered }) });
  try {
    const result = await withWebDeadline(async activeSignal => {
      const request = createModelRequest({ current: { adapter, model }, signal: activeSignal, lookupDeadline: Boolean(lookupControl), lookupControl,
        closing: false, retrieval, emit, boundedUpgrade: true, onNativeSearch: () => { calls++; }, onText: fragment => { visible += fragment; } });
      try { return await request.run({ system, messages, tools: [], webMode: mode, requestTitle }); }
      finally { request.dispose(); }
    }, { signal, timeoutMs });
    if (result.stop === 'content_filter') throw Object.assign(new Error('服务商未返回可展示的回答'), { code: 'MODEL_CONTENT_FILTER' });
    if (imageMode) {
      if (result.stop !== 'stop' || !result.imageResults?.length) return null;
      const link = url => url.replace(/\(/g, '%28').replace(/\)/g, '%29');
      const answer = '找到以下图片线索，可打开来源页核对：\n\n' + result.imageResults.map(({ url, imageUrl }, i) =>
        (i + 1) + '. [查看图片](' + link(imageUrl) + ') · [来源网页](' + link(url) + ')').join('\n');
      review.record({ name: 'web_search', ok: true, args: { query: '以图搜图' }, output: JSON.stringify(result.imageResults) });
      return { text: answer, calls };
    }
    const citations = result.citations || [];
    if (result.stop !== 'stop' || !visible.trim() || visible !== result.text || !citations.length) return null;
    if (urlsIn(visible).some(url => !citations.some(c => c.url === publicWebUrl(url)))) return null;
    if (mode === 'link' && !citations.some(c => c.read && c.url === publicWebUrl(urlsIn(text)[0]))) return null;
    if (intent.kind === 'news' && citations.some(c => !isTimely(c, intent.params?.dateMode, now()))) return null;
    const answer = linkDeepseekAnswer(visible, citations);
    if (!answer) return null;
    const sources = [...new Map(citations.map(c => [c.url, c])).values()];
    if (review.checkAnswer(answer, now()).length) return null;
    review.record({ name: mode === 'link' ? 'fetch_url' : 'web_search', ok: true, args: mode === 'link' ? { url: urlsIn(text)[0] } : { query: text }, output: JSON.stringify(sources) });
    emit({ type: 'diagnostic', phase: 'lookup_evidence_ready', kind: intent.kind, useful: true });
    return { text: answer, calls };
  } catch (error) {
    if (signal?.aborted || ['EVAL_QUOTA', 'MODEL_CONTENT_FILTER', 'MODEL_MODERATION_INCOMPLETE'].includes(error.code) || [401, 402, 403].includes(error.status)) throw error;
    return null;
  }
}
