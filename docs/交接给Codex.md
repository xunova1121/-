# 未央（WEIYANG AI）交接说明

写于 2026-10-15 晚（北京时间）。接手前先读根目录 `CLAUDE.md`（开发约定），它比这份文件优先。

## 1. 工程在哪

- 仓库：`https://github.com/xunova1121/-`（公开仓库）
- 开发分支：`claude/jolly-darwin-tijh97`（所有改动都在这条分支上，没有用 PR）
- 代码：`jarvis/` 目录
  - `src/`：网页界面（Vite，原生 JS，无框架）。入口 `src/main.js`
  - `src/agent/`：智能体循环（`agent.js`）、工具（`tools.js`）、搜索（`webSearch.js`）、读网页（`pageReader.js`）、技能（`skillCatalog.js` / `skillPacks.js`）
  - `src/llm/`：各家模型适配（`anthropic.js`、`responses.js`、`openai*.js`、`config.js`、`router.js`）
  - `shared/providers.js`：服务商列表（含 TeamoRouter 的 `relay-multi`：按模型名自动选 Anthropic / OpenAI Responses / Chat 协议）
  - `server/`：本机网关（`node server/server.mjs`，端口 8787）
  - `desktop/`：Windows 桌面版（Electron）
  - `android/`：安卓 App（Capacitor 8，Java 原生代码在 `android/app/src/main/java/com/xunova/jarvis/`）
  - `tests/`：单元测试（vitest）；`e2e/`：端到端脚本
- 根目录 `jarvis-standalone.html`：单文件版，`npm run build:standalone` 自动生成，别手改

## 2. 发版（重要）

- 推送到开发分支、且改了 `jarvis/src|server|shared|desktop|android`、`capacitor.config.json`、`vite.config.js`、`index.html`、`package*.json` 时，
  GitHub Actions（`.github/workflows/jarvis-desktop.yml`）自动打包并发布 `desktop-v1.0.<序号>`，用户的电脑和手机会自动更新。
- 一次打包约 10–15 分钟；新的推送会取消正在跑的打包。
- 只想保存进度不发版：提交信息里加 `[skip ci]`。
- 版本号由 CI 生成，不要手改。
- 安卓固定签名靠仓库 Secret `ANDROID_SIGNING`（已配置）。不要把任何 keystore / 密钥提交进仓库。

## 3. 测试（在 `jarvis/` 下，推送前必须全过）

```
npm install
npx vitest run                      # 单元测试，目前 578 个全过
npm run build
node server/server.mjs & node e2e/smoke.mjs        # 130 项
npm run build:standalone && node e2e/standalone.mjs # 14 项
```
- `smoke` 里“WebGL 上下文丢失后恢复 ≤ 500ms”偶尔超时（500–600ms），是已知的计时偶发项，和功能无关。
- MCP 重连那个单元测试偶尔失败，重跑能过。
- 不许跳过或删除失败的测试。

## 4. 和用户沟通

- 全程中文，说人话，少用术语。没测过的要明说没测过（尤其手机上的改动，这边只能用浏览器模拟手机尺寸）。
- 用户在中国大陆，时间用北京时间；联网功能要考虑国内网络。
- 用户主要用安卓手机 + Windows 电脑，经 TeamoRouter（`relay-multi`）用 GPT / Claude / DeepSeek 等模型。

## 5. 约束

- 界面上叫“未央”；代码、数据目录、环境变量（`JARVIS_*`）、安装包文件名里的 jarvis / Jarvis 不能改（会丢用户数据、断自动更新）。
- 只借鉴开源项目的思路，按现有风格重写；不反编译、不照抄闭源软件（QClaw、元宝、晓伴等）。
- 新依赖要发布满两周以上；不引入 Python 运行时；必须同时支持网页、桌面、安卓三端。
- 中文注释、命名和写法跟周围代码一致。

## 6. 最近做完的（10-15，都已推送）

| 提交 | 内容 |
|---|---|
| 4db4c68 | 联网搜索步骤按模型命名；安卓去掉 `captureInput`（修句中插字跳到末尾）；键盘弹出时对话保持贴底 + `adjustResize`；只留一个动画启动页（用户原图 `src/ui/splash-cloud.webp`） |
| 16605ff | 读网页按 charset 解码（GBK 中文站不再乱码）；手机原生请求读网页取原始字节；查资料用时上限 8 分钟（`agent.js` 的 `TIME_BUDGET_MS`）；回答输出每帧刷新一次（修长回答卡顿）；崩溃记录加“正在输出回答” |
| c531655 | 回答里的网址可点：来源显示成域名小标签，文字链接带 ↗，去掉 utm 参数（`src/core/markdown.js` 的 `inline`、`transcript.js` 的 `linkEl`） |
| af80c89 | 手机首页改版（云朵 + 光环、日期胶囊、“未央为你准备了”可换一换）；左边栏改版（彩色功能图标、带时间的历史、底部“我的未央 + 设置”）（`main.js` 的 `renderWelcome` / `picksCard`、`src/ui/drawer.js`） |

af80c89 的打包（第 81 次运行）交接时还在跑，请先到 Actions 页面确认成功，然后把安卓 apk 下载链接发给用户：
`https://github.com/xunova1121/-/releases/download/desktop-v1.0.<序号>/Jarvis-1.0.<序号>-android.apk`

## 7. 待办 / 没确认的

1. **手机 App 偶尔“界面渲染进程崩溃”**：原因还没确定。`MainActivity` 会自动重开界面，设置 → 版本下面会显示崩溃记录和“崩溃前正在：…”。
   怀疑方向：长回答逐字重排（已在 16605ff 优化）、手机里跑 Python（Pyodide，很吃内存）。用户再发崩溃截图时看“崩溃前正在”是什么。
2. 上面几个手机改动（插字、键盘、启动页、首页、左边栏）都只在浏览器模拟里验证过，等用户真机反馈。
3. 曾提议但用户还没答应的：手机上处理 PDF / Excel 时尽量不跑 Python；Gemini 原生协议；被拦的网站换更完整的请求头重读。
4. QClaw 技能对照见 `docs/skills-from-qclaw.md`（9 个已按用途重写进内置技能，8 个跳过）。

## 8. 用户常用的反馈方式

用户会发手机截图说问题。修完后：跑完测试 → 提交（提交信息写清改了什么）→ 推送 → 等打包完成 → 告诉用户版本号和下载链接，并说明哪些没在真机测过。
