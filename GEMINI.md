# Gemini 接手未央

本次交接聚焦 **1.0.473 的手机和电脑工作台**。用户希望看着小未央在房间里工作，点桌上的显示器在房间里读原文，接着说“把这条做成简报”，点电视后让节目占工作台一多半，看电视时也能继续聊天。下一步请优先复核这条使用路径，并给出能复现的问题和仍需要设备或授权的事项。

## 从哪个版本开始

| 用途 | 版本或提交 |
| --- | --- |
| 用户可下载的 Windows、安卓和服务器版 | `desktop-v1.0.473`，2026-11-20 北京时间 21:35公开发布 |
| 还原发行包的源码 | 功能提交 `11bbbe1`，发布构建提交 `acebc91` |
| 接续开发和复验 | 分支 `claude/jolly-darwin-tijh97`。从远端取这个分支后先核对发行版与本次验收记录 |

源码和安装包分属两个仓库。工程入口在源码仓的 `jarvis/` 下。开始修改前请读项目已有的开发约定和回归清单。[源码差异](https://github.com/xunova1121/-/compare/d7f3e2f...acebc91) · [开发约定](CLAUDE.md) · [已修问题清单](docs/已修问题清单-不许回退.md) · [正式版下载](https://github.com/xunova1121/weiyang-release/releases/tag/desktop-v1.0.473)

## 优先复核的三条路径

1. **新闻能否在房间里读完并继续追问。** 打开显示器，点报道 A 的“阅读原文”，正文应显示在当前蒙层。来源暂时不可读时，应能原地重试。翻到 B 后，A 的正文应消失。再分别用 A 追问、用 B 排队生成 Word。聊天请求附上选中报道的标题、来源、发布时间和原文链接，简报任务明确要求阅读核实。核对生成文件中的标题、来源和链接，并复核切换会话后会清除上次选中的报道。
2. **点实体电视后，节目能否直接在机身内放大。** 可选 CCTV-1 综合、CCTV-2 财经、CCTV-9 纪录和 CCTV-13 新闻。部署方通过 `JARVIS_CCTV_PLAYERS` 接入获授权的节目源或嵌入页，支持的直连视频默认静音播放。未接入的频道显示“未央风景短片 · 非频道直播”。“央视网”是用户主动打开的官网入口，纪录频道官网路径是 `/live/cctvjilu/`。检查切台、返回、关机及切后台时旧媒体资源是否释放，重开是否记住频道。请分别记录本地短片、受控媒体和真实授权节目的测试结果。[部署说明](jarvis/deploy/服务器部署说明.md)
3. **打开新闻、电视或手机键盘后，房间和聊天是否还能用。** 在房间里点实体台灯、咖啡杯和沙发，再发起真实文件任务，观察人物能否回到对应工位。手机切后台再回来，检查有没有旧频道声音、重复回复或丢失草稿。工作台会按设备当地时间切换活动，复验历史任务的书写动作时，选中实际的“写入文件”记录。

## 去哪里查

| 现象 | 先看的文件（相对 `jarvis/`） |
| --- | --- |
| 新闻没刷新、离线误显为最新 | `src/core/workshopNews.js`、`src/core/workshopNewsSource.js`、`server/workshopNews.mjs`。主源为央视网，备用源为中新网，界面保留来源及上次更新时间 |
| 原文空白、重试或切篇后显示旧内容 | `src/ui/workshopNewsReader.js`、`src/core/workshopNewsArticle.js`、`server/workshopNews.mjs` |
| “这条”串到另一篇、队列或简报引用错误 | `src/app/workshopNewsChat.js`、`src/core/workshopNewsReference.js`、`src/app/turn.js` |
| 频道入口有误、关电视后声音仍在 | `shared/workshopTv.js`、`src/ui/workshopTvPlayer.js`、`src/ui/workshopMedia.js`、`server/staticVideo.mjs` |
| 新闻面板遮住小人、点不到家具或输入框 | `src/ui/workshopMedia.css`、`src/ui/workStudioView.js`、`src/ui/mobileWorkStudio.js`、`src/ui/workshopRoom.js` |

## 如何复验

在已装好项目依赖、Chromium 和 FFmpeg 的开发环境，从源码仓根目录运行以下命令。浏览器专项启动临时网关，使用受控新闻、模型和视频，实际生成并打开 DOCX。新环境可按正式流水线安装依赖。[发布流水线与环境](https://github.com/xunova1121/-/actions/runs/44742011614)

```sh
cd jarvis
npx vitest run tests/workshopNews.test.js tests/workshopNewsArticle.test.js tests/workshopNewsChat.test.js tests/workshopTv.test.js tests/workshopMediaChannels.test.js tests/workshopVideoFile.test.js
npm run build
npm run build:mobile
node e2e/workshop-media.mjs
node e2e/workbench-action-studio.mjs
```

## 已有证据和待办

- 正式构建的浏览器复验中，1440 × 900 电脑上的实际节目画面占含聊天区工作台的 55.9%，占房间的 75.0%。390 × 844 手机的节目画面占房间的 63.9%。新闻原文、追问及排队生成的 Word 已实测。正式流水线与公开附件结果见[本次发布验收](docs/分工-Claude与Codex-20261029.md#10473-房间内看电视和读原文)。
- **真机优先。** 下一项是安卓真机切后台、横竖屏及软键盘复验，以及 Windows 安装版实测。用户服务器的实际升级状态待确认。真实央视节目内嵌验收需要部署方提供已获授权的频道地址。
- 本地浏览器专项以真实视频解码、正在播放的媒体尺寸、旧媒体释放和实际 DOCX 正文为验收依据。实测时请记录设备、浏览器或 WebView 版本、是否启用云服务器与频道来源。

请用中文回报复核结果。每个问题写明设备或运行方式、复现步骤、实际现象和对应证据，并区分这次亲自验证的结果与上面的发布记录。
