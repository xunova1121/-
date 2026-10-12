# 贾维斯桌面版

Windows / macOS / Linux 桌面应用（Electron）。和网页版是同一套界面与智能体，另外多了：

| 能力 | 说明 |
|---|---|
| 操作电脑 | 查看 / 搜索 / 读取任意文件夹（Word、PDF、PPT、Excel 自动提取文字）；写入、复制、移动、移到回收站；打开文件、网址或程序（“记事本”“微信”“VS Code”……）；运行命令（Windows PowerShell / macOS·Linux shell）；截屏；剪贴板；系统通知 |
| 鼠标键盘控制 | 像人一样操作任何软件：看屏幕 → 点击 / 双击 / 右键 / 拖动 / 滚动 / 输入文字（中文走剪贴板粘贴，用完恢复）/ 快捷键，每步做完自动再看一眼确认结果。操作期间贾维斯窗口自动隐藏，结束后回来。**紧急停止**：把鼠标甩到屏幕左上角，或按 **Ctrl+Alt+Q**（Mac：⌘+Option+Q）。Windows 用系统自带的 PowerShell + user32；Mac 用 CoreGraphics（需授权“辅助功能”）；Linux 需要 `xdotool`（X11） |
| 安全确认 | 写入、移动、删除、打开、运行命令、读剪贴板，都会先在对话里出现确认卡片：**允许 / 本次都允许 / 拒绝**。系统目录（C:\Windows、/System、/usr 等）一律不允许修改；移动 / 复制不会覆盖已有文件；删除只进回收站 |
| MCP 工具 | 在“技能与工具”面板添加 MCP 服务（文件系统、浏览器自动化、高德地图、GitHub 等预设，或自定义命令 / 远程地址），智能体自动获得这些工具；每个服务可选“自动允许” |
| 常驻 | 关闭窗口后在托盘继续运行；**Ctrl+Shift+J**（Mac 为 ⌘+Shift+J）随时呼出 / 隐藏；托盘菜单可设开机自启 |
| 语音 | 桌面版没有浏览器自带的语音识别，直接对话与唤醒词改用云端识别：填了硅基流动或 OpenAI 的密钥就自动使用（本机检测说话、按句上传，不持续录音） |
| 不受跨域限制 | 内置本机网关，所有服务商、中转接口、自定义接口都能直接连 |

## 下载

仓库的 **Releases** 页面（每次更新会由 GitHub Actions 自动打包）：

- Windows：`Jarvis-Setup-<版本>.exe`（安装版）或 `Jarvis-<版本>-win-x64.zip`（免安装，解压后双击 `Jarvis.exe`）
- Mac（M 系列芯片）：`Jarvis-<版本>-mac-arm64.dmg`；Intel 芯片：`Jarvis-<版本>-mac-x64.dmg`
- Linux：`Jarvis-<版本>-linux-x86_64.AppImage`

安装包没有购买代码签名证书，首次打开会被系统拦一下：

- **Windows**：“Windows 已保护你的电脑” → 点 **更多信息** → **仍要运行**。
- **Mac**：“无法验证开发者” → 在 访达 › 应用程序 里 **右键 Jarvis → 打开**；仍打不开就在终端运行 `xattr -cr /Applications/Jarvis.app`。
  截屏需要在 系统设置 › 隐私与安全性 › 屏幕录制 里允许 Jarvis；用鼠标键盘操作电脑需要在 › 辅助功能 里允许 Jarvis（第一次用时会弹出提示）；麦克风首次使用时会弹出授权。

数据（记忆、知识库、技能、设置）保存在本机；MCP 配置在托盘菜单“打开数据文件夹”里的 `mcp.json`。

## 从源码运行 / 打包

需要 Node.js 18+。

```bash
cd jarvis && npm install            # 网页部分
cd desktop && npm install           # Electron 与打包工具
npm start                           # 构建网页并启动桌面版
npm run dist                        # 打当前系统的安装包，输出到 desktop/release/
```

打包会先把 `jarvis/dist`、`server`、`shared` 复制到 `desktop/bundle/`（`npm run prepare-app`）。Windows 安装包（NSIS）需要在 Windows 上打（或在 Linux 装 wine）；Mac 的 dmg 需要在 Mac 上打——这些都由 `.github/workflows/jarvis-desktop.yml` 在 GitHub 上完成。

## 测试

```bash
cd jarvis
xvfb-run -a node e2e/desktop.mjs                                   # 源码运行的桌面版（Linux 无显示器时用 xvfb-run）
JARVIS_DESKTOP_EXE=desktop/release/linux-unpacked/jarvis-desktop xvfb-run -a node e2e/desktop.mjs   # 打包后的程序
```

16 项：preload 隔离（页面拿不到 Node）、进程内网关与 MCP、查看桌面、写文件前确认（允许 / 拒绝）、运行命令、“本次都允许”、系统目录保护、截屏、界面添加 MCP 服务并由智能体调用（含确认）。测试使用临时 HOME，不会碰到真实文件。

## 建议你重点试的

1. 模型面板填入你的密钥（teamorouter 选“自定义”），确认能对话。
2. “帮我看看桌面上有哪些文件”“把下载文件夹里的 PDF 按月份整理到文件夹里”“打开记事本”“帮我查一下这台电脑的 IP 地址”；需要点界面的：“打开微信，给文件传输助手发一句‘测试’”“在浏览器里打开 B 站搜一下贾维斯”。
3. “做一份周报 Word 保存到桌面”（create_document → computer_save_from_workspace）。
4. 技能与工具 → MCP：添加“浏览器自动化”（需要装 Node.js），然后说“打开百度搜索今天的天气并截图”。
5. 填硅基流动密钥后打开“直接对话”和“唤醒词”，说“贾维斯，现在几点”。
6. 关掉窗口后按 Ctrl+Shift+J 呼出。
