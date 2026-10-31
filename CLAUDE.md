# 未央（WEIYANG AI，原名贾维斯）开发约定

> 最新用户交接（2026-10-29）：架构图e926602真实服务器实测仍失败；接手前请读 `docs/交接给Claude-架构实测失败与未发布改动-20261029.md`，包含精确复现、未发布改动和验收缺口。本次不是已修复或发版通知。

个人 AI 智能体。界面上的名字叫“未央”；代码、数据目录、环境变量（JARVIS_*）、安装包文件名里的 jarvis / Jarvis 保持不变（改了会丢用户数据、断自动更新）。logo 在 `src/ui/logo.svg`，改完运行 `node scripts/make-icons.mjs` 重新生成电脑和安卓图标。代码在 `jarvis/`：网页界面（Vite）、本机网关（`server/`）、Windows 桌面版（`desktop/`，Electron）、安卓 App（`android/`，Capacitor）。

## 和用户沟通
- 用中文回复，说人话，少用术语。
- 没测过的就说没测过；不要把推断说成事实。
- 用户在中国大陆，时间一律按北京时间；联网功能要考虑国内网络。

## 借鉴其他项目
- 只借鉴**开源**项目（先看仓库的 LICENSE）。不要反编译、照抄闭源软件（如 QClaw、元宝）的代码。
- 借鉴的是思路：读懂后按贾维斯现有的结构和代码风格重写，不要整段复制。
  确实复制了 MIT / Apache 等许可的代码时，在文件顶部注明出处和许可。
- 一次只融入一个功能：先列清单和改动大小，等用户确认再动手。
- 不要为了“和别人一样”推翻现有架构（必须同时支持网页、桌面、安卓三端；不引入 Python 运行时）。
  例外（用户 2026-10-24 同意）：服务器上可选的“技能运行器”（`server/skillRunner.mjs`，Docker 隔离容器）可以运行技能自带的 Python / Node 脚本；App 本身仍不带 Python。

## 改代码
- **先读 `docs/已修问题清单-不许回退.md`**：动手前拉最新代码并合并，不整文件覆盖，测试只许加不许删；修了新 bug 要加进那份清单。
- 先读 `docs/代码规范.md`（结构、写法、互相审查清单；Claude 和 GPT 共用）。前端功能在 `src/app/` 各模块里，`main.js` 只做组装，不要往里加功能。
- 跟周围代码保持一致：中文注释、命名和写法照旧。
- 新依赖的版本要发布满两周以上。
- 不要提交签名密钥（keystore 等），仓库是公开的。
- 只打包 Windows 和安卓。

## 测试（在 `jarvis/` 下）
- 代码检查：`npm run lint`，必须通过（查没定义的变量、浏览器同名全局、格式）。
- 单元测试：`npx vitest run`，必须全部通过；新功能要加测试。
- 构建：`npm run build`。
- 端到端：`node e2e/smoke.mjs`（需要先启动 `node server/server.mjs`）、`npm run build:standalone && node e2e/standalone.mjs`。
- 测试失败不许跳过或删掉测试。

## 提交与发布
- 开发分支：`claude/jolly-darwin-tijh97`。
- 推送到这个分支、且改动了 `jarvis/` 下的源码（src、server、desktop、android、package.json 等，
  见 `.github/workflows/jarvis-desktop.yml` 的 paths）时，GitHub Actions 会自动打包并发布新版本（用户电脑会自动更新）。
  所以：测试全部通过、用户同意后再推送；只想保存进度不发版时，提交信息里加 `[skip ci]`。
- 注意：只看最后一次推送。之前的提交都带 `[skip ci]`、最后一个提交又只改了 `jarvis/` 以外的文件（如根目录的
  `jarvis-standalone.html`、`CLAUDE.md`）时，不会打包。这时到 GitHub 的 Actions 页面对这个工作流点“Run workflow”手动发版。
- 版本号由 CI 自动生成（`desktop-v1.0.<序号>`），不要手动改。
- 手机自动更新要求每次用同一个签名密钥：仓库 Secrets 里要有 `ANDROID_SIGNING`（值为“密码.keystore 的 base64”；或旧的 `ANDROID_KEYSTORE_B64` + `ANDROID_KEYSTORE_PASSWORD`），否则 CI 每次临时生成密钥，新版装不上。
