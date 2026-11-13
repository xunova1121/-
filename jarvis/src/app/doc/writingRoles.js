/**
 * 写作角色：同一份材料，给客户汇报、给技术负责人、给法务、给实施团队、给项目办，写法完全不同。
 * 以前所有文档都是一种“审计员”口吻（处处划边界、待确认），给客户的方案没法拿去汇报（用户 2026-10-26 反馈）。
 *   detectRole  从用户原话认出场景（也可以由调用方直接指定 role）
 *   roleGuide   给撰稿、底稿推演、修订用的写法说明
 *   roleReview  给审查员用的检查要点
 *   hedgeIssue  对外文档推辞话术太多时，生成一条必须修改的审查意见
 * 不认识场景时返回 null，沿用原来的通用写法。
 */

/** 推辞、自保的话：对外文档里一多，读起来就是“什么都不承诺” */
const HEDGE =
  /不构成[^，。；\n]{0,12}(?:承诺|依据|标准|约定)|另行(?:确认|约定|明确)|(?:待|需)(?:项目方|甲方|客户|双方)?(?:集中)?确认|责任边界|不代表[^，。；\n]{0,10}(?:承诺|已)|不能据此|不应推定|不宜承诺|讨论稿/g;

export const ROLES = {
  presales: {
    name: '高级售前经理',
    external: true,
    reader: '客户的决策层、业务负责人和采购方',
    voice: '站在客户角度讲价值，自信、具体、有画面感；用“我们将……”“为贵方……”的主动句，不用防御性措辞',
    structure:
      '客户现状与痛点 → 建设目标 → 我方整体方案（一张总体架构）→ 各模块怎么做、给客户带来什么 → 实施路径与里程碑 → 成功案例或类似经验 → 为什么选我们 → 下一步建议',
    uncertain:
      '不确定的事写成“我方推荐按 X 实施，可根据贵方实际调整”，先给方案再留余地；真正需要客户拍板的事，集中放到文末“实施前双方确认事项”，不超过 8 条，每条带我方建议的默认做法',
    avoid: '正文不出现“不构成承诺”“另行确认”“责任边界”“不能据此”“讨论稿”这类自保的话，不逐条罗列谁不负责；不把参考文件的条款号堆满正文（需要时放附录对照表）'
  },
  solution: {
    name: '解决方案专家',
    external: true,
    reader: '客户的技术负责人、总工和评审专家',
    voice: '专业、有深度、讲清楚为什么这样设计；用架构、流程、数据流和选型对比说话',
    structure:
      '需求理解 → 总体架构（分层、部署、数据流）→ 关键技术路线与选型理由 → 各子系统 / 模块设计（功能、接口、性能与可靠性设计）→ 安全设计 → 与现有系统的集成 → 扩展与演进',
    uncertain: '有多种可能时给出推荐方案和一两个备选，讲清取舍和适用条件；参数未定时给出设计取值和可调范围，不写成“待确认”',
    avoid: '不写成需求拆解或责任划分表；不用“不承担”“不纳入”这类划界口吻代替技术设计'
  },
  legal: {
    name: '严谨的法务',
    external: false,
    reader: '合同双方的法务和商务',
    voice: '严谨、精确、可执行；每个义务写清主体、内容、期限、标准和后果',
    structure: '合同 / 条款要点 → 双方权利义务 → 交付与验收标准 → 付款与结算 → 知识产权与保密 → 违约责任与免责 → 争议解决 → 风险提示与修改建议',
    uncertain: '边界、免责、前提条件在这里正是要写细的内容：逐条写清，并给出建议条款原文',
    avoid: '不写空泛的风险提示，每条风险都要给出可直接放进合同的建议措辞'
  },
  implementation: {
    name: '实施方案编写人',
    external: true,
    reader: '实施团队和甲方的项目对接人',
    voice: '可操作、按步骤、有时间和人；读完就能照着干',
    structure:
      '实施目标与范围 → 组织与人员分工 → 环境与资源准备 → 分阶段实施步骤（每步的输入、操作、输出、负责人、工期）→ 联调与测试 → 上线与切换 → 回退方案 → 培训与交接 → 验收',
    uncertain: '依赖的条件写成“实施前提”清单，每条写明需要谁在什么时间提供、没到位时的默认做法',
    avoid: '不写空泛的原则，每一步都要有具体动作；不用“需另行确认”代替计划'
  },
  pm: {
    name: '项目经理',
    external: false,
    reader: '甲方项目办、公司管理层和项目组',
    voice: '目标清楚、节奏明确、风险可控；用表格和里程碑说话',
    structure:
      '项目目标与成功标准 → 范围与工作分解 → 里程碑计划 → 组织分工（谁负责、谁批准、要问谁、要通知谁）→ 风险登记（风险、影响、概率、应对、负责人）→ 沟通与汇报机制 → 变更管理 → 验收与收尾',
    uncertain: '不确定的事进风险登记表或待决事项表，每条带负责人、截止时间和应对办法，不散落在正文里',
    avoid: '不写成技术说明；不只罗列风险而没有应对和负责人'
  }
};

/** 用户点名的角色（“用售前经理的口吻”“作为法务”） */
const NAMED = [
  [/售前/, 'presales'],
  [/解决方案专家|方案专家|架构师/, 'solution'],
  [/法务|律师/, 'legal'],
  [/项目经理|PM\b/i, 'pm'],
  [/实施(?:人员|工程师|经理|方)/, 'implementation']
];

/** 从文种和用途认场景：先认法务、项目管理、实施这些专门文种，再认对外的售前 / 技术方案 */
const SCENES = [
  [/合同|协议书|法务|条款审查|免责|违约|法律意见|合规审查/, 'legal'],
  [/项目(?:管理|计划|章程)|里程碑计划|周报|进度计划|风险登记|RACI|项目启动/i, 'pm'],
  [/实施方案|部署方案|上线方案|割接方案|实施计划|交付方案|运维方案/, 'implementation'],
  [/给客户|向客户|客户汇报|汇报方案|投标|标书|应标|招标|售前|方案建议书|交流材料|宣讲|对外/, 'presales'],
  [/解决方案|技术方案|总体(?:设计|方案)|架构设计|技术路线|建设方案|详细设计/, 'solution']
];

/** @returns {keyof ROLES | null} */
export function detectRole(text) {
  const t = String(text ?? '');
  const named = t.match(
    /(?:用|以|按|作为|当|扮演)(?:一[个位名])?(?:强大的|资深的?|高级的?|专业的?|严谨的?)?([^，。,\s]{2,10}?)(?:的)?(?:口吻|身份|角度|视角|写|来写)/
  );
  if (named) for (const [re, key] of NAMED) if (re.test(named[1])) return key;
  for (const [re, key] of SCENES) if (re.test(t)) return key;
  return null;
}

/** 合法的角色名（调用方指定的） */
export const roleKey = (value) => (Object.hasOwn(ROLES, value) ? value : null);

/** 撰稿、推演、修订时附加的写法说明 */
export function roleGuide(key) {
  const r = ROLES[key];
  if (!r) return '';
  return `\n【写作角色：${r.name}】读者：${r.reader}。口吻：${r.voice}。推荐结构（按任务取舍，不机械套用）：${r.structure}。不确定的事：${r.uncertain}。避免：${r.avoid}。${
    r.external ? '这是对外文档：上面“事实和建议分开、写明前提”的要求，落实为正文直接给推荐方案、前提集中放附录，不要满篇写前提和边界。' : ''
  }\n`;
}

/** 审查员按角色检查的要点 */
export function roleReview(key) {
  const r = ROLES[key];
  if (!r) return '';
  return `\n【按“${r.name}”的标准审】读者是${r.reader}。检查：结构是否符合这个角色（${r.structure}）；口吻是否${r.voice}；不确定事项是否${r.uncertain}；是否违反：${r.avoid}。${
    r.external ? '推辞、自保、划清责任的句子多，读者拿去没法用，按 must_fix 提出，并给出改成“推荐方案 + 可调整项”的写法。' : ''
  }\n`;
}

/** 数推辞话术 */
export function hedges(text) {
  return String(text ?? '').match(HEDGE) ?? [];
}

/**
 * 对外文档推辞话术太多：每 2000 字超过 1 处、且总数至少 4 处，就要求改
 * @returns {object|null} 一条审查意见
 */
export function hedgeIssue(key, draft) {
  if (!ROLES[key]?.external) return null;
  const found = hedges(draft);
  const length = String(draft ?? '').length;
  if (found.length < 4 || found.length <= length / 2000) return null;
  const top = [...new Set(found)].slice(0, 6).join('”“');
  return {
    severity: 'must_fix',
    location: '全文',
    problem: `这是给${ROLES[key].reader}看的文档，正文里有 ${found.length} 处推辞、自保的话（如“${top}”），读起来像什么都不承诺，没法拿去汇报。`,
    fix: '正文改成“我方推荐方案 + 可根据贵方调整”的主动写法；真正需要对方拍板的事集中到文末“实施前双方确认事项”（不超过 8 条，每条带建议的默认做法）；删掉正文里的“不构成承诺”“另行确认”“责任边界”“讨论稿”等字样。'
  };
}
