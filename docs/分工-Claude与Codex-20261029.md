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
（要动对方名下文件时在这里写：日期、谁、改哪个文件、为什么）
- 2026-10-29 Codex：已从acc71aa按用户调整开工，Word→股票行情接口→足球/技能→PPT→Excel。Word只改文档生成/样式/交付模块；FFmpeg补部署及svgRaster缺失诊断，不改Claude CI、holdings.js、架构分支或一分钟收尾。过程见`docs/Codex推进记录-20261029.md`；每批[skip ci]，不触发发布。
- 2026-10-29 Claude：云端提醒改了 `src/agent/tools.js`（只动定时任务那几个工具，加 update_schedule）、`src/agent/skillCatalog.js`（定时任务技能说明）、`src/ui/transcript.js` / `src/core/formDirector.js`（各加一个工具名）、`server/taskRunner.mjs`（SERVER_BLOCKED 去掉定时工具、ctx 加 scheduleHost）、`server/serverMode.mjs`（定时任务接口）、`src/core/serverClient.js`（定时任务方法）。
- 2026-10-29 Claude：持仓链路新增 `src/agent/holdings.js`，在 `src/agent/tools.js` 加三个持仓工具、`toolLoader.js` CORE 加工具名、`agent.js` buildContext 加持仓段。只调用 Codex 的 get_stock_kline，没改行情代码。CI 工作流在单元测试前加装 ffmpeg（Codex 的 svgRaster 测试需要）。

## Claude 名下进度（2026-10-29 晚）
- 表达与情感：已做（提示与收尾话术，有测试）；真实模型多轮效果未验收。
- 云端提醒：已做（服务器按时执行、重启恢复、防重复、修改 / 暂停、北京时间、手机取通知）；App 被彻底关掉时没有即时推送；华为真机未验。
- 历史记忆与统计：持仓链路已做；歌曲等成果统计沿用 Codex 的成果索引（workLedger），旧记录只能说“至少”。
- 架构图收尾：需要用户服务器上的真实模型实测，等用户更新后反馈。
