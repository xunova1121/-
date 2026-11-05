/**
 * PPT 模板库（智能体广场第3步）：每个模板 = 风格 + 配色 + 场景 + 推荐结构 + 原创配图 + 一份样例内容。
 * 样张和配图都由未央自己的排版引擎和 scripts/make-ppt-templates.mjs 生成（配图是脚本里手写的原创几何插画），
 * 不使用网上的模板文件或图片。缩略图在 src/assets/ppt-templates/<id>-<页>.jpg；配图不存文件，由 pptTemplateArt.js 现画。
 */
export const TEMPLATE_SCENES = Object.freeze({ gov: '政企汇报', summary: '工作总结', pitch: '项目路演', teach: '培训教学', data: '数据分析', product: '产品发布', event: '节日活动', simple: '简约通用' });

const t = (id, name, scene, style, theme, desc, art, outline, sample) => ({ id, name, scene, style, theme, desc, art, outline, sample: sample.replace('{{TITLE}}', name) });

/** art：本模板自带的配图，[名字, 图案, 用途]；图案见 scripts/pptTemplateArt.mjs */
const LIST = [
  t('gov-progress', '项目进展汇报', 'gov', 'report', 'tech-blue', '政企项目阶段汇报：结论先行，指标、成效、下一步一目了然',
    [['cover', 'city', '封面 / 章节'], ['scene', 'dashboard', '成效页配图']],
    ['一、项目概况', '二、建设成效', '三、问题与对策', '四、下一步计划'],
    `# {{TITLE}}\n\n![封面](art/cover)\n\n## 一、项目概况\n\n结论：一期建设**按期完成**，核心系统全部上线\n\n- 12项：建设任务全部完成\n- 98%：重点区域覆盖率\n- 3个月：比计划提前\n\n## 二、建设成效：一屏统管\n\n![运营驾驶舱](art/scene)\n\n- 一屏统管：事件汇聚到运营驾驶舱｜平均发现时间缩短到5分钟\n- 一键调度：工单自动派发｜处置效率提升40%\n- 一网协同：三支队伍统一指挥\n\n## 三、问题与对策\n\n- 数据不全：部分老旧系统未接入｜年底前完成改造\n- 人员不足：值守力量偏紧｜引入智能巡检\n- 机制待完善：考核口径不一｜统一指标体系\n- 资金压力：二期预算待批｜分批实施\n\n## 谢谢\n\n以数字化赋能精细化治理`),
  t('gov-annual', '年度工作汇报', 'gov', 'report', 'gov-red', '党政机关年度工作汇报：政务红配色，庄重大气',
    [['cover', 'ribbon', '封面 / 章节'], ['scene', 'city', '成效页配图']],
    ['一、年度总体情况', '二、主要工作成效', '三、存在的不足', '四、明年工作思路'],
    `# {{TITLE}}\n\n![封面](art/cover)\n\n## 一、年度总体情况\n\n结论：全年目标任务**全面完成**\n\n- 26项：重点任务完成\n- 15个：民生实事落地\n- 100%：群众诉求按时办结\n\n## 二、主要工作成效\n\n![城市面貌](art/scene)\n\n- 营商环境：办事环节压减30%｜“一网通办”覆盖全部事项\n- 民生保障：新增养老床位500张\n- 城市更新：完成老旧小区改造12个\n\n## 三、明年工作思路\n\n- 稳增长：抓项目、促投资\n- 优服务：深化“放管服”改革\n- 惠民生：办好十件实事\n- 强基础：加强基层治理\n\n## 谢谢\n\n凝心聚力，再创佳绩`),
  t('eco-park', '生态园区方案', 'gov', 'report', 'eco-green', '园区、乡村、生态类方案汇报：生态绿配色，清新可信',
    [['cover', 'leaves', '封面 / 章节'], ['scene', 'leaves', '方案页配图']],
    ['一、现状与痛点', '二、总体方案', '三、建设内容', '四、预期效益'],
    `# {{TITLE}}\n\n![封面](art/cover)\n\n## 一、现状与痛点\n\n- 看不全：监测点位少｜重点区域覆盖不足60%\n- 管不住：问题发现晚｜平均2小时后才处置\n- 算不清：能耗底数不明｜月度统计需3天\n- 调不动：多部门各自为战\n\n## 二、总体方案：绿色智慧园区\n\n![园区全景](art/scene)\n\n- 智能感知：新增监测点位400个\n- 统一平台：数据汇聚一张图\n- 闭环管理：发现、派单、核查全流程\n\n## 三、预期效益\n\n- 30%：能耗下降\n- 98%：监测覆盖率\n- 5分钟：问题发现时间\n\n## 谢谢\n\n共建绿色家园`),
  t('work-summary', '年度工作总结', 'summary', 'business', 'business', '个人或部门年终总结、述职：稳重商务蓝，条理清晰',
    [['cover', 'growth', '封面'], ['scene', 'growth', '业绩页配图']],
    ['年度工作概述', '重点工作与成果', '不足与反思', '明年计划'],
    `# {{TITLE}}\n\n![封面](art/cover)\n\n## 年度工作概述\n\n- 120%：年度指标完成率\n- 8个：主导项目\n- 3项：流程优化\n\n## 重点工作与成果\n\n![业绩增长](art/scene)\n\n- 客户拓展：新签客户25家，续约率92%\n- 流程优化：审批时间从5天缩短到2天\n- 团队建设：带教新人4名\n\n## 不足与反思\n\n- 跨部门协同偏慢\n- 数据复盘不够及时\n- 新业务探索投入不足\n\n## 明年计划\n\n- 一季度：完成新系统上线\n- 二季度：拓展华东区域\n- 下半年：建立月度复盘机制`),
  t('startup-pitch', '项目路演', 'pitch', 'story', 'midnight-galaxy', '融资路演、创新大赛：深色叙事，突出愿景和数字',
    [['cover', 'orbit', '封面'], ['scene', 'orbit', '愿景页配图']],
    ['痛点', '解决方案', '市场与模式', '团队与融资'],
    `# {{TITLE}}\n\n![封面](art/cover)\n\n## 我们看到的问题\n\n每年有超过一半的小微企业，因为管不清账而错过增长机会。\n\n## 解决方案\n\n![产品愿景](art/scene)\n\n- 一键记账：拍照即可入账\n- 智能分析：自动生成经营报告\n- 风险提醒：现金流预警\n\n## 市场与模式\n\n- 3000万家：目标客户规模\n- 订阅制：按年付费\n- 30%：毛利率目标\n\n## 加入我们\n\n本轮融资用于产品研发与市场拓展`),
  t('training', '培训课件', 'teach', 'minimal', 'modern-minimalist', '内部培训、课堂教学：简洁留白，重点突出，适合讲解',
    [['cover', 'books', '封面'], ['scene', 'books', '知识点配图']],
    ['课程目标', '核心知识点', '案例练习', '课后总结'],
    `# {{TITLE}}\n\n![封面](art/cover)\n\n## 课程目标\n\n- 理解：基本概念与原理\n- 掌握：三个常用方法\n- 应用：完成一次实操练习\n\n## 核心知识点\n\n![学习](art/scene)\n\n- 方法一：先明确目标，再拆解步骤\n- 方法二：用数据说话，避免主观判断\n- 方法三：及时复盘，持续改进\n\n## 案例练习\n\n1. 阅读案例材料\n2. 分组讨论 10 分钟\n3. 每组派代表分享\n\n## 课后总结\n\n今天的三个方法，下周工作中至少用上一个。`),
  t('data-report', '经营数据分析', 'data', 'data', 'ocean-depths', '月报、季报、经营分析：图表为主，数据清楚',
    [['cover', 'dashboard', '封面'], ['scene', 'dashboard', '数据页配图']],
    ['核心指标', '趋势分析', '结构分析', '结论与建议'],
    `# {{TITLE}}\n\n![封面](art/cover)\n\n## 核心指标\n\n- 1280万：本季度营收\n- 18%：同比增长\n- 42%：毛利率\n\n## 季度营收趋势\n\n| 季度 | 营收（万元） |\n|---|---|\n| 一季度 | 980 |\n| 二季度 | 1050 |\n| 三季度 | 1160 |\n| 四季度 | 1280 |\n\n## 结论与建议\n\n![数据看板](art/scene)\n\n- 增长主要来自新产品线\n- 华南区域增速放缓，需重点关注\n- 建议加大线上渠道投入`),
  t('product-launch', '新品发布', 'product', 'minimal', 'tech-innovation', '产品发布、功能介绍：科技感简洁风，突出卖点',
    [['cover', 'device', '封面'], ['scene', 'device', '产品页配图']],
    ['产品亮点', '核心功能', '使用场景', '上市计划'],
    `# {{TITLE}}\n\n![封面](art/cover)\n\n## 全新一代智能助手\n\n![产品](art/scene)\n\n- 更快：响应速度提升一倍\n- 更懂你：记住你的使用习惯\n- 更安全：数据全程加密\n\n## 核心功能\n\n- 语音交互：说一句就能办\n- 文档生成：一键出报告\n- 多端同步：手机电脑无缝衔接\n\n## 上市计划\n\n- 11月：开放预约\n- 12月：正式发售\n- 明年一季度：海外上线`),
  t('festival-event', '节日活动方案', 'event', 'story', 'sunset-boulevard', '节日庆典、团建、市场活动：暖色氛围，热闹喜庆',
    [['cover', 'lanterns', '封面'], ['scene', 'lanterns', '活动页配图']],
    ['活动主题', '活动流程', '分工安排', '预算与保障'],
    `# {{TITLE}}\n\n![封面](art/cover)\n\n## 活动主题\n\n团圆迎新春，携手向未来\n\n## 活动流程\n\n![活动现场](art/scene)\n\n1. 14:00 签到入场\n2. 14:30 领导致辞\n3. 15:00 游戏互动\n4. 16:30 抽奖与合影\n\n## 分工安排\n\n- 策划组：方案与流程\n- 物料组：场地布置与礼品\n- 宣传组：海报与拍照\n- 保障组：安全与后勤\n\n## 谢谢\n\n期待与你一起欢度佳节`),
  t('simple-general', '简约通用', 'simple', 'minimal', 'arctic-frost', '什么场合都能用的简洁模板：留白多，信息干净',
    [['cover', 'mountains', '封面'], ['scene', 'mountains', '内容页配图']],
    ['背景', '核心观点', '具体做法', '总结'],
    `# {{TITLE}}\n\n![封面](art/cover)\n\n## 背景\n\n我们正处在一个变化很快的阶段，需要更清楚地知道往哪里走。\n\n## 核心观点\n\n![远方](art/scene)\n\n- 聚焦：少做几件事，把它们做好\n- 协同：让信息在团队里流动起来\n- 迭代：小步快跑，及时调整\n\n## 具体做法\n\n- 第一步：明确目标\n- 第二步：拆解任务\n- 第三步：定期复盘\n\n## 总结\n\n方向清楚，行动坚定。`)
];

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const PPT_TEMPLATES = freeze(LIST);
export const PPT_TEMPLATE_IDS = Object.freeze(LIST.map((x) => x.id));
export const pptTemplate = (id) => PPT_TEMPLATES.find((x) => x.id === id) || null;
/** 复制进工作区后的配图路径（模型在 PPT 正文里用 ![说明](路径) 引用） */
export const templateArtPath = (id, name) => `模板素材/${id}/${name}.png`;

/** 选了模板时交给模型的说明：用哪个风格配色、推荐结构、可用的配图（路径在工作区里） */
export function templateNote(id) {
  const x = pptTemplate(id);
  if (!x) return '';
  const art = x.art.map(([name, , use]) => `${templateArtPath(x.id, name)}（${use}）`).join('、');
  return `模板「${x.name}」：生成 PPT 时 create_document 传 style=${x.style}、theme=${x.theme}；推荐结构：${x.outline.join(' → ')}；可用配图：${art}，在正文里用 ![说明](路径) 引用，配图只是氛围图，不能代替真实照片或数据`;
}
