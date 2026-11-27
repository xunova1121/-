# Claude 1.0.460 发布记录（2026-11-17）

## 本版内容
- 对话导出修复（服务器模式 404）、电脑端导出菜单；海报图文融合、历史稿只列以前交付的成品（1.0.459 已含）。
- 流程图工具 create_flowchart：flow/swimlane/mindmap/tree/org/state/steps/loop；连线规则借鉴 diagram-design（MIT，只借思路）。
- 图表工具 create_chart：26 种（数据图表、甘特/时间轴、看板/矩阵/旅程/蓝图/故事地图/分层/嵌套、时序/ER/UML/鱼骨）。
- 画图请求调对工具；架构图工具分工说明，严格流程内部步骤标注。
- 海报：配图 keep_clear 留字位并像素核对；新自由稿必须写构思；≥3个百分比要求图表；自审加“AI味”与模板化判断；回答链接名与实际文件一致。
- Word 默认清爽版（公文红头红线保留）。
- 引导：送达即回执；收尾时才送到的引导由服务器接着开一轮处理。
- 通读全文 digest_document；打开压缩包 open_archive；文档上限对齐 50MB。

## 验证
- 本机：4308 项单测、代码检查通过；发布门禁 34 项通过，唯一失败为本机浏览器版本导致的 music-card 下载文件名（已知环境问题），该步其余 350 项单独跑通过。
- CI：run 44082072381（54ab1b6）全部作业成功。
- 发布核验：公开仓库 APK versionCode 460、包名 com.xunova.jarvis、v2 签名证书 56e3579b…363d6 与原签名一致；服务器包 1191 项全部 root 属主、全员可读，含本批新模块；Windows 安装包可下载；latest.yml 与 jarvis-server-latest.json 均为 1.0.460。

## 未验收
真实模型的构思/选图/通读质量与耗时、生图留白服从性、真实中文压缩包与大标书、用户原稿、安卓/Windows 真机、用户服务器实际更新。

## 1.0.461（2026-11-18）
- 新增：海报 AI 整图出稿 + 逐字核对（`aiPoster.js`，`make_poster.ai_full`）。
- 修复：交付说法对不上不再整段吞掉回答（自动改链接名、附核对提示）；甘特图支持精确到分钟。
- 验证：本机 4319 项单测、代码检查通过；门禁 34 步通过，唯一失败为已知 music-card 本机环境问题，该步其余 350 项通过。CI run 44192840448（5404a28）全部成功。APK versionCode 461、签名证书 56e3579b…363d6 与原签名一致；服务器包 1192 项 root 属主全员可读、含 aiPoster.js；Windows 安装包可下载；双 latest 为 1.0.461。
- 未验收：真实画图模型中文写字准确率、重画次数与费用。

## 1.0.462（2026-11-18）
- 版式模板海报六套（`posterTemplates.js`，`make_poster.template`）；沉浸式图文融合（`layout:'immersive'`）与先排版后生图（`template.image_prompt`，`posterTemplateArt.js`）。
- 1.0.461 实测修复：交付说法只改链接不让模型重写；收尾后的自言自语不显示；纯色底字自动换色；设计自审最多一轮；遮罩选色按 0.179 亮度分界（橙字不再配白遮罩）。
- 安卓返回键 / 侧滑逐层返回（`src/mobile/backNavigation.js`），首页二次确认才退到后台。
- 验证：lint 通过；单元测试 4349 全过；本机门禁 34 过 1 失败（已知本机浏览器差异 e2e/music-card.mjs:85），手机步骤其余部分单独跑 350 ✓。
- 发布：run 44213095094（f3a15ed）。安卓打包第一次在装系统包（ffmpeg/中文字体）时镜像下载超时三次、未进入构建，重跑失败任务一次后全部成功。APK versionCode 462、v2 证书 56e3579b…363d6 一致；Windows 安装包 152967396 字节；服务器包 1195 项全部 root 属主、全员可读，sha256 与 jarvis-server-latest.json 一致，含 posterTemplateArt.js 与 backNavigation.js；latest.yml 与服务器清单均为 1.0.462。
- 未验收：真实画图模型的留白遵守情况、安卓手势返回真机、Windows 真机。

## 1.0.463（2026-11-18）
- 沉浸式海报按用户给的豆包样张重排（豆包那张赛程配错/编造/漏掉多场，只学排版）；海报默认一张底图+程序排字、海报工具含图库搜图、生图要求改为铺满画面；过大配图缩小再嵌入（`layeredDesignAssetSize.js`）；遮罩插在覆盖范围内所有文字之下、按钮上的字交给换色。
- 验证：lint 通过；单元测试 4362 全过；本机门禁 34 过 1 失败（已知 e2e/music-card.mjs:85 本机浏览器差异），手机步骤其余 350 ✓。
- 发布：run 44231926722（f3b5be1）一次成功。APK versionCode 463、v2 证书 56e3579b…363d6 一致；Windows 安装包 152970811 字节；服务器包 1196 项全 root 属主、全员可读，sha256 与 jarvis-server-latest.json 一致，含 layeredDesignAssetSize.js；latest.yml 与服务器清单均为 1.0.463。
- 未验收：真实图库搜图与真实照片效果；掉线问题待服务器日志确认。

## 1.0.466（2026-11-18）
- 电脑掉线、对话全没了：`src/ui/historyList.js` 读不到列表保留旧列表；左栏连服务器 30 秒刷新、本机 3 秒；`server/serverMode.mjs` 写 `data/tasks-busy`，`deploy/update.sh` 等任务做完再安装（最多 15 分钟）。用户服务器日志：当天 07:28/10:39/12:10 三次重启为“立即更新”触发的安装，14:30/14:32 为手动重启，无内存崩溃记录。
- 本机门禁第一次发现左栏一律 30 秒导致 `e2e/pc-agent-navigation.mjs` 超时，改为按是否连服务器决定频率后 62/62 通过；第二次门禁 34 过 1 失败（已知 music-card 本机差异），手机其余 350 ✓；单元测试 4379 全过。
- 发布：run 44282533593（5a549b2）一次成功。APK versionCode 466、v2 证书 56e3579b…363d6 一致；Windows 安装包 152978042 字节；服务器包 1197 项全 root 属主、全员可读，sha256 与清单一致，含 historyList.js 和带 tasks-busy 等待的 update.sh；两个更新入口均为 1.0.466。
