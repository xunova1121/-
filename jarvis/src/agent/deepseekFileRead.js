import { documentTypes } from '../llm/deepseekSuite.js';

// 本轮用户明确附上的文件才可发送。工作区检索、逐页原文、改稿等仍走本地读取。
export function attachmentQuestion(request, path, requested = false) {
  if (!path || !documentTypes.test(path) || /(?:^|[\\/])\.\.(?:[\\/]|$)|^[/\\]/.test(path)) return '';
  const match = /\n\n\[已上传到工作区[：:]([^\]\n]+)\]\s*$/.exec(String(request || ''));
  if (!match || !match[1].split('、').includes(path)) return '';
  const question = request.slice(0, match.index).trim();
  if (!question || /请勿上传|不要上传|不上传|禁(?:止)?上传|(?:无需|不要|不用|禁止|别)联网|离线|仅在本地|只在本地|仅本地|本地处理|不要用.*DeepSeek/i.test(question)) return '';
  if (!requested && (!/总结|概括|摘要|分析|讲了什么|主要内容|解读|问答|对比|有什么|有哪些|多少|[?？]/.test(question) ||
    /(?:生成|制作|导出|修改|改写|还原|编辑|排版|翻译|原文|逐页)/.test(question))) return '';
  return question;
}
