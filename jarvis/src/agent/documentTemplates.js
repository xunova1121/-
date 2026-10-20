import { EXTRA_RECIPES } from './documentRecipes.js';
/** 未央自有模板：提供结构和版式约束，事实与数值必须由用户资料填充。 */
export const DOCUMENT_TEMPLATES = [
 {id:'ppt-proposal',format:'pptx',name:'项目方案与决策汇报',theme:'business',purpose:'项目立项、建设方案、管理层决策',outline:['一句话结论与待决策事项','现状和证据','关键问题','目标与衡量标准','整体方案','业务场景','实施路径','预算与收益口径','风险及应对','本次需要的决定'],rules:['每页一个结论，标题直接表达观点','数据页注明来源、日期、单位；不编造收益','卡片、流程、对比、图表交替使用；连续相同版式不超过两页','先确定受众和汇报目的，再选页数；不为凑页数重复内容']},
 {id:'ppt-review',format:'pptx',name:'工作复盘与进度汇报',theme:'business',purpose:'周报、月报、季度复盘',outline:['本期结论','目标与实际对照','关键成果及证据','问题与根因','下一阶段行动','需要的支持'],rules:['区分已完成、进行中和计划','每项行动明确负责人、时间和验收标准','成果用实际数字或产物表达，不堆套话']},
 {id:'word-report',format:'docx',name:'正式报告与分析方案',theme:'business',purpose:'研究报告、调研、建议书',outline:['摘要与结论','背景及范围','资料来源与分析方法','发现与论证','建议及实施安排','风险与限制','附件与参考资料'],rules:['标题逐级展开，不跳级','事实、推断和建议分开，引用可以追溯','统一表格列名、数字单位、术语和日期','正文保持可编辑，目录和页码由文档生成器处理']},
 {id:'word-notice',format:'docx',name:'通知与正式公文',theme:'gongwen',purpose:'通知、函、请示',outline:['标题','主送单位','事由和依据','具体事项','执行要求与联系人','落款与日期'],rules:['没有用户提供的单位和文号就不捏造','短通知不硬加摘要、目录或多余封面','具体要求可执行，避免模糊指令']},
 {id:'excel-budget',format:'xlsx',name:'预算与投资测算',theme:'business',purpose:'费用预算、项目投资、成本测算',outline:['总览','预算明细','假设与口径','核对事项'],rules:['明细列：类别、项目、数量、单价、金额、依据','金额用数量乘单价公式，汇总引用明细；不能用手填值假装公式','注明币种、含税口径和计量单位','实际值、假设值和待确认值分清；不自动补造数字']},
 {id:'excel-tracker',format:'xlsx',name:'任务与项目跟踪表',theme:'business',purpose:'工作安排、交付清单、项目台账',outline:['总览','任务明细','风险问题','变更记录'],rules:['明细列：编号、任务、负责人、开始、截止、状态、交付物、验收标准','完成率来自明细实际状态或数量','缺失负责人和日期应标待确认，不能凭空安排','状态和日期格式统一，保留筛选与冻结表头']}
];
DOCUMENT_TEMPLATES.push(...EXTRA_RECIPES);
const WORDS = {
 'ppt-proposal': ['项目', '立项', '决策', '方案'], 'ppt-review': ['周报', '月报', '季报', '复盘', '进度'],
 'word-report': ['报告', '分析'], 'word-notice': ['通知', '公文', '请示', '函'],
 'excel-budget': ['预算', '投资', '测算', '成本'], 'excel-tracker': ['任务', '台账', '跟踪', '计划']
};
for (const item of DOCUMENT_TEMPLATES) {
 item.keywords ??= WORDS[item.id] || [];
 item.starter ??= item.outline.map(title => `## ${title}\n${item.format === 'xlsx' ? '| 事项 | 说明 |\n|--|--|\n' : '依据用户资料填写，不把骨架作为成品交付。\n'}`).join('\n');
}
export function documentTemplate(id) {
 const found=DOCUMENT_TEMPLATES.find(x=>x.id===id);if(!found)throw Object.assign(new Error('没有这个模板，请先查看模板列表'), {code:'DOCUMENT_TEMPLATE',kind:'validation'});
 return JSON.stringify({...found,instructions:'先读取用户材料和完整要求，再按用途调整结构；这是工作方法，不是已经填写好的成品。生成后必须检查真实文件及预览，不能把结构检查说成Office视觉验收。'},null,2);
}

