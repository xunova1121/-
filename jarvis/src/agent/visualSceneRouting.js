/** 大屏与同稿交互演示复用专用视觉交付，普通网页开发、架构图和纯海报保留原入口。 */
export function visualSceneRequest(text = '') {
  const value = String(text).slice(-6000).trim();
  if (/^(?:解释|介绍|讨论|如何|怎么|什么|有哪些)|提示词|制作方法|题设/.test(value)) return false;
  if (/架构图|流程图|关系图|组织图|拓扑图/.test(value)) return false;
  const requested = value.split(/[，,。；;\n]/).filter(clause => !/(?:不要|不用|无需|不需要|暂不).{0,12}(?:Demo|交互|互动|演示|HTML)/i.test(clause));
  const interactive = requested.some(clause =>
    /(?:交互|互动)(?:式|版|演示)?\s*(?:Demo|演示|网页|页面|HTML)|(?:可点击|可筛选|可切换|可操作).{0,12}(?:Demo|演示|网页|页面)|(?:Demo|HTML|网页|演示).{0,12}(?:交互|互动|可点击|可筛选|可切换)|(?:同一?设计|同稿).{0,10}Demo|(?:补|加|做|给|要|提供|交付).{0,8}Demo/i.test(clause)
  );
  const posterDemo = /海报|封面|\.poster\.json/i.test(value) && interactive;
  const existing = /\.visual\.json/i.test(value) || /\.poster\.json/i.test(value) && requested.some(clause => /Demo|交互|互动|演示|HTML/i.test(clause));
  const dashboard = /(?:数据|可视化|监控|指挥|运营|业务|气象|天气|城市|态势|智慧).{0,8}(?:大屏|驾驶舱)|(?:气象|天气).{0,8}(?:看板|仪表盘)/.test(value);
  if (!posterDemo && !existing && !dashboard) return false;
  if (/(?:不要|不用|无需|别|暂不|不必|先不)[^，,。；;\n]{0,5}(?:生成|制作|设计|开发|创建|做|画)[^，,。；;\n]{0,8}(?:大屏|驾驶舱|海报|Demo|交互演示)/i.test(value)) return false;
  if (/(?:不要|不用|无需|别|暂不|不必|先不)[^，,。；;\n]{0,5}(?:修改|更新|生成|制作|导出)[^，,。；;\n]{0,200}\.visual\.json/i.test(value)) return false;
  // 只交源码、组件或实现教程仍属于开发；明确同稿海报+Demo和已有源稿续做除外。
  if (!posterDemo && !existing && /(?:只给|只要|仅要|编写|提供|交付).{0,10}(?:代码|源码|组件|函数)|(?:代码|源码|组件).{0,8}(?:实现|示例)|(?:开发|实现).{0,8}(?:接口|后端)/.test(value)) return false;
  return /生成|制作|设计|创建|编写|开发|实现|导出|修改|更新|改成|做|画|来|给|补|增加|需要|我要/.test(value);
}

export const VISUAL_SCENE_TOOLS = ['create_visual_demo', 'generate_image', 'process_image', 'inspect_image', 'read_image_text', 'read_file', 'list_files', 'find_files', 'preview', 'update_plan'];

export const VISUAL_SCENE_GUIDANCE = '复杂数据大屏、气象驾驶舱或同一设计的高清海报加交互Demo，调用create_visual_demo，用同一.visual.json设计稿交付PNG、可编辑SVG和离线HTML，ZIP可选。数据/气象大屏即使称海报或只要PNG也用此工具，用户只要图片时主交PNG并附源稿，不要求用户打开Demo。可以直接提供独立visual design；已有.visual.json或.poster.json时用source_path复用，已有海报补Demo不重新生成底图。背景优先用用户真实路径，没有合适底图才用generate_image画无字素材；精确中文、数字、图表和交互由程序叠加，保留用户原文。按实际回执分别报告文件生成、读回、结构、PNG渲染、字体、视觉和交互检查；generated不算验收通过，文件完整不等于视觉或交互已验收。没有接入数据源时明确标注示例数据；dataMode=provided只表示用户提供数据，不证明真实实时联网。4K只描述输出像素尺寸，不把放大后的底图声称为原生4K。失败保留设计源稿和已有文件，说明缺失格式/阶段，不自动重画底图；普通网页源码、架构图和纯中文海报仍按各自原工具处理。';

const checked = state => ['passed', 'failed'].includes(state) ? state : 'not_checked';

/** 仅接收实际工具回执；完整文件交付与视觉、交互验收分别记账。 */
export function visualSceneReceipt(ok, output = '') {
  let value;
  try { value = JSON.parse(String(output).slice(0, 24000)); } catch { value = null; }
  const valid = value?.kind === 'visual_demo';
  const outputs = valid && Array.isArray(value.files) ? value.files.slice(0, 8).filter(file =>
    ['png', 'svg', 'html', 'zip'].includes(file?.format) && typeof file.path === 'string' && file.path.length > 0 && file.path.length <= 400 && file.path.toLowerCase().endsWith('.' + file.format)
  ).map(file => ({ format: file.format, path: file.path, readback: checked(file.readback), structure: checked(file.structure), render: checked(file.render) })) : [];
  const usable = ok ? outputs.filter(file => file.readback === 'passed' && file.structure === 'passed') : [];
  const dimensions = valid && Number.isSafeInteger(value.width) && value.width > 0 && Number.isSafeInteger(value.height) && value.height > 0;
  const designPath = ok && valid && typeof value.designPath === 'string' && value.designPath.length <= 400 && /\.visual\.json$/i.test(value.designPath) ? value.designPath : undefined;
  const dataMode = valid && ['demo', 'provided'].includes(value.dataMode) ? value.dataMode : 'not_checked';
  const errors = valid && Array.isArray(value.errors) ? value.errors.length : 0;
  const complete = ok && valid && value.status === 'complete' && value.textRendering === 'program' && value.fontCheck === 'passed' && dimensions && designPath && dataMode !== 'not_checked' && !errors
    && ['png', 'svg', 'html'].every(format => usable.some(file => file.format === format && (format !== 'png' || file.render === 'passed')));
  return {
    kind: 'visual_demo', state: !ok ? 'failed' : complete ? 'completed' : usable.length ? 'partial' : 'pending',
    files: usable.map(file => file.path), outputs: ok ? outputs : [], ...(designPath && { designPath }), ...(dimensions && { width: value.width, height: value.height }),
    fontCheck: checked(valid && value.fontCheck), visual: checked(valid && value.visual), interaction: checked(valid && value.interaction), dataMode,
    errors, errorCodes: valid && Array.isArray(value.errors) ? value.errors.slice(0, 3).map(error => String(error?.code || '').slice(0, 80)) : []
  };
}

/** 不从生成状态推断看图、操作或数据源验收，也不从导出尺寸推断素材分辨率。 */
export function visualSceneAnswerIssues(text = '', media) {
  if (media?.kind !== 'visual_demo') return [];
  const claims = String(text).split(/[。！!；;，,\n]/).filter(line => !/不能|无法|尚未|未经|未通过|未完成|未验收|未接入|不代表|不等于|不保证|并非|不是/.test(line));
  const issues = [];
  if (claims.some(line => /(?:保证|确保|绝对|完全|100%|百分之百).{0,18}(?:错字|错别字|乱码|正确|准确)|(?:零错字|完全无错字|文字全部正确)/.test(line))) issues.push('程序排字不证明文字绝对正确；按真实文字与字体回执报告，不承诺绝对无错字');
  if (media.visual !== 'passed' && claims.some(line => /通过.{0,6}(?:视觉|看图).{0,8}(?:验收|核验|检查)|完成.{0,6}视觉验收|视觉(?:验收|检查)(?:已)?通过/.test(line))) issues.push('当前视觉尚未验收，生成或读回成功不能称视觉验收通过');
  if (media.interaction !== 'passed' && claims.some(line => /(?:交互|互动|点击|筛选|切换).{0,12}(?:验收通过|检查通过|测试通过|已验证|均可用|全部可用)|(?:通过|完成).{0,8}(?:交互|互动).{0,8}(?:验收|测试|检查)/.test(line))) issues.push('当前交互尚未验收，HTML已生成不能称实际操作测试通过');
  if (claims.some(line => /(?:已接入|已连接|已获取|使用的?是|均为|全部为|这?是).{0,12}(?:实时|真实).{0,6}数据|(?:实时|真实).{0,6}数据.{0,12}(?:已接入|已连接|实时更新|同步更新)|数据(?:为|是|会|可)?实时(?:刷新|更新)/.test(line))) issues.push('dataMode仅区分示例或用户提供数据，不能据此宣称已接入真实实时数据');
  if (claims.some(line => /(?:底图|背景|素材).{0,12}(?:原生|原始).{0,5}4K|(?:原生|原始).{0,5}4K.{0,12}(?:底图|背景|素材)/i.test(line))) issues.push('4K输出尺寸不证明底图原生4K；只报告实际导出尺寸，素材分辨率未核实');
  return issues;
}
