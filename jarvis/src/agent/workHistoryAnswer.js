import { reviewPeriod } from './periodReview.js';
import { listWorkRecords, workQuestion } from './workLedger.js';
import { collection } from './store.js';

/** 纯历史统计直接按回执回答，既不让模型从摘要补猜，也不把统计变成一次新生成。 */
export async function answerWorkHistory(text, sessionId, { signal, onStart, now = Date.now() } = {}) {
  const kind = workQuestion(text);
  const newAction =
    /导出|保存|整理成|打包|下载|发送|删除|重命名|记住|提醒|定时/.test(text) ||
    /(?:生成|制作|创建|唱|画|做|写)(?!过|了|的|完|好).{0,6}(?:PPT|Word|Excel|一首|一张|一份|一个|一版)/i.test(text) ||
    /(?:再|然后|另外|顺便|同时|并).{0,16}(?:生成|制作|唱|写|做|画|来一)/.test(text);
  if (!kind || newAction) return null;
  if (sessionId && (await collection('sessions').get(sessionId))?.evaluationId) return null;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const period = reviewPeriod('做过' + text, now);
  if (!period && /今天|昨天|前天|本周|这周|本月|这个月|上个月|上月|上周|今年|去年|\d{4}[年/-]/.test(text)) return null;
  onStart?.();
  const format = /Excel/i.test(text) ? 'xlsx' : /PPT/i.test(text) ? 'pptx' : /Word/i.test(text) ? 'docx' : '';
  const result = await listWorkRecords({ kind: kind === 'all' ? '' : kind, format, ...(period && { from: period.from, to: period.to }), limit: 50, signal });
  const label = { song: '歌曲', image: '图片', video: '视频', diagram: '图形', document: '文档', all: '成果' }[kind];
  if (!result.total) return { text: `没有找到可核实的${label}成功生成记录，不能据此说以前没做过，也不能准确报总数。旧对话和摘要不作为完整清单。`, result };
  const lines = result.items.map(
    (record, index) =>
      `${index + 1}. ${(record.displayTitle || record.title).replace(/[\r\n]/g, ' ')}${record.files.length ? '（' + record.files[0] + '）' : ''}`
  );
  return {
    text: `${period ? period.label + '，' : ''}目前能确认至少 ${result.total} 条${label}成功生成记录，按生成ID去重：\n\n${lines.join('\n')}\n\n${result.more ? '这里只列最近50条，尚有更多记录。' : ''}旧记录可能不完整，不把这个数量说成历史全部总数。来源对话可在工作区成果管理中查看。`,
    result
  };
}
