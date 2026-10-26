# Claude → Codex 对接（2026-10-26 北京时间 21:50，Claude 额度用完前）

先按 `AGENTS.md` 顺序读：`CLAUDE.md` → `docs/已修问题清单-不许回退.md` → `docs/代码规范.md`。动手前 fetch 并 merge `claude/jolly-darwin-tijh97`。

## 一、正在进行：发版 run #293（第一件事先看它）
- 工作流：https://github.com/xunova1121/-/actions/runs/40330166593 ，源码 `05a0e2d`，预计版本 1.0.293。
- 内容：你的架构图四步（`codex/diagram-design-loop-20261026`，已快进合入）＋ Claude 今天的修复（见第二节）。
- **上一次 #292 被取消**：卡在“安装Office真实渲染环境”（apt 下载卡住，16 分钟超时），与代码无关，所以 1.0.292 没发出去。
- 如果 #293 又卡在同一步或失败：先看日志，确认是 apt / 网络卡住就对同一工作流点 Run workflow 重跑（不要改松门禁）；是测试失败就按防回退清单修。
- 成功后告诉用户：先“立即更新服务器”，再更新手机 / 电脑；然后用长江禁捕的招标文件让未央重画“项目总体架构图”，和上午 GPT 那张对比（图在用户手里，不要提交进公开仓库）。

## 二、Claude 今天做完的（都已在正式分支，已进防回退清单）
| 改动 | 文件 | 测试 |
|---|---|---|
| 文档写作角色：售前 / 解决方案 / 法务 / 实施 / 项目经理，按原话识别，撰稿 / 推演 / 审查 / 修订都带角色；对外文档推辞话术程序计数，超标自动返修（1.0.291 已发） | `src/app/doc/writingRoles.js` 及 documentWorkflow / contentReview / taskBrief / targetedRevision | `tests/writingRoles.test.js` |
| 画架构图 / 流程图 / 示意图 / 拓扑图 / 海报按长任务算预算（用户 21:08 实测 `create_diagram` 报“模型调用预算限制”没出图） | `src/agent/retrievalBudget.js` | `tests/retrievalBudget.test.js` |
| 贴进来的长文（交接记录）不再被当成要算数（回答末尾“关键数值尚未完成工具校验”） | `src/agent/taskContract.js` | `tests/calculationGate.test.js` |
| 海报 / 信息卡 SVG 放行 filter、feDropShadow、mask、pattern 等静态效果；报错要求“不要为了转换改原文件”。**行内 style 仍按你原来的规则拒绝，原测试没改** | `src/agent/svgPreview.js` | `tests/diagramQuality.test.js` |
| 你报告的 smoke 失败已查明：人脸那步是缺 `public/models/face_landmarker.task`（postinstall 下载），补上后你的分支 smoke 174/174；单文件 14/14。WebGL 恢复计时偶发超线（Claude 机器 333/300ms），没放宽 | — | — |

## 三、待做（按用户反馈的优先级；动手前先列清单给用户确认）
1. **架构图实测效果**：用户 21:13 那张是旧程序画的（服务器还是 1.0.291）。#293 发出后等用户实测反馈，再按“和 GPT 那张对比”继续调。原生可编辑 PPT 对照差超线（2.87% > 1.2%）仍如实拦下，不调阈值。
2. **看图模型**：用户还没配视觉模型，所以 `visual: not_checked`，“画完自查”实际没看图。提醒用户在“模型”里给“看图”配（如百炼 qwen-vl）。
3. **技能精准匹配**（用户之前提过，未做）：系统提示里技能目录只放一句话描述、同一仓库合并一组、按问题挑最相关几个（装了 sports-skills 后每轮约 1.8 万字英文描述）。
4. **装仓库地址先勾选**：粘仓库首页会一次装进几十个技能，改成先列出让用户勾选。
5. 写作角色的真实效果：用户还没用真实模型重写那份“海洋渔业卫星组网”方案验证；如反馈仍有推辞，调 `writingRoles.js` 的写法和阈值（`hedgeIssue`）。
6. 直播吧接口不带联赛名（你已改为“不按队名猜联赛”）；如找到带联赛名的国内来源可补。

## 四、用户环境提醒
- 服务器 https://d.leing.top（腾讯云 OpenCloudOS + 宝塔，systemd 服务 jarvis）；技能运行器（Docker）已装好。**不要碰服务器密码**。
- 用户服务器 SSH 被大量扫密码（500+ 次失败），已提醒用户在安全组限制 22 端口。
- 用户在宝塔手机 App 终端粘多行命令会被拼成一行、吞掉换行；给命令时尽量写成单行。
