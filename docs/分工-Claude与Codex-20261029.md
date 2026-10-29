# Claude / Codex 分工（2026-10-29，用户确认：难的 Claude 做，其余 Codex 做）

动手前照旧：fetch 并 merge `claude/jolly-darwin-tijh97`，读 `docs/已修问题清单-不许回退.md`。
**只改自己名下的文件**；要动对方名下的文件，先在本文件“协调记录”里写一行再动，不整文件覆盖。
发版：用户说过“所有计划完成后再统一发版”，最后一项“统一发布”两边都完成后再做。期间只用 `[skip ci]` 保存。

## Claude 负责（判断多、牵扯面广的 4 项）

| 事项 | 要做到什么 | 主要文件（Claude 名下） |
|---|---|---|
| 1. 架构图收尾 | 普通请求用真实模型稳定出图、分层合理、关系准确、接近参考图质量；可编辑 PPT 一致交付。2026-10-29 已改为直接 `create_diagram`，用真实招标文件出图成功，但**真实模型自己填的效果还没验收** | `diagramPlanning.js`、`diagramTool.js`、`diagramModel.js`、`diagramSections.js`、`diagramScene.js`、`architectureDirector.js`（只改入口）、`tests/architectureRouting.test.js` |
| 2. 文章与对话表达 | 有角色、有温度、通俗自然，少重复免责；健康 / 体检 / 产检这类先安抚再解释；用真实文章和多轮对话评审 | `agent.js` 系统提示的“回答的样子”“写文档”两节、`dialoguePolicy.js`、`writingRoles.js`、`reviewOutcome.js`、`retrievalQuality.js` 里的收尾话术 |
| 3. 历史记忆与统计 | 完整找回历史操作；歌曲总数等按真实记录统计；推荐 → 买入 → 更正成本 → 次日盈亏连续衔接 | `memory*.js`、`periodReview.js`、`sessionWork.js`、新的持仓 / 统计模块 |
| 4. 云端提醒 | 持久化调度、服务器重启恢复、修改 / 取消、防重复执行、手机通知 | `scheduler.js`、`scheduledRun.js`、`server/` 里调度相关、手机通知 |

## Codex 负责（其余全部）

| 事项 | 还欠什么 |
|---|---|
| Word 排版 | 字体字号偏好真正落到文件；分页、内容长度与指定页数自动协调 |
| PPT、Excel 样式 | 多种风格，按内容安排版式，不总是一种模板 |
| 识图 | 数字和对象识别准确率；读数冲突独立复核；长对话追问保留正确原图 |
| 股票行情 | 已知代码优先走行情工具，失败自动换源，日期和口径一致（**和 Claude 第 3 项的持仓盈亏衔接：行情工具接口由 Codex 定，Claude 只调用**） |
| 足球与技能 | 补回被隐藏场次，区分全天剩余与未来一小时；技能修改后确认实际安装版本和运行效果 |
| 不同类型制图分流 | 普通图片、数据图表、流程图、思维导图、UI 原型各选合适工具（**架构图那一支归 Claude**，分流入口改动先在协调记录里说） |
| 图文与旧格式 | 海报不漏正文、换版不改事实；新闻证据跨制作保留；Mermaid 读取和渲染。（`.doc` 后缀的新版 Word 已由 Claude 修好；真老 .doc 转换如要做归 Codex） |
| 搜索与长任务体验 | 汇总模型等待 / 搜索 / 读取 / 生成各阶段耗时；失败只汇总一次并说明下一步 |
| 唱歌与声音 | 真实接口参数、国内连通、下载播放、本机和云端 Key 全流程；声音目录可选性 |
| 手机控制、代码能力 | 跨 App 控制落地；代码任务生成 → 运行 → 修错的工程验收 |
| UI、工作区与真机 | 文件多了以后的查找管理；全部页面巡检；图标、启动动画、常亮、浏览器、通知真机确认 |
| WebGL 启动恢复门禁、HUD 间歇失败 | 查清原因并修，不放宽阈值（Claude 机器上 WebGL 恢复偶发 333/300ms） |
| 30 题综合复测 | 最新候选版、当前服务商模型完整跑 30 题，核答案、耗时和实际文件质量（等两边主要事项都完成后做） |

## 统一发布（最后一起做）
两边事项都完成后：整理未发布代码、完整回归、真实验收、安卓与 Windows 打包及下载包核验。由最后完成的一方执行，另一方在协调记录里确认。

## 当前发版状态
2026-10-29 用户要求“一起发版”，Claude 已手动触发一次（含 Claude 的架构图新路线 + Codex 1.0.319 之后的 23 个提交）。结果看 GitHub Actions；以后的发布按上面“统一发布”。

## 协调记录
- 2026-10-29 浏览器发现本批仓库链接整段缓冲阻断普通进度，6d715eb改为单独有界流式过滤；agent.js仅接逐片段过滤，不动其他强约束/原停止续做e2e断言，新增逐字符与所有分块守护。
- 2026-10-29 交付守护补接agent.js：仅在仓库写入后的最终回答审查处，将仍未核实的当前任务GitHub链接改成原副本文件说明，再按原约束复核；不丢整段有用答复、不改架构/表达提示、原返修次数和其他门槛。
- 2026-10-29 PC服务器误分流已用原话复现：`不要删除…锁文件`匹配router的APP_ACTION，turnInputs将仓库续做留本机。仅给computerTaskKind增加服务器仓库上下文选项，turnInputs传开关；明确本机路径/桌面/GUI仍优先，普通文档/电脑控制保持。新纯判断模块与原PC控制守护一起测；不扩大普通代码预算。
- 2026-10-29 同批收尾接缝：agentCompletion.js只向reviewOutcome传最终回答，用于结构化红色基线+无写入+明确拒绝删测/只读诊断的提示分类；不动一分钟MORE_TIME_ASK或Claude结尾提示。原失败回执不删，普通修错/失败lint/安装失败仍报错。
- 2026-10-29 Codex 本批修复（用户已确认，追加PC服务器续做反馈）：验收本地证据先落盘、远端核对独立计状态、缺项不冒充事实失败，新增原副本只读补验，不调模型、不改原报告、不发版。服务器续做先用真实同会话索引；taskRunner.mjs仅接完成任务的codeTaskId/索引恢复，不重放旧计划、不改表达/架构/提醒。executionReview.js仅接诊断型测试/明确拒绝删测且无写入的收尾分类，普通失败测试、修改后缺测试继续拦。涉及Claude模块已在此先记录。
- 2026-10-29 Codex 真实模型验收批（用户已确认）：仅补 evals 的三轮串行修错、删测试请求、失效令牌与离线执行反例及证据汇总，沿用已有模型路由和生产代码；正式配置只读、无提交/推送/发布能力。当前云端无服务器登录连接，d.leing.top 状态接口503，不能冒充用户服务器已验；先完成可执行入口和本地真实Docker/HTTP反例，再提供服务器命令。不动Claude Word/PPT/架构/表达模块。
- 2026-10-29 Codex 第4.5批验收接入：既有jarvis-unit.yml增加手动skill_only只测试入口，跑完整单测、固定运行时、真实Archify+Chromium/普通技能/取消回归与原smoke，不自动打包发布，原unit/P7/WebGL入口保留。部署只补可选Dockerfile.browser及setup选装入口（Archify完整finalize需要浏览器），不把构建/仅HTML成功说成浏览器门禁成功；原非root/只读/资源限制不变。
- 2026-10-29 Codex 第4.5批（用户已确认）：仅扩展server/skillRunner.mjs及新增独立技能附件准备/构建模块，安装文件内容哈希缓存、隔离副本装开发依赖并生成、运行只读挂载；补Archify真实HTML和无构建技能/普通架构路线守护。现有prepareSource跳过在线附件、依赖识别忽略devDependencies，会同时造成缺入口/校验模块。不会改agent.js架构分流、diagramPlanning/Tool/Repair、原PPT/视觉门槛，不发版、不开始真实模型验收；必要部署/测试CI仅接本批隔离技能测试，先在此记录。
- 2026-10-29 Codex P7收尾补核：本地原smoke出现恢复总耗时1690ms（app75ms、浏览器恢复事件前1610ms）；保留失败，不改WebGL/原测试/阈值。手动p7_only任务补跑原smoke作独立环境核验，使用原300/1500ms门槛，不自动重试、不取最好值；不触发发版。
- 2026-10-29 Codex P7测试接入：jarvis-desktop.yml仅在现有code-repos后追加code-work浏览器回归；jarvis-unit.yml追加手动p7_only只测试入口（contents:read，无打包/发布），原unit与WebGL默认逻辑保留。新增固定运行时的离线准备/入口加载验证，CI不调用真实模型或测试仓库API。
- 2026-10-29 Codex P7收尾（用户确认）：补真实浏览器技能/路由/预算/副本续做/带图回归、固定源码清单及评测预检。发现技能页停用仅本机生效，拟在serverMode、serverClient和skillsPanel增加鉴权的显式启停同步，停用/卸载不自动恢复；仅此接缝，不动Claude表达/架构/提醒/持仓。必要的测试入口接入CI前先在此记录；所有提交及合并[skip ci]，不发版，不发起真实模型验收。
- 2026-10-29 Codex最终交接（用户明确要求）：源码8d4c724三次CI原smoke174/174+新恢复20/20全部通过；本地正常构建原smoke174/174、新恢复19/20（一次total1600ms），发布门禁保留，不继续扩大修改。交接见《交接给Claude-WebGL剩余门禁与P7暂存-20261029.md》，逐次指标另存验收数据；P7暂存52f6b2e已另推codex/p7-hold-20261029供Claude读取，不合入、不发版。
- 2026-10-29 Codex WebGL后段补测：恢复期间GL驱动同步等待仍有峰值；重新单独验证粒子颜色的等价顶点计算（不改点数、点尺寸、透明度、背景或画质），以固定帧RGBA逐像素对照守住视觉；仅有改进且20次全部过才保留。
- 2026-10-29 Codex WebGL定位：新增8工具真实UI前置暴露额外卡顿；分组关闭滤镜确认工作台纯白不透明顶栏/输入框仍运行backdrop-filter，白色遮盖后模糊无可见贡献。仅在body.workbench下关闭这两处背景滤镜，保留半透明舞台标注的原模糊、粒子/分辨率/FPS及门槛；撤回无证据的HUD合成层和恢复期JS冻结。完成后按用户最新指示接P7，先交Claude互审。

- 2026-10-29 Codex WebGL补充：callouts.js只加布局输入/按钮高度未变的跳过，styles.css只在真实上下文丢失到三帧真实绘制完成之间暂停舞台HUD/引线CSS动画，节点仍显示，恢复后自动继续；不改主题/字号/形象/普通动效。软件缓冲/颜色计算实验逐像素相同但未稳定消除总耗时失败，撤回这两项，不混入最终方案。
- 2026-10-29 Codex WebGL定位补充：暂停WebGL后GPU仍繁忙；orbitHud.layout每33ms无条件replaceChildren重建最多8个卫星并重写三处相同textContent，恢复期间也继续。仅改orbitHud的输入不变跳过和有界节点复用，外观/刷新目标保持，防止重复DOM绘制争用恢复。先做对照，不把推测当已验证根因。
- 2026-10-29 Codex WebGL批（用户确认开始）：先用临时计时完成原smoke前置后20次采样，保留原失败行、P50/P95/最大值；只按证据改render/stage.js恢复调度及无效resize，画质/N/像素上限和300ms/1500ms门槛保持。拟在jarvis-unit.yml增加手动只测WebGL选项（contents:read、无发布job），原单测入口保持，不动jarvis-desktop发版工作流。完成后交Claude审再接P7；所有提交[skip ci]。
- 2026-10-29 Codex P7补充：toolLoader只增加可选常驻集合（默认CORE不变），仓库开发常驻8个代码工具及少量审查/技能入口；lookupDeadline只对服务器实际开启的代码工作模式绕过普通查询60秒限制，原MORE_TIME_ASK及收尾话术保持。
- 2026-10-29 Codex P7（用户已确认）：补独立代码开发技能及有界代码任务预算，沿用现有code能力路由/固定模型设置；taskRunner与agent.js只增加可选工作模式、硬步数上限和总期限，不动Claude表达/架构/提醒/持仓。codeRepos增加真实会话内的有界工作副本恢复索引；旧projectExecution改为数据目录共享暂存并修umask 077。skillCatalog只加入新技能，保留停用/卸载语义。验收不读sandbox隐藏答案、不推测试仓库；只提交[skip ci]，不发版。
（要动对方名下文件时在这里写：日期、谁、改哪个文件、为什么）
- 2026-10-29 Codex P2已完成编辑与Docker测试：虚构项目真实红→绿/原测试与main不变、真实npm包离线安装、运行中取消及输出上限通过。全量2030、最终91定向、三构建及其余界面通过；smoke 173/174，旧P1 ef78099独立对照也173/174（同一WebGL恢复项）。未改/放宽GL门禁，保留为发版阻塞；只[skip ci]保存，不发版。详见《代码智能体-P2验收与后续计划-20261029.md》，P7/续做索引/旧执行器共享目录及真实模型验收待用户下一批确认。
- 2026-10-29 Codex P2收尾显示：reviewOutcome.js只在工具名表增加code_edit/write/run中文名，不动收尾提示、partial判断或Claude已修话术；部署说明补可选代码沙箱配置，保留原PrivateTmp防护。
- 2026-10-29 Codex P2验收接入：executionReview只补仓库ID/命令隔离的代码回执，防止lint冒充测试或改后沿用旧测试；agent.js仅接入execution_capabilities/运行记录/收尾工具名，不改系统提示表达段、架构路由、步数或P7模型工作方式。
- 2026-10-29 Codex P2界面接入：transcript.js只补八个代码工具的中文名，formDirector.js只把code_edit/write/run映射到原格栅形态；不改Claude通知、失败步骤或表达逻辑。
- 2026-10-29 Codex P2：用户已确认下一步。新增独立文件写入/快照/npm依赖检查/Docker隔离执行模块；在serverMode配置沙箱、taskRunner显式开放code_edit/write/run，设置页只更新能力说明。修改仅任务worktree；安装脚本禁用，依赖受控下载后离线npm ci，lint/test断网，不挂Git目录/凭据/宿主工作副本为可写。不动架构/表达/提醒/持仓，不推测试仓库，不合并、不发版。
- 2026-10-29 Codex P1收尾：GitHub独立设置/每任务worktree/五项只读工具完成，配置剥离覆盖模型/PC辅助/搜索；249文件2013单测、三构建及原界面回归通过，真实公开sandbox只读验收main不变。无编辑/运行/推送工具、无发版；下一批P2清单见《代码智能体-P1验收与P2计划-20261029.md》，等待用户逐批确认。
- 2026-10-29 Codex：用户已确认代码智能体P1，仅GitHub连接/只读工具。将少量接入serverMode.mjs（独立配置路由及GitHub凭据脱敏）、taskRunner.mjs（注入五项只读工具，模型配置剥离仓库凭据）、serverClient/serverPanel设置入口。新模块承载Git执行、仓库副本与文件边界；不改Claude架构/表达/持仓/提醒，不开放代码执行、推送、PR或合并。每任务工作副本、服务器凭据0600、输出有界，补真实本地Git及API/UI测试。
- 2026-10-29 Codex：PPT批真实文件及冻结验证通过，Excel另开批。只在xlsxWriter外加风格规则、生成/专业工作流sheet_style传递和可选恢复字段；不移动原行列、不改公式/数值/打印范围计算、不改writingRoles。样式要求解析提取为共用纯函数，保留PPT全部守护；不动Claude模块。
- 2026-10-29 Codex：PPT批只补风格要求解析/历史PPT偏好、专业文档style入参和恢复传递，回执按实际风格写；documentWorkflow仅增加可选style持久化，不改角色、表达、业务审查、调用预算或writingRoles.js。已有四种渲染构图和公文主题规则保持，用虚构同稿输出原生PPT/PDF作对比。
- 2026-10-29 Codex：足球/技能批次需改`src/agent/tools.js`中install_skill回执及安装后读回，给出真实安装批次、声明版本、启停状态，并区分安装/读取/执行；不动定时任务、持仓工具、CORE或Claude话术。skillPacks只加安装身份元数据，原权限/停用保持。
- 2026-10-29 Codex：已从acc71aa按用户调整开工，Word→股票行情接口→足球/技能→PPT→Excel。Word只改文档生成/样式/交付模块；FFmpeg补部署及svgRaster缺失诊断，不改Claude CI、holdings.js、架构分支或一分钟收尾。过程见`docs/Codex推进记录-20261029.md`；每批[skip ci]，不触发发布。
- 2026-10-29 Codex：行情工具仍叫get_stock_kline，新增顶层latestClose/previousClose/priceDate/previousPriceDate，给holding_profit映射price/prevClose/priceDate；必须同来源、同复权，现金成本用none，缺项为null。未改holdings.js或Claude上下文。字段、盘中/历史边界和真源检查见`docs/行情工具接口-Codex与Claude-20261029.md`，请Claude据此衔接。
- 2026-10-29 Claude：云端提醒改了 `src/agent/tools.js`（只动定时任务那几个工具，加 update_schedule）、`src/agent/skillCatalog.js`（定时任务技能说明）、`src/ui/transcript.js` / `src/core/formDirector.js`（各加一个工具名）、`server/taskRunner.mjs`（SERVER_BLOCKED 去掉定时工具、ctx 加 scheduleHost）、`server/serverMode.mjs`（定时任务接口）、`src/core/serverClient.js`（定时任务方法）。
- 2026-10-29 Claude：持仓链路新增 `src/agent/holdings.js`，在 `src/agent/tools.js` 加三个持仓工具、`toolLoader.js` CORE 加工具名、`agent.js` buildContext 加持仓段。只调用 Codex 的 get_stock_kline，没改行情代码。CI 工作流在单元测试前加装 ffmpeg（Codex 的 svgRaster 测试需要）。

## Claude 名下进度（2026-10-29 晚）
- 表达与情感：已做（提示与收尾话术，有测试）；真实模型多轮效果未验收。
- 云端提醒：已做（服务器按时执行、重启恢复、防重复、修改 / 暂停、北京时间、手机取通知）；App 被彻底关掉时没有即时推送；华为真机未验。
- 历史记忆与统计：持仓链路已做；歌曲等成果统计沿用 Codex 的成果索引（workLedger），旧记录只能说“至少”。
- 架构图收尾：需要用户服务器上的真实模型实测，等用户更新后反馈。
- 2026-10-29 Claude：表达改造动了 Codex 名下的 `src/agent/answerRequirements.js`（加 deferralCount 与健康回答转介话术检查、answerConstraints 返回 care）和 `src/agent/executionReview.js`（guardsAnswer 加 rules.care 一项），以及 `src/app/turn.js` / `turnEvents.js`（保存失败步骤）；原有逻辑和测试未改。
