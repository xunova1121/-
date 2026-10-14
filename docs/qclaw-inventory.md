# QClaw 能力盘点：哪些贾维斯能合规用上

- 盘点对象：`C:\Program Files\QClaw\v0.2.37.630\resources`（QClaw 0.2.37，腾讯）
- 盘点日期：2026-10-14（北京时间）
- 方法：直接读文件（目录结构、各 `package.json`、`dist-info` 元数据、LICENSE、SKILL.md 的标题和依赖说明）+ 用一个小脚本读 `app.asar` 的文件索引 + rea 的 `analyze_javascript_application` 分析 `app.asar`（跑完了但结果太大没传回来，见第 7 节）
- 只看不改，没有动贾维斯的代码。跳过了 `.map` 文件；`node_modules` 只列包名。
- **说明：** 贾维斯的 `CLAUDE.md` 规定“不要反编译、照抄闭源软件（如 QClaw）”。这次盘点是你明确选择的破例。报告里对 QClaw 私有的技能包和提示词只总结做法，没有复制原文。下面标“不能用”的内容，就算只借鉴思路，也建议对照公开资料自己写，不要对着它的文件改写。

---

## 0. 一句话结论

1. **QClaw 写文档的核心不是腾讯自己的东西。** 它的 Word / PPT / Excel / PDF 能力来自 4 个技能包（`docx`、`pptx`、`xlsx`、`pdf`），这 4 个是 **Anthropic 的专有技能**。LICENSE 写明“© 2025 Anthropic, PBC. All rights reserved”，使用受与 Anthropic 的协议约束，**不能用**。QClaw 在 PDF 技能里加了中文字体处理，在 Excel 技能里加了 CSV 编码规则，这些改动同样不能用。
2. **这些技能背后用的库都是开源的，贾维斯大多已经有了，或者有对应的 JS 版本：** `docx`（npm，贾维斯已用）、PptxGenJS（贾维斯已用）、openpyxl、reportlab、pypdf、pdfplumber、LibreOffice、pandoc、markitdown。真正的差距不在库，而在**用法**：先大纲后分节、生成后转成图片自己检查、主题配色、Word 的规范排版（真列表、目录、页眉页脚）、Excel 用公式不写死数值。
3. **整个智能体框架是开源的：** QClaw 的运行时是 **OpenClaw**（MIT，2026.6.5）和 **Hermes Agent**（`hermes-sdk`，MIT，Hermes 0.17.0），外面套了一层腾讯的 Electron 外壳。外壳的主进程编译成了 V8 字节码，不可读，而且是私有的。
4. **可以直接拿来用的现成资源有：**
   - Anthropic 开源技能里 Apache-2.0 的那部分，尤其是 `theme-factory` 的 10 套主题；
   - 字体（OFL）；
   - OpenClaw 和 Hermes 里的 MIT 代码思路，例如 `lossless-claw`（MIT）的分层对话摘要。

---

## 1. 写文档相关（最重要）

### 1.1 QClaw 怎么生成各类文档

| 格式 | 生成方式（来自技能包说明，只总结做法） | 用到的开源库或工具 | 库的许可 |
|---|---|---|---|
| **Word** | 新建：用 JS 库 `docx`（技能里叫 docx-js）写脚本生成，生成后校验。改已有文档：解压 .docx → 直接改里面的 XML → 重新打包，支持修订痕迹和批注。读取：转文本或转图片。 | `docx`（npm）、pandoc、LibreOffice（`soffice`，转格式、转 PDF、转图片）、Python 脚本解包和打包 | docx：MIT；pandoc：GPL-2.0（只能作为外部程序调用）；LibreOffice：MPL-2.0（外部程序） |
| **PPT** | 新建：用 PptxGenJS 从零生成。改已有：解包 XML，用脚本加页、清理。**必须做 QA**：内容检查加视觉检查，把每页转成图片看一遍，有问题就改，循环到没问题为止。说明里有大段设计规则：先定配色、每页选版式、字号层级、留白、常见错误清单。 | PptxGenJS、markitdown（读 PPT 转 Markdown）、sharp（图片处理）、LibreOffice（转图片做缩略图） | PptxGenJS：MIT；markitdown：MIT；sharp：Apache-2.0 |
| **Excel** | 用 openpyxl 生成和修改，pandas 做分析。**强调用 Excel 公式，不在 Python 里算好再写死数值**。写完用 LibreOffice 重新计算，检查有没有公式错误。有财务模型的配色约定（输入、公式、引用用不同颜色）和数字格式规范。QClaw 自己加了 CSV 规则：给 Excel 打开的 CSV 要带 UTF-8 BOM，不然中文乱码。 | openpyxl、pandas、LibreOffice（`recalc.py` 重新计算） | openpyxl：MIT；pandas：BSD-3 |
| **PDF** | 生成：用 reportlab（Python）。读取和处理：pypdf（合并、拆分、旋转）、pdfplumber（提取文字和表格）、qpdf、pdftotext、pdf-lib（JS），另有表单填写的一整套脚本。QClaw 自己加了中文 PDF 的处理：先注册中文字体，所有样式继承这个字体，表格每个单元格都用段落包起来；Windows 上避免在命令行里直接写中文。 | reportlab、pypdf、pdfplumber、qpdf、poppler（pdftotext）、pdf-lib | reportlab：BSD；pypdf：BSD-3；pdfplumber：MIT；qpdf：Apache-2.0；poppler：GPL（外部程序）；pdf-lib：MIT |

**这些库怎么装：** QClaw 自带的 Python（3.11，`resources/python`）只装了 pip 和 setuptools。技能需要的库，是在第一次用到时现场 `pip install` / `npm install -g` 装的，由 `qclaw-env` 技能引导安装。**LibreOffice 和 pandoc 没有随 QClaw 一起打包**，要用户电脑上本来就有。

**另一套“文档引擎”：** `app.asar` 依赖 `@tencent/docs-engine`。它的 `package.json` 写的是 Apache-2.0，但实际只发布在腾讯内网镜像（mirrors.tencent.com），核心是一个 173 MB 的闭源原生库 `editor_sdk_ffi.dll`，没有源码。从导出的接口看（`LocalFileEngine`、文档类型 doc / sheet / slide / pdf、`sdk_local_preview`），它是腾讯文档编辑器的本地版，用来**在 QClaw 里预览和编辑本地 Office 文件**，不负责让智能体生成文档。**不能用**：拿不到，也没有源码。

### 1.2 文档模板和样式

| 项目 | 内容 | 许可 | 贾维斯有没有 | 建议 |
|---|---|---|---|---|
| `theme-factory` 技能 | 10 套主题（北极霜、植物园、沙漠玫瑰、森林、黄金时刻、午夜星河、现代极简、海洋深处、日落大道、科技创新），每套是一组配色加字体搭配，可用于 PPT、文档、报告、网页，附一份展示 PDF | **Apache-2.0** | 没有。贾维斯生成的文档只有一种默认样式 | **直接用**：把主题数据转成贾维斯的格式，注明出处和许可 |
| `canvas-design` 的字体 | 十几款西文字体（Arsenal SC、Big Shoulders、Bricolage Grotesque、Crimson Pro 等） | 技能本身 Apache-2.0；字体是 **OFL**（可以随软件分发） | 没有 | 用处不大：都是西文字体，不解决中文 |
| Office XML 校验模板 | docx、pptx、xlsx 技能里带了整套 Office Open XML 的 XSD 校验文件（ECMA / ISO 标准里的公开文件） | 技能整体是 Anthropic 专有；XSD 本身来自公开标准 | 没有 | 不从 QClaw 拿。确实需要校验时，从 ECMA 官网下载标准文件 |
| 文档模板（.dotx / .potx） | **没有找到**。QClaw 没有带 Word 或 PPT 模板文件，样式靠技能说明里的规则和代码控制 | — | — | — |

### 1.3 写文档专用的技能和提示词

| 技能 | 做什么（总结） | 许可 | 贾维斯有没有 | 建议 |
|---|---|---|---|---|
| `docx` / `pptx` / `xlsx` / `pdf` | 见 1.1 | **Anthropic 专有**，QClaw 又改过 | 贾维斯有自己的 `create_document` 工具（`src/agent/docs.js`），但没有这么细的规则 | **不能用**。只借鉴公开常识层面的思路，自己写 |
| `doc-coauthoring` | **长文档合写流程，分三个阶段：** ①收集背景（先问几个问题，让用户把材料一股脑倒进来）；②定结构后**逐节写**：每节先补充提问、头脑风暴、挑选、查漏，再起草、修改；③**读者测试**：预测读者会问什么，让一个子代理扮演没看过上下文的读者来读，找出看不懂的地方再改。最后通读一遍。 | 这里**没有许可文件**。它出自 Anthropic 的开源技能仓库，但那个仓库里各技能许可不一样，这个具体是什么没有核实 | 部分有：深度调研（`research.js`）会先出大纲再写；普通的写文档是一次写完 | **借鉴思路自己重写**（按“没有许可”处理） |
| `content-factory` | 多代理内容生产线：选题研究 → 多平台改写（公众号、知乎、小红书、Twitter）→ SEO → 内容日历 | 无许可文件（QClaw 私有） | 团队模式（`team.js`）能做类似的多步分工 | 不能用；思路很普通，不需要借鉴 |
| `aippt` | 调用腾讯远程的“智绘高迪”AI PPT 服务生成 PPT | 无许可，依赖腾讯私有服务 | 没有 | 不能用 |
| `tencent-docs` / `kdocs` / `youdaonote` / `notion` | 通过各家的 MCP 或接口操作云文档 | 无许可（各家私有服务接入） | 没有 | 不能用这些技能文件；Notion 之类有公开 MCP 的话，可以自己接 |
| OpenClaw `nano-pdf` | 用自然语言指令编辑 PDF（调用 nano-pdf 命令行） | MIT（OpenClaw） | 没有 | 优先级低 |
| OpenClaw `diagram-maker` | 生成 SVG / HTML / Excalidraw 图（流程图、架构图、白板） | MIT | 没有专门的工具，贾维斯可以写 HTML 或 SVG | 可以借鉴：报告里自动配图 |
| OpenClaw `summarize` | 总结网址、视频、播客、PDF、本地文件 | MIT | 有类似能力（读网页、读文件） | 不需要 |

**流程是一次写完还是先大纲再分节？**
- 只有 `doc-coauthoring` 是先结构后逐节，最后还有读者测试；
- `docx`、`pptx`、`xlsx`、`pdf` 技能管的是“怎么把内容做成文件”，内容本身一次写完。重点在**生成后检查**：PPT 转图片看、Excel 重新计算查错、Word 校验 XML。

---

## 2. 技能包清单

一共找到 213 个 SKILL.md。去掉重复（`node_modules` 和 `node_modules.unpacked` 各有一份）和第三方依赖自带的，主要分三组。

### 2.1 QClaw 内置技能（`openclaw/config/skills`，50 个）

| 技能 | 做什么 | 许可 | 贾维斯有没有 | 建议 |
|---|---|---|---|---|
| docx / pptx / xlsx / pdf | Office 和 PDF 的生成、编辑、读取 | Anthropic 专有 | 有基础版 | 不能用 |
| canvas-design | 按设计理念生成海报、视觉作品（PNG / PDF） | Apache-2.0 | 有生成图片 | 可借鉴 |
| frontend-design | 做有设计感的网页界面的规范 | Apache-2.0 | 没有这类规范 | **可以直接用**（注明出处）：贾维斯写网页时的设计规则 |
| theme-factory | 10 套主题 | Apache-2.0 | 没有 | **直接用** |
| mcp-builder | 指导写 MCP 服务 | Apache-2.0 | 没有 | 用处不大 |
| qclaw-skill-creator | 指导写技能包（Anthropic skill-creator 的改版） | Apache-2.0 | 贾维斯会自动存“习得技能” | 可借鉴 |
| slack-gif-creator | 做 Slack 用的动图 | Apache-2.0 | 没有 | 不需要 |
| web-artifacts-builder | 用 React + Tailwind 做复杂单页网页 | Apache-2.0 | 贾维斯能写网页 | 可借鉴 |
| webapp-testing | 用 Playwright 测本地网页 | Apache-2.0 | 没有 | 优先级低 |
| doc-coauthoring | 长文档合写流程 | 无许可文件 | 部分有 | 借鉴思路重写 |
| self-improving | 自我反思、自我批评、整理记忆 | 无 | 有（记忆整理、教训） | 不需要 |
| skill-vetter | 安装技能前做安全审查 | 无（QClaw 私有） | 没有 | 不能用；Hermes 的 `skills_guard`（MIT）可以做同样的事，之前已列为待做第 3 项 |
| find-skills | 帮用户找、装技能 | 无 | 有技能目录 | 不需要 |
| session-logs | 用 jq 搜以前的会话日志 | 无 | 有（`search_conversations`） | 不需要 |
| file-skill | 桌面、文件整理 | 无 | 有电脑文件工具 | 不能用 |
| kc-gui | 用自带的 kc.exe 做 Windows 图形界面自动化 | 无，含闭源程序 | 有（`computer_click` 等） | 不能用 |
| xbrowser | 浏览器自动化 | 无 | 有限 | 不能用 |
| qclaw-env / qclaw-rules / qclaw-cron-skill | QClaw 自己的环境安装、规则、定时任务 | 无 | 有定时任务 | 不能用 |
| email-skill / imap-smtp-email / public-skill | 邮件收发、推送到邮箱 | 无 | 没有 | 不能用；要做就用开源的 IMAP / SMTP 库自己写 |
| news-summary / tech-news-digest / tencent-news | 新闻汇总 | 无 | 有联网搜索 | 不能用 |
| weather-advisor | 天气和穿衣建议 | 无 | 没有专门的 | 不能用 |
| content-factory / chuangye | 内容生产线、创业辅助 | 无 | — | 不能用 |
| aippt | 腾讯 AI PPT 服务 | 无 | — | 不能用 |
| tencent-docs / kdocs / youdaonote / notion / ima / weiyun / bdpan-storage / cloud-upload-backup | 各家云文档、网盘接入 | 无 | — | 不能用 |
| tencent-meeting-mcp / tencent-survey / tencent-musician-skills / neodata-financial-search | 腾讯会议、问卷、音乐人、金融数据 | 无 | — | 不能用 |
| flyai / wendao-partner-qclaw-skill | 机票、酒店、旅行 | 无 | — | 不能用 |
| lark-setup / wecomcli-setup | 飞书、企业微信命令行引导 | 无 | — | 不能用 |
| mcporter | 用命令行管理和调用 MCP | 无 | 有 MCP 面板 | 不需要 |

插件目录里另有几组技能：企业微信 15 个、微信支付 4 个、QQ 机器人 4 个、钉钉 3 个，都是各自平台的接入说明，与写文档无关，不能用。

### 2.2 OpenClaw 自带技能（`openclaw/skills`，57 个，**MIT**）

1password、apple-notes、apple-reminders、bear-notes、blogwatcher、blucli、camsnap、canvas、clawhub、coding-agent、diagram-maker、discord、eightctl、gemini、gh-issues、gifgrep、github、gog、goplaces、healthcheck、himalaya、imsg、mcporter、meme-maker、model-usage、nano-pdf、node-connect、node-inspect-debugger、notion、obsidian、openai-whisper、openai-whisper-api、openhue、oracle、ordercli、peekaboo、python-debugpy、sag、session-logs、sherpa-onnx-tts、skill-creator、slack、songsee、sonoscli、spike、spotify-player、summarize、taskflow、taskflow-inbox-triage、things-mac、tmux、trello、video-frames、voice-call、wacli、weather、xurl。

大部分是给各种命令行工具和 Mac 应用写的说明，和贾维斯的三端结构关系不大。和写文档相关的只有 `diagram-maker`、`nano-pdf`、`summarize`（见 1.3）。

### 2.3 Hermes 自带技能

只有 `qclaw-migration`（QClaw 私有，迁移用）和 `openclaw-migration`（MIT）两个。Hermes 原版的大量技能没有打包进来。

---

## 3. 工具清单

### 3.1 OpenClaw 内置工具（MIT）

| 类别 | 工具 | 用途 | 贾维斯对应 |
|---|---|---|---|
| 运行 | `exec`、`process`、`code_execution` | 运行命令、管理进程、跑 Python 分析 | `computer_run`、`run_python`、`run_javascript` |
| 文件 | `read`、`write`、`edit`、`apply_patch` | 读写文件，**按片段修改**，打补丁 | 有读写；**没有按片段修改**，每次都整个重写 |
| 网络 | `web_search`、`x_search`、`web_fetch` | 搜索、读网页 | `web_search`、`fetch_url` |
| 浏览器 | `browser` | 操作浏览器 | 没有，只能用鼠标键盘操作电脑 |
| 消息 | `message` | 发消息到各个渠道 | 没有 |
| 会话和代理 | `sessions_*`、`subagents`、`agents_list`、`session_status`、`goal` | 查会话、派子代理、设目标 | 有团队模式和读以前的对话 |
| 自动化 | `cron`、`heartbeat_respond` | 定时任务、心跳 | `schedule_task` 等 |
| 媒体 | `image`、`image_generate`、`music_generate`、`video_generate`、`tts` | 看图、生成图片、音乐、视频、语音 | 有图片、视频、语音；没有音乐 |
| PDF | `pdf` | 分析 PDF：模型支持就直接交给模型，否则先提取文字 | `read_file` 提取文字 |
| 大工具库 | `tool_search_code`、`tool_search`、`tool_describe` | 工具很多时按需检索，不把所有工具说明都塞给模型 | 没有 |
| 插件工具 | `diffs`、`llm-task`、`lobster`、`tokenjuice`、`canvas` | 显示改动对比、只输出 JSON 的任务步骤、可中断恢复的工作流、压缩命令输出、画布 | 没有 |

### 3.2 QClaw 插件加的工具（私有，**不能用**）

| 插件 | 工具 | 用途 |
|---|---|---|
| qclaw-plugin | `qclaw_tdoc_mcp_call` / `qclaw_tdoc_mcp_list`、`qclaw_read_ima_content`、`skillhub_install`、`render_ui`、`web_search`、`qmem_match_prompt_context`、`weixinpay_pay` | 腾讯文档 MCP、读 ima 知识库、装技能、在界面上画卡片、搜索、记忆匹配、支付 |
| openclaw-weixinpay | `weixinpay_register` / `weixinpay_feedback` / `weixinpay_retry_pay` | 微信支付 |
| openclaw-qqbot | `qqbot_channel_api`、`qqbot_remind` | QQ 机器人 |
| wecom-openclaw-plugin | `wecom_mcp` | 企业微信 |
| openclaw-plugin-yuanbao | `query_group_info`、`query_session_members` | 元宝群聊 |

### 3.3 lossless-claw 插件（MIT，可借鉴）

工具：`lcm_describe`、`lcm_expand`、`lcm_expand_query`、`lcm_grep`。
做法：把长对话按层级摘要成一棵树，模型需要细节时再展开某一段原文，或在原文里搜索。贾维斯刚做的长对话压缩是单层的“前情提要”；需要更细时，可以借鉴这种“摘要可展开”的做法。

### 3.4 Hermes 工具（MIT）

共 90 多个模块。之前调研过的都在里面：危险命令识别、文件备份、技能安全扫描、超长结果存文件、任务清单、结构化追问。另外还有：
- `feishu_doc_tool` / `feishu_drive_tool`：飞书文档；
- `microsoft_graph_*`：Office 365；
- `browser_*`：浏览器，含 Camofox；
- `mixture_of_agents_tool`：多模型合议；
- `kanban_tools`：看板；
- `osv_check`：查依赖漏洞；
- `url_safety` / `website_policy`：网址安全；
- `tool_output_limits`：限制工具输出长度；
- `yuanbao_tools`：元宝。
  这个模块随 hermes-sdk 一起声明为 MIT，但看名字是腾讯加的，属于腾讯私有服务的接入，不建议用。

---

## 4. 自带的 MCP 服务和插件

| 名称 | 是什么 | 许可 | 贾维斯有没有 | 建议 |
|---|---|---|---|---|
| Hermes 可选 MCP：`linear`、`n8n` | 项目管理、自动化流程的 MCP 配置 | MIT | 贾维斯支持添加任意 MCP | 不需要 |
| 腾讯文档 MCP、微云 MCP、腾讯会议 MCP、企业微信 MCP | 通过 QClaw 插件或技能接入腾讯服务 | 私有 | 没有 | 不能用 |
| OpenClaw 渠道插件：钉钉、QQ 机器人、微信、企业微信、元宝 | 让智能体在这些聊天软件里收发消息 | 钉钉、企业微信、微信、元宝的 package.json 写 MIT，QQ 机器人带 MIT LICENSE；但都依赖腾讯或各家私有接口 | 没有 | 用不上：贾维斯不做聊天机器人渠道 |
| `qclaw-llm-provider`、`qclaw-embedding` | 把模型请求转到腾讯网关 | 私有 | — | 不能用 |
| `qclaw-plugin-hermes` | 把 Hermes 的事件上报到腾讯统计（会话开始和结束、调用模型前后、调用工具前后等钩子），加排队控制 | 私有 | — | 不能用；只用于上报 |
| `lemonade`（AMD Lemonade Server） | 本地运行大模型的服务 | Apache-2.0 | 贾维斯支持 Ollama | 可选：多一种本地模型来源 |
| `llama-server`（llama.cpp） | 本地运行大模型，支持 Vulkan 显卡加速 | llama.cpp 是 MIT；这个目录里没有附许可文件 | 支持 Ollama（底层也是 llama.cpp） | 不需要 |
| `ui-reader.exe`、`turing-shield`、`qimei.dll`、`lowpriv-launcher.exe`、`guid-native` | 读取界面元素、风控、设备标识、以低权限启动、机器 ID | 私有，闭源 | — | 不能用 |
| `git`（Git for Windows） | 带了一整套 Git | GPL-2.0 | 不需要 | — |
| `python`（3.11 嵌入版） | 带了 Python 运行时 | PSF | 贾维斯用 Pyodide，规定不引入 Python 运行时 | 不引入 |
| `node`（node.exe） | 带了 Node | MIT | 桌面版用 Electron 自带的 | 不需要 |

---

## 5. 依赖库（只看包名和版本）

### 5.1 QClaw 外壳（`app.asar`，`@guanjia-openclaw/electron` 0.2.37）

- **开源：** better-sqlite3、chokidar、electron-log、electron-updater、adm-zip、archiver、yauzl、tar、json5、jsonrepair、yaml、ws、koffi（调用 DLL）、mint-filter（敏感词过滤）、pii-masker（个人信息打码）、node-machine-id、OpenTelemetry 一整套、axios、protobufjs。
- **腾讯私有：** `@tencent/docs-engine`（见 1.1）、`@tencent/qimei-node`、`@tencent/smh-js-sdk`、`@tencent/aegis-*`、`@tencent/beacon-*`、`@tencent/autotracker-*`、`@tencent/ovb-*`、`@tencent-connect/qqbot-connector`、腾讯云语音识别和语音合成 SDK。
- **和贾维斯相关的：**
  - `jsonrepair`（ISC）：修复模型输出的坏 JSON，贾维斯的 `parseJson` 可以考虑用；
  - `pii-masker`：上传前给个人信息打码。

### 5.2 OpenClaw（`openclaw` 2026.6.5，MIT，363 个包）

- **和文档相关的：** `jszip` 3.10.1（MIT）、`marked`（MIT）、`linkedom`（ISC）、`@mozilla/readability` 0.6.0（Apache-2.0）、`clawpdf` 0.3.0（MIT，PDFium 的 WASM 版，提取 PDF 文字和渲染页面）、`pngjs`、`playwright-core` 1.60.0（Apache-2.0）、`highlight.js`。
- **其他主要的：** `@modelcontextprotocol/sdk`、`openai`、`@anthropic-ai/*`、`@mistralai/*`、`@google/*`、`express`、`hono`、`undici`、`zod`、`typebox`、`kysely`、`sqlite-vec`（向量检索）、`pino`、`node-edge-tts`、`grammy`（Telegram）、`baileys`（WhatsApp）、`tree-sitter-bash`、`quickjs-wasi`、`tsx`、`esbuild`。

### 5.3 Hermes（`hermes-sdk` 2026.6.19.dev12，MIT；Python 包，节选）

- anthropic 0.87、openai 2.24、mcp 1.26、httpx、aiohttp、pydantic 2、fastapi、uvicorn、jinja2、markdown、pillow 12.2、edge_tts 7.2.7、elevenlabs、firecrawl_py、exa_py、parallel_web、apscheduler、croniter、psutil、pywin32、boto3、google_api_python_client、msal（微软登录）、modal、daytona（云沙箱）。
- 聊天渠道：python_telegram_bot、discord_py、slack_bolt、lark_oapi（飞书）、dingtalk_stream（钉钉）。
- **没有任何 Office 文档库**（python-docx、openpyxl、reportlab 都不在）。写文档完全靠 OpenClaw 那边的技能，加上现场安装的库。

---

## 6. 贾维斯现状对照（写文档）

| 能力 | 贾维斯现在 | QClaw 做法 | 差距 |
|---|---|---|---|
| Word 生成 | `docx` 库，Markdown 转换：标题、段落、加粗、代码、表格；默认字体微软雅黑 | 同一个库，规则细得多 | 列表用“•”字符而不是 Word 真正的列表；**没有**目录、页眉页脚、页码、分页、图片、页面尺寸设置、标题样式定制 |
| PPT 生成 | PptxGenJS，按“# 标题”分页、要点列表 | 同一个库，加设计规则和视觉 QA | 只有一种版式；没有配色主题；生成后不检查效果 |
| Excel 生成 | SheetJS 社区版（`xlsx` 0.18.5），Markdown 表格或 CSV 转工作表 | openpyxl，公式优先，配色和数字格式规范，重新计算查错 | 不能写样式（社区版不支持）；数值都是写死的，不写公式 |
| PDF | 生成可打印的 HTML，用户点“导出 PDF” | reportlab 加中文字体，直接出 PDF 文件 | 贾维斯这样做中文不出问题，但要用户手动点一下 |
| 读文档 | mammoth（Word）、pdf.js、JSZip（PPT）、SheetJS | markitdown、pdfplumber、pandoc | 差不多 |
| 改已有文档 | 不支持，只能重新生成 | 解包 XML → 修改 → 打包，保留原格式 | **缺** |
| 写作流程 | 深度调研有大纲和引用；普通文档一次写完 | 长文档先结构后逐节，加读者测试 | **缺** |
| 生成后检查 | 没有 | PPT 转图片看、Excel 查公式错误 | **缺** |

---

## 7. rea 分析结果（app.asar）

- **主进程和预加载脚本**（`out/main/*.cjsc`、`out/preload/*.cjsc`）是编译后的 V8 字节码，由 `bytecode-loader.cjs` 加载，**看不到源码**。主进程有 6.9 MB，QClaw 自己的业务逻辑大多在这里。
- **界面部分**（`out/renderer`）是压缩过的普通 JS（最大的单个文件约 3 MB）。
- 另有 `openclaw-bootstrap.mjs`（3.5 KB，启动 OpenClaw）和 `ima-jsapi-sdk`（ima 知识库的网页接口）。
- rea 的完整分析（`analyze_javascript_application`）跑完了，但结果超过 10 MB，超出了 rea 一次能返回的上限，没传回来。改用 rea 的摘要视图去取，rea 报不支持这条记录，所以**没拿到 rea 的分析内容**。上面几条是我写了个小脚本读 asar 文件索引得出的。外壳的代码是腾讯私有的，就算 rea 拆出了更多内容，也属于“不能用”的范围，不影响结论。

---

## 8. 对贾维斯写文档能力提升最大的前 10 项

按提升大小排序。每项都标明了来源是否合规。

| 排名 | 项目 | 怎么做 | 来源和许可 | 方式 | 改动大小 |
|---|---|---|---|---|---|
| 1 | **长文档先大纲、再逐节写** | 先出大纲让用户确认（或自动确认），再一节一节写，每节带着大纲和前文摘要，最后统一润色。贾维斯的深度调研已经有大纲步骤，可以扩展到普通的写文档 | 思路来自 `doc-coauthoring`（无许可文件，按不能复制处理），这是通用写作方法 | 借鉴思路，自己重写 | 中 |
| 2 | **Word 规范排版** | 用已有的 `docx` 库加上：真正的编号和项目符号列表、自动目录、页眉页脚和页码、A4 页面和页边距、标题样式、图片、分页 | `docx`（MIT），贾维斯已经依赖 | 直接用开源库 | 中 |
| 3 | **生成后自查（视觉 QA）** | 生成后把文档渲染成图片，交给模型看，有问题自动改一轮。桌面版可以用 Electron 截取页面；网页版可以把 docx 渲染成 HTML（已有 `docx-preview`），PPT 先渲染成 HTML 预览 | 思路来自 pptx 技能（专有），“生成后检查”是通用做法 | 借鉴思路，自己重写 | 中到大 |
| 4 | **主题配色** | 把 theme-factory 的 10 套主题转成贾维斯的格式，PPT、Word、网页、PDF 共用。可以让用户挑，也可以按内容自动选 | `theme-factory`（**Apache-2.0**） | **直接用**，注明出处 | 小 |
| 5 | **PPT 设计规则** | 给 PPT 生成加几种版式（标题页、要点页、左文右图、对比页、数据页、结尾页），按内容选版式，统一字号层级和留白 | 设计常识；QClaw 的 pptx 规则是专有的，不照抄 | 自己写 | 中 |
| 6 | **Excel 换成 ExcelJS** | 支持样式（表头加粗、底色、边框、列宽、冻结首行）、数字格式（金额、百分比、日期）、**公式**（合计、增长率用公式，不写死）；CSV 默认带 BOM | ExcelJS（MIT）。“公式优先”和 BOM 是通用常识 | 直接用开源库（换依赖前确认版本发布满两周） | 中 |
| 7 | **桌面版直接出 PDF** | 桌面版用 Electron 自带的 `printToPDF`，把排好版的 HTML 直接存成 PDF 文件，不用手动点；网页版和安卓保持现在的打印方式 | Electron 自带（MIT） | 自己写 | 小 |
| 8 | **改已有的 Word / PPT（保留格式）** | 用 JSZip 解开文件，只改文字所在的 XML 节点，再打包。先支持“替换文字”和“追加段落”，适合在用户自己的模板上填内容 | JSZip（MIT），贾维斯已经依赖；做法是 Office 文件格式的公开知识 | 自己写 | 大 |
| 9 | **读者测试** | 文档写完后，让一个只拿到成品、不带对话上下文的子代理以读者身份读，列出看不懂、缺依据的地方，再改一轮。可以接到团队模式的审核员上 | 思路来自 `doc-coauthoring`（无许可） | 借鉴思路，自己重写 | 小到中 |
| 10 | **用户自己的 Word 模板** | 用户在工作区放一个 .docx 模板，贾维斯生成时沿用里面的样式（`docx` 库支持导入外部样式），让公司格式一次到位 | `docx`（MIT） | 直接用开源库 | 小到中 |

**不建议做的：**
- 把 QClaw 或 Anthropic 的 docx / pptx / xlsx / pdf 技能文件拿过来，不管原样还是改写；
- 接腾讯文档、智绘高迪这类私有服务；
- 引入 LibreOffice、pandoc、Python 运行时：贾维斯要支持三端，而且规定不引入 Python 运行时。需要转格式的场景，用上面的纯 JS 方案代替。
