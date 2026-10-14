# 贾维斯（J.A.R.V.I.S.）开发约定

个人 AI 智能体。代码在 `jarvis/`：网页界面（Vite）、本机网关（`server/`）、Windows 桌面版（`desktop/`，Electron）、安卓 App（`android/`，Capacitor）。

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

## 改代码
- 跟周围代码保持一致：中文注释、命名和写法照旧。
- 新依赖的版本要发布满两周以上。
- 不要提交签名密钥（keystore 等），仓库是公开的。
- 只打包 Windows 和安卓。

## 测试（在 `jarvis/` 下）
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
