# 贾维斯智能体（J.A.R.V.I.S.）

按《贾维斯智能体开发需求文档 v2.0》实现的 Web 应用：实时 WebGL **光核 / 全息胸像** + 情绪表达 + 本地人脸跟随 + 语音对话 + Claude 对话网关。

> v3 起主视觉由“粒子人形 ⇄ 粒子核心”改为全息胸像（应使用方要求：粒子形态不够好看，改为更科幻的全息投影风格），需求文档第三章的点云 / 形变部分不再适用，见下文“v3 全息胸像”。

## 怎么用

### 方式一：单文件版（推荐给只想用的人）

下载仓库根目录的 **`jarvis-standalone.html`**，双击用 Chrome / Edge 打开即可，不用安装任何东西。

- 对话：默认是内置演示助手；在“设置 → Claude API Key”里填自己的密钥，即可直连 Claude（密钥只存在这台电脑的浏览器里）。
- 语音输入 / 朗读：可用（语音识别依赖浏览器自带服务，需要联网）。
- 人脸跟随、语音活动检测：首次开启时从公共 CDN 下载模型（只下载，不上传画面或声音），没联网时自动降级。
- 仪表：没有本机服务，显示的是浏览器能拿到的近似值（页面主线程繁忙度、页面内存、网络状态）。

重新生成：`npm run build:standalone`。

### 方式二：完整版（本机网关 + 真实系统指标）

需要 Node.js 18+。Windows 双击 `jarvis/启动.bat`，Mac / Linux 运行 `jarvis/start.sh`：首次会自动安装依赖、构建并打开浏览器。

手动方式：

```bash
cd jarvis
npm install                 # 会自动把 MediaPipe / VAD / ORT 的 WASM 与人脸模型放到 public/vendor、public/models
npm run build
npm run server              # http://127.0.0.1:8787
# 接入 Claude：
ANTHROPIC_API_KEY=sk-ant-... npm run server
```

开发模式：一个终端 `npm run server`，另一个 `npm run dev`（Vite 把 `/api` 代理到 8787）。

不配置 `ANTHROPIC_API_KEY` 时网关使用**本地演示智能体**（规则回复 + 真实的本机指标工具），整条链路——流式、`emotion_hint`、`task_state`、工具调用——都能离线演示。网关连不上时，前端会自动改在浏览器内运行智能体。

| 命令 | 作用 |
|---|---|
| `npm test` | 单元 + 集成测试（Vitest，75 项） |
| `npm run e2e` | 完整版浏览器冒烟测试（Playwright + Chromium，41 项；需先 build 并启动 server） |
| `npm run e2e:standalone` | 单文件版测试（file:// 直接打开，10 项） |
| `npm run build:standalone` | 生成单文件版 `../jarvis-standalone.html` |
| `npm run build-model` | 重新从 `assets/LeePerrySmith.glb` 生成胸像网格 |

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
