import { visualSceneRequest } from './visualSceneRouting.js';
/** 图片明确要求排字、海报/封面标题走现有工具；无字素材、Office正文和架构图保留原路由。 */
const POSTER_KINDS = '海报|封面|宣传单|传单|易拉宝|展架|横幅|条幅|展板|请柬|请帖|贺卡|明信片|头图|题图|首图|桌牌|台卡';
const POSTER_KIND = new RegExp(POSTER_KINDS);
export function canvasTextRequest(text = '') {
  const value = String(text).slice(-6000).trim();
  // “不用SVG”是选渲染方式；“不用填字”才是拒绝制作。讲原理或问模型费用不能触发付费流程。
  const action = value.replace(/(?:不用|不要|无需|不必|不需要)\s*SVG/gi, '');
  if (/^(?:请\s*)?(?:解释|介绍|讨论|如何|怎么|什么|有哪些)|提示词|制作方法|(?:只给|只要)(?:代码|脚本)|(?:开发|编写).{0,10}(?:功能|代码|程序)/.test(value) || /(?:不要|不用|无需|不必|不需要|暂不|先不|别).{0,8}(?:填字|填入|加字|制作|生成)/.test(action) || directModelTextRequest(value)) return false;
  if (!/请|帮我|给我|把|将|制作|生成/.test(action) && /怎么|如何|为什么|原理|区别|可行吗|需要.{0,12}(?:模型|费用)|需不需要|要不要/.test(action)) return false;
  return /(?:底图|原图|图片|卡槽).{0,16}(?:填字|填入.{0,8}(?:文字|文案|标题)|直接.{0,5}(?:写字|加字|放文字))|(?:文字|文案|标题).{0,10}(?:填进|填入|放进).{0,12}(?:底图|原图|卡槽)/.test(value)
    || /\.canvas\.json/i.test(value) && /改|补|导出|做|生成/.test(value)
    || /(?:不用|不要)\s*SVG/i.test(value) && /海报|底图/.test(value) && /加字|填字|放文字|排字|加.{0,3}中文/.test(value);
}
export function directModelTextRequest(value = '') {
  return /(?:图像模型|图片模型|生图模型|generate_image).{0,12}直接.{0,8}(?:画字|写字|画带字|生成文字)/i.test(value)
    || /(?:GPT(?:[ -]?(?:Image|图片|画图))?(?:[ -]?[\d.]+)?|gpt-image-[\w.-]+).{0,8}直接.{0,10}(?:画字|写字|画带字|生成文字|画整张带字|生成整张带字)/i.test(value);
}
export function textPosterRequest(text = '') {
  const value = String(text).slice(-6000);
  if (visualSceneRequest(value)) return false;
  if (canvasTextRequest(value)) return true;
  // 2026-11-12 复审：宣传单、易拉宝、请柬、贺卡、公众号头图等同样要准确中文，按海报排字处理
  const poster = POSTER_KIND.test(value);
  const imageText = /图片|宣传图|活动图|配图|图像/.test(value) && /写上|印上|(?:加|放|叠)上.{0,12}(?:标题|文字|中文|文案|字)|(?:上面|图中|图上|每张|每一张).{0,8}(?:写|加|放)|写(?:一句|一行|几句|几个字)|(?:黑体|宋体|楷体).{0,3}字/.test(value);
  if (!poster && !imageText) return false;
  if (/^(?:解释|介绍|讨论|如何|怎么|什么|有哪些)|提示词|制作方法/.test(value.trim())) return false;
  if (/(?:不要|不用|无需|别|暂不|不必|先不).{0,8}(?:生成|制作|设计|画)/.test(value)) return false;
  if (/架构图|流程图|关系图|组织图|拓扑图/.test(value)) return false;
  if (/(?:开发|实现|编写|提供|交付|写一段).{0,12}(?:代码|程序|脚本|应用)|(?:只给|只要)(?:代码|脚本)/.test(value)) return false;
  if (directModelTextRequest(value)) return false;
  if (/(?:Word|docx|Excel|xlsx|文档|报告).{0,6}封面/i.test(value) || new RegExp(`(?:Word|docx|Excel|xlsx).{0,12}(?:${POSTER_KINDS}|告示)|(?:${POSTER_KINDS}).{0,12}(?:Word|docx|Excel|xlsx)`, 'i').test(value)) return false;
  // 只要宣传单/请柬的文案、话术，不出图
  if (new RegExp(`(?:${POSTER_KINDS})的?(?:文案|话术|文字稿|措辞|内容)`).test(value) && !/图|画|设计|排版|做成|生成/.test(value.replace(new RegExp(`(?:${POSTER_KINDS})的?(?:文案|话术|文字稿|措辞|内容)`, 'g'), ''))) return false;
  if (!/海报|(?:PPT|幻灯片)[的 ]*封面/i.test(value) && /(?:做|制作|生成).{0,8}(?:PPT|演示文稿|幻灯片)/i.test(value)) return false;
  const addingText = /(?:再|然后|最后).{0,12}(?:排|加|放|写).{0,10}(?:字|文案|标题)/.test(value);
  if (!addingText && /(?:无字|不带字|不含文字|没有文字|不要(?:任何)?文字)|(?:只要|只做|只画|仅生成).{0,8}(?:底图|背景)/.test(value)) return false;
  return new RegExp(`(?:画|生成|制作|设计|做|重画|修改|改成|来)[^。！？\\n]{0,40}(?:${POSTER_KINDS})|(?:${POSTER_KINDS})[^。！？\\n]{0,40}(?:加上|写上|改成|排版|换字|改字)`).test(value)
    || imageText && /(?:画|生成|制作|设计|做|重画|修改|改成)[^。！？\n]{0,40}(?:图片|宣传图|活动图|配图|图像)|(?:图片|宣传图|活动图|配图|图像)[^。！？\n]{0,30}(?:写上|加上|叠上|换字|改字)/.test(value);
}

export const POSTER_TOOLS = ['generate_image', 'make_poster', 'process_image', 'inspect_image', 'read_image_text', 'read_file', 'list_files', 'find_files', 'preview', 'update_plan'];

export const POSTER_GUIDANCE = '新自由稿必须写design.concept，正文有3个以上百分比要用chart图层。生成配图时用keep_clear标出之后要压字的区域，看回执clearAreas再排字；不达标就换区域、加底块或重画，不硬压字。像设计师一样先想后做：先定构思（design.concept：创意、按内容选图文关系、第一眼看什么、气质，不套固定版式）；没把握时用sketches交2–3个不同构思的草图比较（不算试排）；再按选定版式生成配图（构图、留白、主色服务于版式）；最后排字出稿，按designReview.suggestions整体改。要在底图卡片里填字时，用generate_image的purpose=poster_slots和text_slots先算好卡片位置再生图。默认交delivery.primaryPath一张海报，源文件和历史稿在文件空间展开；不反复改名重做，最多3次试排，按retryAllowed停止。图文并茂需实际主题配图/有来源数据图表；图标和数字卡片不算。分类或指数涨跌幅对比用chartType=bar+unit，不把不同指数连成时间走势。contentCheck未通过不能说全项检查通过。已有底图卡槽或保留全图直接填字用make_poster.canvas：background_path引用原图，entries每组标题/正文；图上主标题放canvas.header，root.title仅作品名。自动识别文字区，不确定时一次视觉定位；regions和protected为原图0–1比例。仅Canvas真实字体，不裁图、不遮罩、不走SVG，交付PNG/原生文字PPTX/可拖动文字框HTML/ZIP/.canvas.json。改字source_path+canvas.entries保留原图与位置；补Demo复用同稿。装不下则调整区域或拆版，不截字、不缩到不可读。以下design分层路线仅用于重新构图。中文图文海报用make_poster.design。当前工具明确支持自由构图：design.layout=free配合layers指定每个文字/图片/图标/形状/图表的坐标，不能沿用历史回答声称“只有固定模板/不能加图标”，更不能以此绕去手改SVG。先按参考图和文案量构图，用户说换结构时真正更换坐标与分组；palette只换色。可用起稿：editorial主次编排、campaign图文宣传、timeline时间轴、newspaper报纸双栏、celebration纪念、dashboard大屏；都能再用free调整。已有分层源稿换结构可传source_path为原稿.design.json、design.layout为timeline，复用原文/配色，不重画素材。新闻用sections保留各条标题和事实，不将宣传大图占满上半张再塞小字列表。竖版默认reading=phone，按390px整张显示检查正文至少12px；presentation失败须重排而非只加深颜色，必要时增高或拆版，不擅删原文。照片/产品图复用design.assets；需要新视觉才generate_image(purpose=poster_art)，只画主体和场景，不画标题、文字、空卡片/胶囊框/按钮或完整宣传页，所有排字和卡片由程序完成。已有带字成品不能当无字素材；重新构图的素材含占位卡片需说明替换，原图保留填字则用canvas定位后写入，不以覆盖面板冒充融合。中文、日期、数字、单位独立真实字体排版。改字用source_path+changes；不手改SVG后遗漏PPTX/JSON。补同稿Demo用create_visual_demo.source_path，不重画。旧.poster.json和明确gradient要求保持原接口。交付最终PNG、自包含可编辑SVG和PPTX，phonePreview是原海报按手机宽度缩放的实际文件，应核对它，不以另排Demo卡片可读冒充海报可读。不要绕sandbox/run_python/手写HTML截图/render_diagram。用户明确要求模型直接画字则尊重选择并核对。原文、字体、像素、对比、手机缩放、视觉各按回执报告，不能说四项通过就证明好看、绝对无错字或原生4K。失败保留源稿，只修文字/布局，不反复付费重画素材。';

/** 仅收实际工具返回的三格式回执，不凭“已生成”或文件名认定海报完成。 */
export function posterReceipt(ok, output = '') {
  let value;
  try { value = JSON.parse(String(output).slice(0, 24000)); } catch { value = null; }
  const checked = state => ['passed', 'failed'].includes(state) ? state : 'not_checked';
  const canvas = value?.renderer === 'canvas' && value?.designVersion === 'canvas-image-text-1';
  const outputs = value?.kind === 'poster' && Array.isArray(value.files) ? value.files.slice(0, canvas ? 8 : 3).filter(file =>
    (canvas ? ['png', 'pptx', 'html', 'zip'] : ['png', 'svg', 'pptx']).includes(file?.format) && typeof file.path === 'string' && file.path.length > 0 && file.path.length <= 400 && file.path.toLowerCase().endsWith('.' + file.format)
  ).map(file => ({ format: file.format, path: file.path, readback: checked(file.readback), structure: checked(file.structure), render: checked(file.render) })) : [];
  const usable = ok ? outputs.filter(file => file.readback === 'passed' && file.structure === 'passed') : [];
  const dimensions = Number.isSafeInteger(value?.width) && value.width > 0 && Number.isSafeInteger(value?.height) && value.height > 0;
  const errors = Array.isArray(value?.errors) ? value.errors.length : 0;
  const complete = ok && value?.status === 'complete' && value.textRendering === 'program' && value.fontCheck === 'passed' && dimensions && !errors && (!value.contentCheck || value.contentCheck.status === 'passed' && value.contentCheck.semantic === 'passed') && (!canvas || value.backgroundCheck?.status === 'passed' && value.layout?.status === 'passed' && value.contrast?.status === 'passed' && value.detection?.confidence >= 0.8) && (canvas ? ['png', 'pptx', 'html', 'zip'] : ['png', 'svg', 'pptx']).every(format => usable.some(file => file.format === format && (format !== 'png' || file.render === 'passed')));
  const designPath = ok && typeof value?.designPath === 'string' && value.designPath.length <= 400 && /\.(?:poster|design|canvas)\.json$/i.test(value.designPath) ? value.designPath : undefined;
  const delivery = value?.delivery && typeof value.delivery.primaryPath === 'string' && value.delivery.primaryPath.length <= 400 ? value.delivery : undefined;
  return { kind: 'poster', ...(canvas && { renderer: 'canvas' }), ...(designPath && { designPath }), ...(delivery && { delivery }),
    ...(value?.contentCheck && { contentCheck: value.contentCheck }), state: !ok ? 'failed' : complete ? 'completed' : usable.length ? 'partial' : 'pending', files: usable.map(file => file.path), outputs: ok ? outputs : [], ...(dimensions && { width: value.width, height: value.height }), visual: checked(value?.visual), fontCheck: checked(value?.fontCheck), errors, errorCodes: Array.isArray(value?.errors) ? value.errors.slice(0, 3).map(error => String(error?.code || '').slice(0, 80)) : [] };
}

/** 文件已生成与视觉已验收是两件事；这条只守海报交付措辞，不改通用事实核查。 */
export function posterAnswerIssues(text = '', media) {
  if (media?.kind !== 'poster') return [];
  const claims = String(text).split(/[。！!；;，,\n]/).filter(line => !/不能|无法|尚未|未通过|未完成|不代表|不等于|不保证/.test(line));
  const issues = [];
  if (media.contentCheck && (media.contentCheck.status !== 'passed' || media.contentCheck.semantic !== 'passed') && claims.some(line => /(?:图文并茂|全部|所有|全项).{0,12}(?:通过|符合|完成|达标)|(?:完全|完美).{0,6}满足/.test(line))) issues.push('图文并茂缺少实际成品通过证据，不能称全项通过；区分排版技术检查与主题配图/融合编排复核');
  if (claims.some(line => /(?:保证|确保|绝对|完全|100%|百分之百).{0,18}(?:错字|错别字|乱码|正确|准确)|(?:零错字|完全无错字|文字全部正确)/.test(line))) issues.push('程序排字不等于文字内容绝对正确；删除保证无错字/绝对准确的承诺，按真实文字与字体检查回执说明');
  // 2026-11-17 用户反馈：链接写“海报/美国新闻-1117.png”，点开是内部试排目录的“海报.png”；第二版说三份都在，其实没有PPT
  issues.push(...linkLabelIssues(text));
  const formats = new Set((media.outputs || []).filter(o => o.readback === 'passed').map(o => o.format));
  if (formats.size && !formats.has('pptx') && claims.some(line => /(?:PPTX?|ppt|幻灯片)/i.test(line) && /(?:已|都在|齐|生成了|交付|可编辑|可改|在这|如下)/.test(line) && !/(?:没|未|不|缺|待|还)/.test(line) || /三份(?:都在|齐了|文件)/.test(line))) issues.push('本次实际只生成了' + [...formats].map(f => f.toUpperCase()).join('、') + '，没有PPT；按回执如实列出文件，不能说三份都在');
  if (media.visual !== 'passed' && claims.some(line => /通过.{0,6}(?:视觉|看图).{0,8}(?:验收|核验|检查)|完成.{0,6}视觉验收|视觉(?:验收|检查)(?:已)?通过/.test(line))) issues.push('海报没有对应成品的视觉通过回执，不能把生成/读回成功称为视觉验收通过；如实说明视觉未验收');
  return issues;
}

/** 链接文字写成文件名时，必须是链接实际指向的那个文件名（不分格式通用） */
export function linkLabelIssues(text = '') {
  const issues = [];
  for (const [, label, target] of String(text).matchAll(/\[([^\]\n]{1,200})\]\(([^)\s]{1,600})\)/g)) {
    const named = /([^\s/\\]+\.(?:png|jpe?g|webp|svg|pptx|docx|xlsx|pdf|html|zip|json|md))\s*$/i.exec(label.replace(/`/g, ''));
    if (!named || /^https?:/i.test(target)) continue;
    let actual = target;
    try { actual = decodeURI(target); } catch { /* 保留原样 */ }
    if (actual.split(/[\\/]/).pop() !== named[1]) issues.push(`链接文字写的是“${named[1]}”，实际指向“${actual.split(/[\\/]/).pop()}”；链接文字要写真实文件名或改成说明文字（如“海报PNG”），不能让用户点开发现不是同一个文件`);
  }
  return issues.slice(0, 3);
}

/** 链接文字写成了别的文件名：改成实际指向的文件名（重写一次仍没改好时兜底，不整段吞掉回答） */
export function fixLinkLabels(text = '') {
  return String(text).replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,600})\)/g, (all, label, target) => {
    const named = /([^\s/\\]+\.(?:png|jpe?g|webp|svg|pptx|docx|xlsx|pdf|html|zip|json|md))\s*$/i.exec(label.replace(/`/g, ''));
    if (!named || /^https?:/i.test(target)) return all;
    let actual = target;
    try { actual = decodeURI(target); } catch { /* 保留原样 */ }
    const name = actual.split(/[\\/]/).pop();
    return name === named[1] ? all : `[${name}](${target})`;
  });
}
