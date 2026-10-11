# 贾维斯智能体（J.A.R.V.I.S.）

一个跑在浏览器里的个人智能体：**多家大模型可切换**，会**记忆、积累经验和技能**，有**本地知识库**，能**读写 Word / PDF / PPT / Excel**，能**自己写代码、运行并预览**；配实时 WebGL 光核形象、情绪表达、人脸跟随与语音对话。

> 演进：v2.0 需求文档（粒子人形）→ v3 全息胸像 → v3.1 光核 → **v4 智能体化**（本版）。

## 怎么用

### 方式零：桌面版（推荐）

Windows / Mac / Linux 安装包在仓库的 **Releases** 页面，能直接操作电脑、连接 MCP 工具、托盘常驻、快捷键呼出。详见 [desktop/README.md](desktop/README.md)。

### 方式一：单文件版（下载即用）

下载仓库根目录的 **`jarvis-standalone.html`**（约 5.5 MB），双击用 Chrome / Edge 打开。不用安装、不用联网也能跑（内置离线演示模型）。

1. 左侧“模型”面板选服务商、填 API Key，点“测试连接”。密钥只存在这台电脑的浏览器里。
2. 直接交代任务：“帮我写一个网页”“把这份 PDF 加进知识库”“做一个 PPT”“记住我在上海工作”。
3. 工作区可“连接本地文件夹”：之后生成的文件直接写进这个文件夹（只新增，不删除、不覆盖）。

单文件版的限制：通义千问、Kimi、智谱、豆包，以及很多中转 / 自建接口**不允许网页直接调用**（跨域限制，表现为“Failed to fetch”）。解决办法：双击 `jarvis/启动.bat`（Mac / Linux 运行 `start.sh`）并保持窗口开着——单文件版会**自动连上这个本机网关**（模型面板右上角显示“单文件版 · 已连网关”），之后任何接口都能用。Python 运行首次需联网下载 Pyodide。

> 单文件版跨域使用网关时有三条限制，防止别的网页借用它：不会使用网关环境变量里的密钥（用你在页面里填的）；不转发到内网地址（内网接口由浏览器直连）；只开放模型转发和系统指标，不开放网页读取。

### 方式二：完整版（本机网关）

需要 Node.js 18+。Windows 双击 `jarvis/启动.bat`，Mac / Linux 运行 `jarvis/start.sh`。首次运行自动安装依赖并构建；以后拉取新版本再双击，会自动更新依赖并重新构建。

```bash
cd jarvis
npm install && npm run build
# 密钥可放在网关环境变量里（前端不再需要填写），任选：
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... DEEPSEEK_API_KEY=... DASHSCOPE_API_KEY=... npm run server   # http://127.0.0.1:8787
```

网关提供：`/api/llm/<服务商>/…` 统一代理（解决 CORS，注入环境变量里的密钥）、`/api/fetch` 网页抓取（拒绝内网地址）、真实的本机 CPU / 内存 / GPU 指标。默认只监听 127.0.0.1。

| 命令 | 作用 |
|---|---|
| `npm test` | 单元 + 集成测试（Vitest，150 项） |
| `npm run e2e` | 完整版浏览器测试（Playwright，66 项；需先 build 并启动 server） |
| `npm run e2e:standalone` | 单文件版测试（file:// 直接打开，含“单文件版 + 本机网关”场景，14 项） |
| `xvfb-run -a node e2e/desktop.mjs` | 桌面版测试（启动真正的 Electron 应用，16 项） |
| `npm run build:standalone` | 生成单文件版 `../jarvis-standalone.html` |

## v4 能力一览

### 1. 多模型

| 服务商 | 接入方式 | 单文件版直连 |
|---|---|---|
| Anthropic Claude（默认 Opus 5.5，可选服务端网页搜索） | 原生 Messages API，提示缓存、工具调用、模型自动降级 | ✓ |
| OpenAI、Google Gemini、DeepSeek、硅基流动、OpenRouter、Ollama（本地） | OpenAI 兼容接口，流式 + 工具调用 | ✓ |
| 通义千问、Kimi、智谱 GLM、豆包 | OpenAI 兼容接口 | 需完整版网关 |
| 自定义 | 任意 OpenAI 兼容地址 | 视对方 CORS |
| 离线演示 | 内置规则模型，无需密钥 | ✓ |

所有模型共用同一套智能体循环（`src/agent/agent.js`）和工具，换模型不换能力。

### 2. 自主学习与进化（如实说明）

不训练模型权重；“进化”指智能体**把经验沉淀到本地**并在之后的对话里用上：

- **记忆**：对话中自动或按要求 `remember`，下次按相关度检索注入上下文。
- **经验教训**：回答下方 👍 / 👎，👎 时可写一句“哪里不对”，形成 lesson，之后同类任务会先看到。
- **技能**：完成过的多步任务可存为技能（步骤模板），下次直接复用。
- **等级**：记忆、技能、经验、完成任务数折算成经验值与等级，在“进化”面板查看全部内容，可逐条删除。

### 3. 记忆与知识库

全部存在浏览器 IndexedDB（可在“进化”面板关闭持久化）。知识库支持导入 PDF / Word / PPT / Excel / Markdown / 网页 / 文本，按段切分，BM25 检索（中文按双字切词），回答注明来源。配 Tavily 密钥或 Claude 网页搜索后可查最新资料。

### 4. 文件处理

| 格式 | 读 | 写 |
|---|---|---|
| Word .docx | ✓（mammoth） | ✓（docx） |
| PDF | ✓（pdf.js） | 生成排版好的页面，工作区“导出 PDF”用浏览器打印保存（中文清晰、文件小） |
| PPT .pptx | ✓（解析幻灯片 XML） | ✓（PptxGenJS） |
| Excel .xlsx / .xls / .csv | ✓ | ✓（SheetJS 0.18.5；该版本有已知的原型污染 / ReDoS 问题，只建议打开可信文件） |
| HTML / Markdown / 代码 / 文本 | ✓ | ✓ |

能操作的是**工作区**：浏览器内的虚拟文件夹，或你授权连接的本地文件夹。浏览器出于安全不允许操作其他程序或整个硬盘。

### 5. 编程

工具 `write_file` + `run_javascript`（Worker 沙箱，8 秒超时）+ `run_python`（Pyodide，可读写工作区文件）+ `preview`（工作区内沙箱 iframe 预览网页）：智能体可以写代码 → 运行 → 看结果 → 修改。

### 6. 科幻声线

“模型”面板 →“声音”：

- **引擎**：OpenAI（gpt-4o-mini-tts，用文字“导演”成沉稳、自然的 AI 管家语气，而不是播报腔）、ElevenLabs（最接近真人；可填任意克隆声音 ID）、硅基流动 CosyVoice2（中文自然，需完整版）、自定义 OpenAI 兼容 `/audio/speech`（自建 CosyVoice / GPT-SoVITS 等）、浏览器自带（免费）。“自动”会按已填的密钥挑最自然的云端声音。
- **声线效果**（Web Audio 效果链，只对云端语音生效）：贾维斯（略低沉 + 双声部光泽 + 少量空间）、全息通讯（频带收窄 + 细微金属颤动）、星舰主机（更低沉 + 大空间混响）、原声。效果都很克制，要的是电影里有质感的人声，不是机器人怪声。
- 开口 / 说完时有轻微的科幻提示音（可关）；云端语音播放时光核由**真实音量**驱动。
- 某句合成失败时，这一句自动改用浏览器声音读完并提示原因，不会中断。
- 浏览器自带声音拿不到音频流，无法加效果；免费方案里 Edge 的“Yunjian / Yunxi (Natural)”最自然，会被优先选用。
- 完整版可在网关环境变量里放 `ELEVENLABS_API_KEY`。

### 7. 唤醒词“贾维斯”

设置 → 开启“直接对话”和“唤醒词”：只响应以“贾维斯 / 嘿，贾维斯 / Jarvis”开头的话（也认“嘉维斯”等常见同音识别结果），名字会从指令里去掉；只叫名字时回答“我在。”。唤醒后 20 秒内（每次回答说完重新计时）可以接着说，说“退下”结束。未唤醒时旁人说话不会打断正在进行的回答，也不会显示识别文字。唤醒期间输入栏会发光。

### 8. 技能（可安装）

左侧“技能”面板（`Alt+4`）。技能是一份“做法说明书”：一个文件夹，里面的 `SKILL.md` 用 YAML 头写 `name` / `description`，正文写步骤，可附带模板、参考资料和脚本——与开源 Agent Skills 格式（如 [anthropics/skills](https://github.com/anthropics/skills)）通用。

- **安装**：推荐列表一键安装（6 个内置中文办公技能：周报、会议纪要、汇报 PPT、代码审查、数据分析、中英润色；以及开源仓库里的前端设计、文档协作写作等）；粘贴 GitHub 技能文件夹地址安装；上传 `.zip` 或单个 `SKILL.md`。
- **使用**：系统提示里只列技能名和一句话描述，任务相符时智能体先调用 `use_skill` 读完整说明再照做，需要时用 `read_skill_file` 读附带文件；也可以在输入框输入 `/` 选择技能点名使用。
- **管理**：启用 / 停用开关、查看 SKILL.md、卸载。同名技能重装即更新。
- 只收文本文件（单个 ≤ 256 KB，总计 ≤ 3 MB），二进制文件会列为“未安装”。从 GitHub 安装先用 1 次 API 请求列出文件，再从 raw.githubusercontent.com 下载；接口受限时退回只装 `SKILL.md`。
- 技能内容会交给大模型执行，只安装信任的来源。

### 9. MCP 工具连接

“技能与工具”面板 → MCP：添加本机命令（stdio，如 `npx -y @modelcontextprotocol/server-filesystem D:\资料`）或远程地址（Streamable HTTP，自动退回 SSE）的 MCP 服务；内置文件系统、浏览器自动化（Playwright）、知识图谱记忆、分步思考、高德地图、GitHub、网页抓取等预设。连接后每个工具以 `mcp_服务__工具` 的名字提供给智能体；未勾选“自动允许”的服务，每次调用前在对话里确认。

- 由本机网关管理（`server/mcp.mjs`），桌面版与完整版可用；单文件版不能启动本机程序，所以不支持。
- 配置保存在 `~/.jarvis/mcp.json`（桌面版在应用数据目录），可用 `JARVIS_HOME` 改位置；`JARVIS_NO_MCP=1` 关闭。
- MCP 接口只接受本机贾维斯页面的请求：Host 必须是本机地址（防 DNS 重绑定），有 Origin 时必须同源，并且必须带 `x-jarvis-client` 请求头（跨站请求因此会被预检拦下）。

### 10. 界面

- 欢迎页：按时段问候 + 6 个快捷任务卡片；开始对话后收起。
- 命令面板（`Ctrl+K` / `⌘K`）：搜索并执行任何操作——打开面板、切换形态、开关语音 / 唤醒词 / 人脸跟随、点名技能、新对话；没有匹配时按回车直接把这句话发给贾维斯。
- 舞台 HUD：四角瞄准框、表达 / 任务 / 模型 / 首字延迟 / 技能数、实时时钟与日期。
- 代码块带语言标签和“复制”按钮；消息入场动画（减少动画模式下关闭）。

重做为深色 HUD：顶栏状态与等级、左侧功能栏（`Alt+1…7`）、中间光核与对话、右侧面板（工作区 / 知识库 / 进化 / 模型 / 系统 / 设置）；工具调用以卡片实时展示，支持拖拽上传，窄屏自动改为底部导航。

## v3.1 默认形态改为“光核”

全息真人胸像在暗背景下容易显得吓人（细节多的真人脸 + 发光眼睛，落在“恐怖谷”里），默认形态改为**光核**：一个漂浮在全息底座上的发光能量球，带一双会变形状的眼睛（类似《机器人总动员》里 EVE 的表情方式）。

- **眼睛表达情绪**（400ms 平滑过渡，见 `EYE_SHAPES`）：平静 = 柔和椭圆；专注 = 眯起；聆听 = 睁大；亲和 / 愉悦 = “^ ^” 笑眼；安抚 = “∪ ∪” 温和闭眼；警觉 = 大圆眼 + 红色。
- **有生命感**：每 3–6 秒眨一次眼（偶尔连眨），待机时会随机看一眼别处再看回来；开启人脸跟随时眼睛在球面上滑向你。
- **输入 / 输出分开**：你说话时球面随麦克风起伏，它说话时整体脉动、轮廓与底座变亮。
- 球体按感知亮度归一配色：黄色、青色这类亮色也不会糊成一片，眼睛始终清楚。
- 去掉了随机闪烁与故障切片（只在“警觉”时保留轻微抖动）；胸像也做了平滑处理、改为正面柔光，并去掉脸上的电路线。
- 胸像仍可在输入栏切换：光核 / 胸像 / 线框（`Alt+O / H / W`）；点阵样式移除。
- Draw calls：光核 5、胸像 7；加泛光 4 个 pass，最多 11。

## v3 全息胸像

参照“全息投影胸像”的参考图重做主视觉，去掉粒子形态：

- **胸像本体**：Lee Perry-Smith 头部扫描（CC BY 3.0）。`scripts/build-hologram.mjs` 离线处理：换算坐标、焊接 UV 接缝处的重复顶点并重算平滑法线、删掉嘴部被嘴唇挡住的口腔内层（不删的话加色混合会勾出一个“口罩”状亮框）、定位双眼，输出 311KB 的紧凑网格（运行时直接建 BufferGeometry，不需要 GLTFLoader）。
- **全息着色**：菲涅尔轮廓光 + 细扫描线 + 自下而上扫过的亮带 + 轻微闪烁 + 底部渐隐进投影光柱；随机的“信号不稳”故障切片（警觉 / 愉悦时更频繁）。
- **显示样式**：全息（实体网格）/ 线框（完整三角网）。（v3.1 起默认是光核，点阵样式移除。）
- **电路线**：在正面设计的折线，用射线求交投影到网格表面，画成发光线条，线上有流动的数据脉冲。
- **双眼**发光；**光环**（头后同心弧 + 刻度，缓慢反向旋转）；**全息底座**（同心环、虚线环、放射纹光盘）与**投影光柱**。
- **人脸跟随只转头**：顶点着色器按高度权重混合旋转，脖子自然扭转、肩膀不动；待机时头部有轻微自主摆动。
- **情绪映射**：色相、轮廓光与眼睛亮度（glow）、光环转速与扫描速度（spin）、故障强度（jitter）。输入（麦克风）让表面随音量起伏，输出（播报）点亮轮廓光、眼睛与底座。
- Draw calls：7 个，加泛光 4 个 pass 共 11（≤ 12）。

## v2.1 升级（参考开源项目）

调研了几个同类开源项目，**只借鉴思路、全部自行实现**（其中 ethanplusai/jarvis 仅限非商业使用，没有复制任何代码）：

| 借鉴自 | 思路 | 本项目里的实现 |
|---|---|---|
| [alexanderqchen/orb-ui](https://github.com/alexanderqchen/orb-ui)（MIT） | 输入音量与输出音量分开驱动不同部位 | 麦克风电平 → 胸像表面起伏 + 麦克风按钮外圈；播报 → 轮廓光、眼睛、底座与泛光增强（`speechSynthesis` 不暴露音频流，用词边界事件近似包络，没有事件时合成起伏兜底） |
| [three.js 论坛 Particles Transition Bloom](https://discourse.threejs.org/t/particles-transition-bloom/89382) | 泛光 | 自写 4-pass 轻量泛光（`render/bloom.js`），总 draw call 11，仍在 12 的预算内（v2.1 的粒子旋度流动随粒子形态一起在 v3 移除） |
| [jincocodev/openclaw-jarvis-ui](https://github.com/jincocodev/openclaw-jarvis-ui)（ISC） | 省电模式、带时间戳的聊天、按天的记忆时间线 | 画质档位 自动/高/标准/省电（省电：24fps、无泛光与星尘、关闭毛玻璃）；消息带发送者与时间、回复完成后按极简 Markdown 排版（纯 DOM 构建，不插 HTML）；记忆抽屉按 今天/昨天/日期 分组，可选跨会话保存到本机 |
| [ethanplusai/jarvis](https://github.com/ethanplusai/jarvis) | 打断（barge-in）、每轮时延可见、快捷键 | `Esc` / 停止按钮 / 开始打字 即打断播报与生成；仪表“经验”面板显示首字延迟与生成时长；`/`、`Alt+1–4`、`Alt+F/V/O/H/W`、按住空格说话 |

## 架构

```
src/
  main.js                  状态管理层 + 渲染策略控制器（把下面所有东西接起来）
  core/                    纯逻辑，全部有单测
    emotions.js            七种情绪 × 渲染参数表、关键词表
    emotionMachine.js      规则引擎：手动 > API 注入 > 关键词(800ms 防抖) > 任务状态
    keywordScanner.js      最近 200 字滑动窗口打分
    tween.js / spring.js   400ms HSL 过渡、1.2s easeInOutCubic 形变、仪表弹簧
    quality.js             画质档位解析（泛光 / 星尘 / 帧率上限）
    memoryStore.js         记忆持久化与按天分组
    markdown.js            极简 Markdown → 结构化块
    vadGate.js             VAD → 识别的时序门控（300ms 确认 / 静默阈值提交）
    sentenceChunker.js     流式文本切句送 TTS
    faceMath.js            变换矩阵 → 偏航/俯仰、钳制、指数平滑
    settings.js            localStorage 持久化
  render/                  只在非“减少动画”模式下才动态 import
    shaders.js             全息着色（菲涅尔 / 扫描线 / 光带 / 故障）、只转头的人脸跟随、底座与光环
    stage.js               Three.js 场景、渲染循环、暂停原因集合、上下文恢复
    bloom.js               4-pass 轻量泛光
  perception/
    face.worker.js         MediaPipe Face Landmarker（Web Worker，只回传 4×4 矩阵）
    networkGuard.js        Worker 出站守卫（见“隐私”）
    faceTracker.js         摄像头、15fps 调度、降级、丢失检测
    voiceInput.js          Silero VAD + SpeechRecognition，失败降级“按下说话”
    speaker.js             SpeechSynthesis 句子队列
  api/                     chat（SSE over fetch）、metrics 轮询、注入事件订阅
  ui/                      dashboard（视差/倾斜/光晕）、transcript
shared/                    网关与单文件版共用
  agents.js                ClaudeAgent（官方 SDK，流式 + 工具循环）/ MockAgent，指标来源由调用方注入
  emotionTag.js            从回复开头剥离 <emotion>X</emotion> → emotion_hint
server/
  server.mjs               网关 + 静态资源
  agents.mjs               注入 Node 本机指标与环境变量
  metrics.mjs              本机指标
scripts/
  build-hologram.mjs       头部扫描 → 全息胸像网格、眼睛位置、投影到表面的电路线
  vendor-assets.mjs        自托管 WASM / 模型
```

## 需求对照

### 渲染（第三章，v3 已改为全息胸像）

见上文“v3 全息胸像”。原需求的 Cesium Man 点云、粒子核心与 `u_morphFactor` 形变已移除；情绪表的“变形倾向”一列随之不再使用。

### 情绪（第四章）

- 优先级：**手动锁定 > API 注入（流式 `emotion_hint` / 注入端点 ttl）> 关键词 > 任务状态**。
- 关键词：每个 token 后重扫最近 200 字，越新的命中权重越高；候选需连续 800ms 才生效。
- 渲染参数严格按 4.2 的表，切换时 400ms 缓动，色相在 HSL 空间走最短弧。
- 界面与提示词都声明“情绪是表达风格”；状态机只接收文本、API 指令和任务状态，接口上就不存在摄像头/音频特征的入口。

### 人脸跟随（第五章）

选用**路径 B**（直接用 `@mediapipe/tasks-vision` 的 `FaceLandmarker`，放在 Web Worker 里），没有用 `mediapipe-three`：它在主线程跑推理，并把智能体挂到人脸锚点上（会跟着平移），和“只转朝向、不跟随平移”的要求相反。

- 只取偏航/俯仰，丢弃横滚；指数平滑 0.12/帧（按 dt 折算，120Hz 屏延迟一致）；超出 ±45° / ±25° 回到正面；只有头部转动，肩膀保持不动。
- 15fps / 640×480 起步，推理连续 5 次 > 33ms 降到 10fps / 320×240；连续 30 次无人脸提示“未检测到人脸”，转 2fps 低频探测，找回后自动恢复。
- 不开启 blendshape；Worker 只回传 4×4 矩阵。

### 语音（第六章）

- VAD 采用 `@ricky0123/vad-web`（Silero v5，32ms 帧）。时序：说话 ≥ 300ms 确认、静默 ≥ 800ms（灵敏度低/中/高 = 1200/800/500ms）提交，带迟滞阈值。
- **与需求的一处差异**：识别器在 VAD 刚检测到声音时就打开（pre-roll），300ms 后才“确认”为有效语句（切换聆听、显示识别中）；300ms 内结束的声音视为误触发并丢弃。照字面“300ms 后再启动识别”会把第一个音节切掉，这样做时序表现一致但不丢字。
- `continuous=false` 时 Chrome 会在短停顿后自行结束识别；用户仍在说话（VAD 判定）时自动续开一段并累加文本。
- 播报期间屏蔽 VAD，避免把扬声器里自己的声音当成用户说话（暂不支持插话打断）。
- VAD 加载失败/超时 → “按下说话”；没有 `SpeechRecognition`（Firefox）→ 隐藏麦克风，保留文本输入与语音输出。
- `no-speech` / `aborted` 静默处理，不触发“警觉”。

### API（第七章）

- `POST /api/chat` → SSE，每帧 `{ delta, emotion_hint, task_state, tool? }`。
- Claude 网关：`claude-opus-5-5`（`JARVIS_MODEL` 可改），官方 SDK 流式；`content_block_delta` → `delta`；提示词要求模型在回复开头写 `<emotion>X</emotion>`，网关剥离后作为 `emotion_hint` 下发（模型没写时由前端关键词兜底）；两个本机工具（指标、时间），工具执行期间 `task_state = processing`；`effort: low` 降延迟；开启 `fallbacks: "default"`（安全分类器拒绝时服务端自动换模型重试），`stop_reason: refusal` 时给出礼貌说明。系统提示固定不变（时间通过工具取），历史只回传文本轮次。
- `GET /api/local/metrics`：CPU（`os.cpus()` 差分）、内存、网络（`/proc/net/dev` 吞吐，非 Linux 为 null）。前端每 3 秒轮询，页面隐藏时停止。
- `POST /api/agent/emotion`：需 `Authorization: Bearer $JARVIS_INTERNAL_TOKEN`（未设令牌时只接受本机回环地址），校验情绪名、ttl 上限 10 分钟，通过 `GET /api/agent/events` 推给前端。前端界面只订阅，不提供注入入口。

```bash
curl -X POST http://127.0.0.1:8787/api/agent/emotion \
  -H "Authorization: Bearer $JARVIS_INTERNAL_TOKEN" \
  -d '{"state":"警觉","ttl_ms":5000,"source":"workflow_watcher"}'
```

### 仪表、无障碍、降级（第八–十章）

- 仪表：分层视差 3/7/12px、倾斜 ≤ 6°/3°（弹簧 0.08/0.85）、悬停光晕取指标数值色（>80% 红、<30% 蓝）、移出归位。弹簧收敛后停掉 rAF。
- `prefers-reduced-motion`（或设置里手动开启）：**在初始化 WebGL 之前**判断，命中就不 import three.js、不下载网格，显示 CSS 渐变；情绪只通过颜色表达。
- 页面隐藏 / 画布离开视口：停渲染循环；隐藏时同时停指标轮询和人脸推理。
- 专注视图：画布缩到左上角，渲染降到 20fps，对话区展开。
- 低端设备（`hardwareConcurrency ≤ 2` 或 `deviceMemory < 4`）：画质“自动”档降为标准（无泛光），星尘减少。
- WebGL2 不可用：three r162 自动回退 WebGL1；着色器是 GLSL ES 1.00 写法，不依赖 Transform Feedback，所以两种上下文共用一套。**three 锁定在 0.162.0**，r163 起不再支持 WebGL1。
- 上下文丢失：自动恢复（实测约 420ms）。
- 设置全部存 localStorage。摄像头/麦克风开关只在浏览器**已经授权**时才随页面加载恢复，否则复位为关闭，加载时不会弹权限请求。

## 隐私

- 人脸推理、VAD 都在浏览器本地；摄像头画面不挂到页面，Worker 只回传 4×4 矩阵。
- **MediaPipe 自带使用统计上报**：Tasks Vision 会无条件 `POST https://odml.pa.googleapis.com/v1/log`（任务类型、耗时统计，不含画面），没有公开的关闭选项。e2e 测试抓到了这条请求。`perception/networkGuard.js` 在人脸 Worker 里只放行 GET（下载模型/WASM），其它请求一律拒绝，上报器失败后自行停止。修复后 e2e 中“感知期间无数据外发”通过。
- 自托管全部 WASM 与模型（`scripts/vendor-assets.mjs`），运行时不依赖第三方 CDN；只有自托管模型缺失时才回退到 Google 官方地址**下载**人脸模型。

## 验收情况

自动化验证（`npm test` 75 项 + `npm run e2e` 41 项，全部通过）覆盖：默认光核与三种样式切换（draw call ≤ 12）；七种情绪的关键词 / 注入 / 任务状态触发与手动覆盖；参数表与 400ms 过渡；对话联动（输入 → 聆听、请求 → 专注、回复 → 安抚、结束 → 亲和 → 3 秒平静）；人脸角度提取、钳制、平滑与 600ms 回正；VAD 时序（300–500ms 确认、800–1000ms 提交）；后台暂停渲染与轮询；专注视图约 20fps；reduced-motion 不加载 3D 资源且颜色仍随情绪变化；Firefox 式降级；人脸 Worker 在假摄像头下启动并报告“未检测到人脸”；VAD 模型加载；感知期间无外发；上下文恢复 ≤ 500ms；手机宽度无横向溢出。

**未能在本环境验证、需要在真机上确认的：**

- **性能指标**（60fps、人脸 + 语音同时开启 ≥ 45fps、CPU ≤ 40%）：容器里只有软件渲染（SwiftShader，约 15fps），数字没有参考意义。
- **真实人脸的跟随手感**（验收 5）：假摄像头里没有人脸。镜像方向（用户向左转头，智能体转向画面哪一侧）由 `faceMath.followTarget` 里的符号决定，真机上如果觉得反了改这一处即可。
- **真实语音识别与播报时延**（验收 8、9）：无头浏览器没有麦克风输入和中文语音包。
- **Claude 真实调用**：本环境没有 `ANTHROPIC_API_KEY`，网关的请求构造、事件映射、工具循环和拒绝处理是用本地模拟的 Messages 流式接口测试的（`tests/claudeAgent.test.mjs`）。

## 署名

Head scan by Lee Perry-Smith, licensed under CC BY 3.0（Infinite-Realities，基于 www.triplegangers.com 的作品；页脚已展示）。原始 GLB 来自 three.js 示例（`examples/models/gltf/LeePerrySmith`），位于 `assets/LeePerrySmith.glb`。
