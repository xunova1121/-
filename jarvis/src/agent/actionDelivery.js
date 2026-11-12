import { textPosterRequest, posterReceipt } from './posterRouting.js';
import { visualSceneRequest, visualSceneReceipt } from './visualSceneRouting.js';
/** 只识别明确的媒体制作动作；讲方法、写提示词、题设和技能说明不等于要立即调用生成服务。 */
export function mediaRequirement(text = '') {
  const value = String(text).slice(-6000);
  if (visualSceneRequest(value)) return { kind: 'visual_demo', tool: 'create_visual_demo', label: '高清PNG、可编辑SVG及同设计交互HTML' };
  // 明确拒绝制作时不能用收尾检查反向要求调用付费服务。
  if (/(?:不要|不用|无需|别|暂不|不必|先不).{0,8}(?:生成|制作|画|谱曲|演唱|唱)/.test(value)) return null;
  if (/^(?:解释|介绍|讨论|如何|怎么|什么|有哪些)|题设|模拟|假设|提示词|写歌词|歌词模板|制作方法|技能/i.test(value)) return null;
  if (textPosterRequest(value)) return { kind: 'poster', tool: 'make_poster', label: '海报PNG及可编辑SVG/PPTX' };
  if (/(?:画|生成|制作|做|重画).{0,20}(?:架构图|流程图|关系图|组织图|拓扑图)/.test(value)) {
    // Word/Excel仍走文档；PPT架构图与SVG共用设计稿。参考附件文件名不算输出要求。
    if (/(?:用|输出|导出|生成|制作|做成|保存为).{0,8}(?:Word|docx|Excel|xlsx)|(?:Word|docx).{0,3}(?:格式|版本)/i.test(value)) return null;
    return { kind: 'diagram', tool: 'create_diagram', label: '可编辑图形' };
  }
  if (/PPT|Word|Excel/i.test(value)) return null;
  if (/谱曲|演唱|唱(?:一首|首)|(?:生成|制作).{0,12}(?:歌曲|音乐|音频)/.test(value)) return { kind: 'audio', tool: 'sing_song', label: '音频' };
  if (/(?:生成|制作).{0,12}视频/.test(value)) return { kind: 'video', tool: 'generate_video', label: '视频' };
  if (/画(?:一张|张|一个|个|出)|(?:生成|制作).{0,12}(?:图片|图像|示意图)/.test(value)) return { kind: 'image', tool: 'generate_image', label: '图片' };
  return null;
}

export function mediaReceipt(toolName, ok, output = '') {
  if (toolName === 'create_visual_demo') return visualSceneReceipt(ok, output);
  if (toolName === 'make_poster') return posterReceipt(ok, output);
  if (toolName === 'generate_image') {
    let value;
    try { value = JSON.parse(String(output).slice(0, 16000)); } catch { value = null; }
    if (value && typeof value === 'object') {
      const path = typeof value.path === 'string' && value.path.length <= 400 && /\.(?:png|jpe?g|webp|gif)$/i.test(value.path) ? value.path : '';
      const complete = ok && value.kind === 'image' && value.status === 'saved' && value.readback === 'passed' && path;
      const dimensions = input => input && Number.isSafeInteger(input.width) && input.width > 0 && Number.isSafeInteger(input.height) && input.height > 0
        ? { width: input.width, height: input.height } : null;
      return {
        kind: 'image', state: !ok ? 'failed' : complete ? 'completed' : 'pending', files: complete ? [path] : [],
        model: typeof value.model === 'string' ? value.model.slice(0, 160) : '',
        actual: { ...dimensions(value.actual), format: String(value.actual?.format || 'unknown').slice(0, 12), dimensions: dimensions(value.actual) ? 'verified' : 'unknown' },
        requested: { size: String(value.requested?.size || '').slice(0, 30), quality: String(value.requested?.quality || '').slice(0, 12), output_format: String(value.requested?.output_format || '').slice(0, 12) },
        sizeMatch: typeof value.sizeMatch === 'boolean' ? value.sizeMatch : null,
        formatMatch: typeof value.formatMatch === 'boolean' ? value.formatMatch : null,
        visual: ['passed', 'failed'].includes(value.visual) ? value.visual : 'not_checked'
      };
    }
  }
  if (toolName === 'build_architecture') {
    let value; try { value = JSON.parse(String(output)); } catch { value = null; }
    const complete = ok && value?.status === 'complete' && Array.isArray(value.completedViews) && value.completedViews.length > 0 && value.completedViews.every(view => view.editable === true && ['svg','png','pdf','pptx'].every(format => view.files?.some(file => file.format === format && typeof file.path === 'string')));
    return {kind:'diagram',state:!ok?'failed':complete?'completed':'pending',files:complete?value.completedViews.map(view=>view.files.find(f=>f.format==='svg').path).slice(0,3):[]};
  }
  const kinds = { create_diagram: 'diagram', export_diagram: 'diagram', generate_image: 'image', sing_song: 'audio', generate_video: 'video' };
  if (!kinds[toolName]) return null;
  const text = String(output).slice(0, 8000);
  const extensions = { diagram: 'svg', image: 'png|jpe?g|webp|gif', audio: 'mp3|wav|m4a|ogg', video: 'mp4|webm|mov' };
  const files = [...text.matchAll(new RegExp(`[^\\s（），。"'<>]+\\.(?:${extensions[kinds[toolName]]})\\b`, 'gi'))].slice(0, 1).map((match) => match[0].slice(0, 400));
  const completed = ok && files.length && /已从同一设计稿导出|已生成|已经唱好|生成完成|成功生成|保存在|已保存/.test(text);
  return { kind: kinds[toolName], state: !ok ? 'failed' : completed ? 'completed' : 'pending', files: completed ? files : [] };
}

/** 文件保存成功不覆盖服务商回传的尺寸/格式不符；旧文字回执没有这些证据时不补造。 */
export function imageDeliveryAnswerIssues(text = '', media) {
  if (media?.kind !== 'image') return [];
  const verified = media.actual?.dimensions === 'verified' && [media.actual.width, media.actual.height].every(value => Number.isSafeInteger(value) && value > 0);
  const sizeUnchecked = media.sizeMatch === false || !verified;
  const claims = String(text).split(/[。！!；;，,\n]/).filter(line => !/不能|无法|尚未|未达|没有达到|没有达成|未能达到|不符|不代表|不等于|并非|不是|并不|非4K|不到4K|不足4K|不够4K|无法确认/i.test(line)
    && (!/请求|期望|目标|希望|需要|如需|想要|可以|可放大|可导出|建议/.test(line) || /已生成|已导出|已输出|已满足|已符合|已达到|已达标/.test(line)));
  const issues = [];
  const wrongDimensions = claims.some(line => [...line.matchAll(/(\d{2,5})\s*[x×*]\s*(\d{2,5})/gi)].some(match => !verified || Number(match[1]) !== media.actual.width || Number(match[2]) !== media.actual.height));
  // auto或服务商未接收尺寸参数时sizeMatch为null，仍须按收到的像素核对4K声明。
  const claimsFourK = claims.some(line => /(?:原生|原始|真正|达到|达到了|导出|生成|已经是|已是|是|为|属于|提供|交付).{0,8}4K|4K.{0,8}(?:图片|图像|成品|达标|分辨率|输出)|(?:尺寸|分辨率).{0,8}4K/i.test(line));
  const tooSmallForFourK = !verified || Math.max(media.actual.width, media.actual.height) < 3840;
  // 容器只证明像素尺寸，不能证明上游没有做过放大或确有原生细节。
  const nativeDetailClaim = claims.some(line => /(?:原生|原始|真正).{0,5}4K|4K.{0,5}(?:原生|原始)/i.test(line));
  const claimsRequestMatched = sizeUnchecked && claims.some(line => /(?:尺寸|分辨率).{0,12}(?:达标|符合|满足|匹配|达到)|(?:已按|符合|满足).{0,12}(?:尺寸|分辨率)/.test(line));
  if (wrongDimensions || claimsFourK && tooSmallForFourK || nativeDetailClaim || claimsRequestMatched) issues.push('图片声明须与actual实际像素一致；auto或未指定请求尺寸不代表4K达标，容器尺寸也不能证明底图原生4K细节');
  if (media.formatMatch === false && claims.some(line => /(?:格式).{0,12}(?:达标|符合|满足|匹配)|(?:已按|符合|满足).{0,12}格式/.test(line))) issues.push('图片回执formatMatch=false；按真实文件格式交付，不能宣称请求格式已满足');
  return issues;
}

export function mediaDelivery(request, receipts) {
  const required = mediaRequirement(request);
  if (!required) return null;
  const relevant = receipts.map((receipt) => receipt.media).filter((receipt) => receipt?.kind === required.kind);
  const latest = relevant.at(-1);
  return { ...required, ...(latest || { state: 'not_started', files: [] }) };
}

/** 安装拒绝后只处理当前目标，不能把旧对话里的文档任务拿来当补救。 */
export function blockedAfterDenial(request, declinedTool, toolName) {
  if (declinedTool !== 'install_skill' || !/^(?:create_document|write_long_document|write_professional_document|write_file|edit_file|edit_office_document|edit_spreadsheet)$/.test(toolName)) return '';
  const explicitlyRequested = /(?:生成|做(?:成)?|制作|写|创建|更新).{0,12}(?:PPT|Word|Excel|文档|报告|表格|文件)/i.test(request);
  return explicitlyRequested ? '' : '安装未获批准，当前目标不是制作文件；不能擅自改做旧对话的文档任务。';
}
