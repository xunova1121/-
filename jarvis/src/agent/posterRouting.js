/** 图片明确要求排字、海报/封面标题走现有工具；无字素材、Office正文和架构图保留原路由。 */
export function textPosterRequest(text = '') {
  const value = String(text).slice(-6000);
  const poster = /海报|封面/.test(value);
  const imageText = /图片|宣传图|活动图|配图|图像/.test(value) && /写上|印上|(?:加|放|叠)上.{0,12}(?:标题|文字|中文|文案|字)|(?:上面|图中|图上).{0,8}(?:写|加|放)|(?:黑体|宋体|楷体).{0,3}字/.test(value);
  if (!poster && !imageText) return false;
  if (/^(?:解释|介绍|讨论|如何|怎么|什么|有哪些)|提示词|制作方法/.test(value.trim())) return false;
  if (/(?:不要|不用|无需|别|暂不|不必|先不).{0,8}(?:生成|制作|设计|画)/.test(value)) return false;
  if (/架构图|流程图|关系图|组织图|拓扑图/.test(value)) return false;
  if (/(?:开发|实现|编写|提供|交付|写一段).{0,12}(?:代码|程序|脚本|应用)|(?:只给|只要)(?:代码|脚本)/.test(value)) return false;
  if (/(?:图像模型|图片模型|生图模型|generate_image).{0,12}直接.{0,8}(?:画字|写字|画带字|生成文字)/i.test(value)) return false;
  if (/(?:Word|docx|Excel|xlsx|文档|报告).{0,6}封面|(?:Word|docx|Excel|xlsx).{0,12}(?:海报|告示)|(?:海报|封面).{0,12}(?:Word|docx|Excel|xlsx)/i.test(value)) return false;
  if (!/海报|(?:PPT|幻灯片)[的 ]*封面/i.test(value) && /(?:做|制作|生成).{0,8}(?:PPT|演示文稿|幻灯片)/i.test(value)) return false;
  const addingText = /(?:再|然后|最后).{0,12}(?:排|加|放|写).{0,10}(?:字|文案|标题)/.test(value);
  if (!addingText && /(?:无字|不带字|不含文字|没有文字|不要(?:任何)?文字)|(?:只要|只做|只画|仅生成).{0,8}(?:底图|背景)/.test(value)) return false;
  return /(?:画|生成|制作|设计|做|重画|修改|改成|来)[^。！？\n]{0,40}(?:海报|封面)|(?:海报|封面)[^。！？\n]{0,40}(?:加上|写上|改成|排版|换字|改字)/.test(value)
    || imageText && /(?:画|生成|制作|设计|做|重画|修改|改成)[^。！？\n]{0,40}(?:图片|宣传图|活动图|配图|图像)|(?:图片|宣传图|活动图|配图|图像)[^。！？\n]{0,30}(?:写上|加上|叠上|换字|改字)/.test(value);
}

export const POSTER_TOOLS = ['generate_image', 'make_poster', 'process_image', 'inspect_image', 'read_image_text', 'read_file', 'list_files', 'find_files', 'preview', 'update_plan'];

export const POSTER_GUIDANCE = '图片明确要求写上中文、使用黑体字，或海报/封面的标题、活动文案、日期和联系方式需要准确排字时：优先复用用户已有底图并把真实路径交给make_poster的background_path；没有合适底图时，先generate_image生成“不要任何文字”的底图并留出文字空间，再make_poster程序排字。改字时把上次回执designPath传给make_poster.source_path，只传要改的文字，保留原尺寸和无字底图，不把最终带字PNG当作新底图。保留用户原文，文案较多时分清标题、要点与页脚，不擅自删字。交付最终PNG、自包含可编辑SVG和PPTX，不能只交PPTX让用户自行导出，也不要改走sandbox、run_python、手写HTML截图或render_diagram。只有用户明确要无字素材或图像模型直接画字时才采用相应图片路线。按make_poster真实回执区分已生成、读回、字体检查和视觉检查；生成成功不等于视觉验收，不承诺绝对无错字。局部失败保留已有文件并说明缺失格式/阶段，不反复重画底图。';

/** 仅收实际工具返回的三格式回执，不凭“已生成”或文件名认定海报完成。 */
export function posterReceipt(ok, output = '') {
  let value;
  try { value = JSON.parse(String(output).slice(0, 24000)); } catch { value = null; }
  const checked = state => ['passed', 'failed'].includes(state) ? state : 'not_checked';
  const outputs = value?.kind === 'poster' && Array.isArray(value.files) ? value.files.slice(0, 3).filter(file =>
    ['png', 'svg', 'pptx'].includes(file?.format) && typeof file.path === 'string' && file.path.length > 0 && file.path.length <= 400 && file.path.toLowerCase().endsWith('.' + file.format)
  ).map(file => ({ format: file.format, path: file.path, readback: checked(file.readback), structure: checked(file.structure), render: checked(file.render) })) : [];
  const usable = ok ? outputs.filter(file => file.readback === 'passed' && file.structure === 'passed') : [];
  const dimensions = Number.isSafeInteger(value?.width) && value.width > 0 && Number.isSafeInteger(value?.height) && value.height > 0;
  const errors = Array.isArray(value?.errors) ? value.errors.length : 0;
  const complete = ok && value?.status === 'complete' && value.textRendering === 'program' && value.fontCheck === 'passed' && dimensions && !errors && ['png', 'svg', 'pptx'].every(format => usable.some(file => file.format === format && (format !== 'png' || file.render === 'passed')));
  const designPath = ok && typeof value?.designPath === 'string' && value.designPath.length <= 400 && /\.poster\.json$/i.test(value.designPath) ? value.designPath : undefined;
  return { kind: 'poster', ...(designPath && { designPath }), state: !ok ? 'failed' : complete ? 'completed' : usable.length ? 'partial' : 'pending', files: usable.map(file => file.path), outputs: ok ? outputs : [], ...(dimensions && { width: value.width, height: value.height }), visual: checked(value?.visual), fontCheck: checked(value?.fontCheck), errors, errorCodes: Array.isArray(value?.errors) ? value.errors.slice(0, 3).map(error => String(error?.code || '').slice(0, 80)) : [] };
}

/** 文件已生成与视觉已验收是两件事；这条只守海报交付措辞，不改通用事实核查。 */
export function posterAnswerIssues(text = '', media) {
  if (media?.kind !== 'poster') return [];
  const claims = String(text).split(/[。！!；;，,\n]/).filter(line => !/不能|无法|尚未|未通过|未完成|不代表|不等于|不保证/.test(line));
  const issues = [];
  if (claims.some(line => /(?:保证|确保|绝对|完全|100%|百分之百).{0,18}(?:错字|错别字|乱码|正确|准确)|(?:零错字|完全无错字|文字全部正确)/.test(line))) issues.push('程序排字不等于文字内容绝对正确；删除保证无错字/绝对准确的承诺，按真实文字与字体检查回执说明');
  if (media.visual !== 'passed' && claims.some(line => /通过.{0,6}(?:视觉|看图).{0,8}(?:验收|核验|检查)|完成.{0,6}视觉验收|视觉(?:验收|检查)(?:已)?通过/.test(line))) issues.push('海报没有对应成品的视觉通过回执，不能把生成/读回成功称为视觉验收通过；如实说明视觉未验收');
  return issues;
}
