# Gemini 接手未央

本次交接聚焦 **1.0.472 的手机和电脑工作台**。用户希望看着小未央在房间里工作，点桌上的显示器读一条新闻，接着说“把这条做成简报”，看电视时也能继续聊天。下一步请优先复核这条使用路径，并给出能复现的问题和仍需要设备或授权的事项。

## 从哪个版本开始

| 用途 | 版本或提交 |
| --- | --- |
| 用户可下载的 Windows、安卓和服务器版 | `desktop-v1.0.472`，2026 年 11 月 20 日北京时间 19:20 发布 |
| 还原发行包的源码 | 功能提交 `aa5838b`，发布构建提交 `d7f3e2f` |
| 接续开发和复验 | 分支 `claude/jolly-darwin-tijh97`。发布后提交 `c718315` 记录了验收结果，并给工作台长测固定了设备时间 |

源码和安装包分属两个仓库。工程入口在源码仓的 `jarvis/` 下。开始修改前请读项目已有的开发约定和回归清单。[源码差异](https://github.com/xunova1121/-/compare/4f0265b...d7f3e2f) · [开发约定](CLAUDE.md) · [已修问题清单](docs/已修问题清单-不许回退.md) · [正式版下载](https://github.com/xunova1121/weiyang-release/releases/tag/desktop-v1.0.472)

## 优先复核的三条路径

1. **显示器上的新闻能否跟进到同一段对话。** 打开工作台的显示器，选中报道 A，问“这条对我有什么影响”。回答进行中切到报道 B，点“生成简报”，再翻到另一条。首问应携带 A 的原文，排队任务应携带 B 的原文。打开生成的 Word，核对正文和来源。切换会话后，上一段会话选中的报道也应清除。
2. **电视能否换台、关闭并释放播放。** 可选 CCTV-1 综合、CCTV-2 财经、CCTV-9 纪录和 CCTV-13 新闻。选台后退出再进，应记住频道。默认按钮打开央视官网，纪录频道的官方路径是 `/live/cctvjilu/`。取得许可的部署方可通过 `JARVIS_CCTV_PLAYERS` 配置对应频道的内嵌播放器。请把官网能打开、受控视频能解码和真实授权节目能播放分别记录。[部署说明](jarvis/deploy/服务器部署说明.md)
3. **打开新闻、电视或手机键盘后，房间和聊天是否还能用。** 在房间里点实体台灯、咖啡杯和沙发，再发起真实文件任务，观察人物能否回到对应工位。手机切后台再回来，检查有没有旧频道声音、重复回复或丢失草稿。工作台会按设备当地时间切换活动，复验历史任务的书写动作时，选中实际的“写入文件”记录。

## 去哪里查

| 现象 | 先看的文件（相对 `jarvis/`） |
| --- | --- |
| 新闻没刷新、离线误显为最新 | `src/core/workshopNews.js`、`src/core/workshopNewsSource.js`、`server/workshopNews.mjs`。主源为央视网，备用源为中新网，界面保留原文和上次更新时间 |
| “这条”串到另一篇、队列或简报引用错误 | `src/app/workshopNewsChat.js`、`src/core/workshopNewsReference.js`、`src/app/turn.js` |
| 频道入口有误、关电视后声音仍在 | `shared/workshopTv.js`、`src/ui/workshopTvPlayer.js`、`src/ui/workshopMedia.js` |
| 新闻面板遮住小人、点不到家具或输入框 | `src/ui/workshopMedia.css`、`src/ui/workStudioView.js`、`src/ui/mobileWorkStudio.js`、`src/ui/workshopRoom.js` |

## 如何复验

在已装好项目依赖、Chromium 和 FFmpeg 的开发环境，从源码仓根目录运行以下命令。浏览器专项启动临时网关，使用受控新闻、模型和视频，实际生成并打开 DOCX。新环境可按正式流水线安装依赖。[发布流水线与环境](https://github.com/xunova1121/-/actions/runs/44722505171)

```sh
cd jarvis
npx vitest run tests/workshopNews.test.js tests/workshopNewsChat.test.js tests/workshopTv.test.js tests/workshopMediaChannels.test.js
npm run build
npm run build:mobile
node e2e/workshop-media.mjs
node e2e/workbench-action-studio.mjs
```

## 已有证据和待办

- 正式流水线通过 4,559 项单测、174 项桌面检查和 14 项单文件检查。公开下载的 APK 和服务器包内网页已在浏览器中完成选台、追问、排队和 Word 正文读回。七份下载附件和更新索引做过 51 项核验。真实联网另行验证过央视网和中新网的标题、发布时间与原文入口。[发布验收记录](docs/分工-Claude与Codex-20261029.md#10472-工作台新闻与电视)
- **真机优先。** 下一项是安卓真机切后台、横竖屏及软键盘复验，以及 Windows 安装版实测。用户服务器的实际升级状态待确认。真实央视节目内嵌验收需要部署方提供已获授权的频道地址。
- 本地重复单测在正式流水线全绿后停止，三份超时用例独立复核 49/49。经典 WebGL 预览在本机两次桌面整套测试中超过 1.5 秒，单项复测为 1,307 毫秒，正式桌面回归通过。复现时请记录设备、渲染方式及耗时。

请用中文回报复核结果。每个问题写明设备或运行方式、复现步骤、实际现象和对应证据，并区分这次亲自验证的结果与上面的发布记录。
