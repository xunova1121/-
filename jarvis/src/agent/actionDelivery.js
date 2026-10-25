/** 只识别明确的媒体制作动作；讲方法、写提示词、题设和技能说明不等于要立即调用生成服务。 */
export function mediaRequirement(text = '') {
  const value = String(text).slice(-6000);
  // 明确拒绝制作时不能用收尾检查反向要求调用付费服务。
  if (/(?:不要|不用|无需|别|暂不|不必|先不).{0,8}(?:生成|制作|画|谱曲|演唱|唱)/.test(value)) return null;
  if (/^(?:解释|介绍|讨论|如何|怎么|什么|有哪些)|题设|模拟|假设|提示词|写歌词|歌词模板|制作方法|技能|PPT|Word|Excel/i.test(value)) return null;
  if (/谱曲|演唱|唱(?:一首|首)|(?:生成|制作).{0,12}(?:歌曲|音乐|音频)/.test(value)) return { kind: 'audio', tool: 'sing_song', label: '音频' };
  if (/(?:生成|制作).{0,12}视频/.test(value)) return { kind: 'video', tool: 'generate_video', label: '视频' };
  if (/画(?:一张|张|一个|个|出)|(?:生成|制作).{0,12}(?:图片|图像|示意图)/.test(value)) return { kind: 'image', tool: 'generate_image', label: '图片' };
  return null;
}

export function mediaReceipt(toolName, ok, output = '') {
  const kinds = { generate_image: 'image', sing_song: 'audio', generate_video: 'video' };
  if (!kinds[toolName]) return null;
  const text = String(output).slice(0, 8000);
  const extensions = { image: 'png|jpe?g|webp|gif', audio: 'mp3|wav|m4a|ogg', video: 'mp4|webm|mov' };
  const files = [...text.matchAll(new RegExp(`[^\\s（），。"'<>]+\\.(?:${extensions[kinds[toolName]]})\\b`, 'gi'))].slice(0, 1).map((match) => match[0].slice(0, 400));
  const completed = ok && files.length && /已生成|已经唱好|生成完成|成功生成|保存在|已保存/.test(text);
  return { kind: kinds[toolName], state: !ok ? 'failed' : completed ? 'completed' : 'pending', files: completed ? files : [] };
}

export function mediaDelivery(request, receipts) {
  const required = mediaRequirement(request);
  if (!required) return null;
  const relevant = receipts.map((receipt) => receipt.media).filter((receipt) => receipt?.kind === required.kind);
  const latest = relevant.at(-1);
  return { ...required, state: latest?.state || 'not_started', files: latest?.files || [] };
}

/** 安装拒绝后只处理当前目标，不能把旧对话里的文档任务拿来当补救。 */
export function blockedAfterDenial(request, declinedTool, toolName) {
  if (declinedTool !== 'install_skill' || !/^(?:create_document|write_long_document|write_professional_document|write_file|edit_file|edit_office_document|edit_spreadsheet)$/.test(toolName)) return '';
  const explicitlyRequested = /(?:生成|做(?:成)?|制作|写|创建|更新).{0,12}(?:PPT|Word|Excel|文档|报告|表格|文件)/i.test(request);
  return explicitlyRequested ? '' : '安装未获批准，当前目标不是制作文件；不能擅自改做旧对话的文档任务。';
}
