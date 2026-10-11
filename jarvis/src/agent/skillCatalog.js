/**
 * 技能面板里的“推荐技能”：
 *   builtin  内置（离线一键安装），面向中文办公场景
 *   github   开源技能仓库里的技能（需联网，从 GitHub 下载安装）
 */
const md = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;

export const BUILTIN_SKILLS = [
  {
    title: '周报 / 月报',
    text: md('weekly-report', '把零散的工作记录整理成结构清晰的周报或月报，并生成 Word 文档。用户说“写周报 / 月报 / 工作总结”时使用。', `
# 周报 / 月报

## 步骤
1. 收集素材：用户给的记录、工作区或知识库里的相关文件（用 kb_search / read_file）。素材不够时，列出缺的项让用户补，不要编造数字。
2. 按下面的结构整理，每条以动词开头，量化结果（数量、百分比、时间）：
   - **本周完成**：3–6 条，最重要的放最前
   - **数据 / 进展**：关键指标与上周对比（有数据才写）
   - **问题与风险**：问题 → 影响 → 已采取或建议的措施
   - **下周计划**：3–5 条，写清负责人和截止时间（不知道就留空）
   - **需要协调**：需要谁支持什么（没有就省略）
3. 语气：客观、简洁，不写空话（“积极推进”“持续优化”之类换成具体动作）。
4. 用 create_document 生成 docx，文件名“周报_YYYY-MM-DD.docx”；对话里只给 3 句话的摘要。
`)
  },
  {
    title: '会议纪要',
    text: md('meeting-minutes', '把会议录音转写稿或随手记录整理成标准会议纪要（决议、待办、负责人、截止时间）。用户提到“会议纪要 / 整理会议记录”时使用。', `
# 会议纪要

## 输出结构
- **会议信息**：主题、时间、参会人（原文没有就写“未注明”）
- **结论与决议**：编号列出，每条一句话
- **待办事项**：表格，列为 事项 / 负责人 / 截止时间 / 状态
- **讨论要点**：按议题分组，保留不同意见及理由
- **遗留问题**：未决事项和下次会议要确认的内容

## 规则
1. 只依据原文，不推测；含糊的地方标“（待确认）”。
2. 口语转书面语，去掉寒暄与重复。
3. 待办必须有负责人；原文没说就写“待指定”并在最后提醒用户。
4. 内容超过 1 页时用 create_document 生成 docx，否则直接在对话里给出。
`)
  },
  {
    title: '汇报 PPT',
    text: md('briefing-deck', '根据主题或材料生成结构清晰的汇报 PPT（结论先行、一页一个观点）。用户说“做个 PPT / 汇报材料 / 演示文稿”时使用。', `
# 汇报 PPT

## 结构（金字塔原理，结论先行）
1. 封面：标题（结论式，如“Q3 营收增长 18%，主要来自华东”）+ 汇报人 / 日期
2. 摘要：3 个要点，每个一句话
3. 每个要点 1–3 页：页标题就是这一页的结论；正文 3–5 条，每条不超过 20 字；有数据就用表格
4. 风险与下一步
5. 结尾：需要决策 / 支持的事项

## 规则
- 一页只讲一个观点，正文总字数不超过 80 字。
- 数字保留单位与对比口径（同比 / 环比）。
- 材料不足时先列提纲给用户确认，再生成。
- 用 create_document 生成 pptx：每页一个“## 标题”，正文用列表或表格。
`)
  },
  {
    title: '代码审查',
    text: md('code-review', '审查工作区里的代码：找出缺陷、安全问题和可简化之处，并给出可直接替换的修改。用户说“帮我看看这段代码 / 代码审查 / review”时使用。', `
# 代码审查

## 步骤
1. 用 list_files / read_file 读相关文件；先弄清代码要做什么。
2. 按严重程度检查：
   - **错误**：逻辑错误、边界条件（空值、空数组、越界）、异步与并发、错误处理缺失
   - **安全**：注入（SQL / 命令 / HTML）、密钥写死在代码里、不受信任的输入
   - **可维护性**：重复代码、过长函数、命名含糊
3. 每个问题给出：位置（文件:行）、问题、为什么是问题、修改后的代码。
4. 能运行的（JS / Python）用 run_javascript / run_python 写最小用例验证问题确实存在、修改确实有效。
5. 最后按“必须改 / 建议改 / 可选”汇总。不要为了凑数挑风格问题。
`)
  },
  {
    title: '数据分析',
    text: md('data-analysis', '分析 Excel / CSV 数据：清洗、统计、找出趋势与异常，并输出带结论的报告。用户上传表格并要求分析时使用。', `
# 数据分析

## 步骤
1. read_file 读表格，先说明：行数、列名、每列类型、缺失值情况。
2. 用 run_python（pandas 可用）做计算，不要心算：
   - 描述统计（均值、中位数、分位数）
   - 分组对比、时间趋势（按月 / 周）
   - 异常值（超出 1.5 倍四分位距）及可能原因
3. 结论先行：先写 3 条最重要的发现（每条带数字），再写细节。
4. 需要图表时，用 Python 生成 HTML（内嵌 SVG 或表格）写入工作区并 preview。
5. 用户需要文件时，用 create_document 生成 xlsx（处理后的数据）或 docx（报告）。
6. 说明口径与局限（样本量、缺失数据的处理方式）。
`)
  },
  {
    title: '中英润色',
    text: md('polish-translate', '中英互译与文字润色：保持原意，让译文地道、符合场合（商务邮件、论文、产品文案）。用户说“翻译 / 润色 / 改得更地道”时使用。', `
# 中英润色

## 规则
1. 先判断场合（商务、学术、营销、日常）和读者，再选择用词与语气；不确定就问。
2. 翻译：意译优先，术语保持一致；人名、品牌、专有名词保留原文或用通行译名。
3. 润色：保留作者的观点和结构，只改表达；不要加原文没有的内容。
4. 输出：
   - 修改后的全文
   - 主要修改说明（最多 5 条，“原文 → 修改 → 原因”）
5. 学术文本保持被动语态与客观语气；营销文案可以更有节奏感，但不夸大。
`)
  }
];

export const GITHUB_SKILLS = [
  { title: '前端设计', name: 'frontend-design', url: 'https://github.com/anthropics/skills/tree/main/skills/frontend-design', desc: '做网页时给出有辨识度的视觉方向、字体与配色，避免模板感' },
  { title: '文档协作写作', name: 'doc-coauthoring', url: 'https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring', desc: '和你一起分阶段写方案、提案、技术文档' },
  { title: '内部沟通', name: 'internal-comms', url: 'https://github.com/anthropics/skills/tree/main/skills/internal-comms', desc: '写状态更新、公告、FAQ 等内部沟通材料' },
  { title: '主题配色工厂', name: 'theme-factory', url: 'https://github.com/anthropics/skills/tree/main/skills/theme-factory', desc: '给文档、幻灯片、网页套用成套的配色与字体主题' },
  { title: '算法艺术', name: 'algorithmic-art', url: 'https://github.com/anthropics/skills/tree/main/skills/algorithmic-art', desc: '用代码生成可交互的生成艺术作品' },
  { title: '技能创建器', name: 'skill-creator', url: 'https://github.com/anthropics/skills/tree/main/skills/skill-creator', desc: '教它帮你写新的技能（SKILL.md）' }
];
