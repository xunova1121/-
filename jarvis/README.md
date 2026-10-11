# 贾维斯智能体（J.A.R.V.I.S.）

按《贾维斯智能体开发需求文档 v2.0》实现的 Web 应用：实时 WebGL 粒子人形 + 情绪表达 + 本地人脸跟随 + 语音对话 + Claude 对话网关。

```bash
cd jarvis
npm install                 # 会自动把 MediaPipe / VAD / ORT 的 WASM 与人脸模型放到 public/vendor、public/models
npm run build
npm run server              # http://127.0.0.1:8787
# 接入 Claude：
ANTHROPIC_API_KEY=sk-ant-... npm run server
```

开发模式：一个终端 `npm run server`，另一个 `npm run dev`（Vite 把 `/api` 代理到 8787）。

不配置 `ANTHROPIC_API_KEY` 时网关使用**本地演示智能体**（规则回复 + 真实的本机指标工具），整条链路——流式、`emotion_hint`、`task_state`、工具调用——都能离线演示。

| 命令 | 作用 |
|---|---|
| `npm test` | 单元 + 集成测试（Vitest，68 项） |
| `npm run e2e` | 浏览器冒烟测试（Playwright + Chromium，33 项；需先 build 并启动 server） |
| `npm run sample-model` | 重新从 `assets/CesiumMan.glb` 采样点云 |

---

## 架构

```
src/
  main.js                  状态管理层 + 渲染策略控制器（把下面所有东西接起来）
  core/                    纯逻辑，全部有单测
    emotions.js            七种情绪 × 渲染参数表、关键词表
    emotionMachine.js      规则引擎：手动 > API 注入 > 关键词(800ms 防抖) > 任务状态
    keywordScanner.js      最近 200 字滑动窗口打分
    tween.js / spring.js   400ms HSL 过渡、1.2s easeInOutCubic 形变、仪表弹簧
    vadGate.js             VAD → 识别的时序门控（300ms 确认 / 静默阈值提交）
    sentenceChunker.js     流式文本切句送 TTS
    faceMath.js            变换矩阵 → 偏航/俯仰、钳制、指数平滑
    settings.js            localStorage 持久化
  render/                  只在非“减少动画”模式下才动态 import
    particles.js           几何：a_humanPosition / a_spherePosition / a_meta
    shaders.js             顶点着色器内完成形变、轨道、向心流、摆动、人脸朝向
    stage.js               Three.js 场景、渲染循环、暂停原因集合、上下文恢复
  perception/
    face.worker.js         MediaPipe Face Landmarker（Web Worker，只回传 4×4 矩阵）
    networkGuard.js        Worker 出站守卫（见“隐私”）
    faceTracker.js         摄像头、15fps 调度、降级、丢失检测
    voiceInput.js          Silero VAD + SpeechRecognition，失败降级“按下说话”
    speaker.js             SpeechSynthesis 句子队列
  api/                     chat（SSE over fetch）、metrics 轮询、注入事件订阅
  ui/                      dashboard（视差/倾斜/光晕）、transcript
server/
  server.mjs               网关 + 静态资源
  agents.mjs               ClaudeAgent（官方 SDK，流式 + 工具循环）/ MockAgent
  emotionTag.mjs           从回复开头剥离 <emotion>X</emotion> → emotion_hint
  metrics.mjs              本机指标
scripts/
  sample-cesium-man.mjs    GLB → 4600 点泊松盘点云（离线预采样）
  vendor-assets.mjs        自托管 WASM / 模型
```

## 需求对照

### 形态与渲染（第三章）

- **点云**：`scripts/sample-cesium-man.mjs` 解析 GLB，按面积加权取候选点，用“曲率 + 正面剪影度”合成权重做**变半径泊松盘采样**（权重越高半径越小，轮廓更密），二分基准半径得到恰好 4600 点，换算到 Y 向上、身高 100 单位。结果预存为 72KB 的 `public/models/cesium-man-points.bin`，运行时不需要下载 430KB 的 GLB 和 GLTFLoader。
- **粒子核心**：球面层（斐波那契球）、轨道环（总数的 15%，三条倾斜轨道，轨迹在着色器里参数化）、1200 个内部体积粒子（半径 0.3–1.0，越靠核心越稀疏）、billboard 发光核心（径向渐变，强度 `u_coreGlow`）。
- **形变**：`mix(a_humanPosition, a_spherePosition, u_morphFactor)` 在顶点着色器完成；CPU 只更新一个 uniform。每个粒子按种子错开一点起止时间，端点处严格为 0/1，不会跳变。人形高度排序后对应球面纬度，头顶飞向北极。
- **draw calls = 6**（粒子、核心、三条轨道线、星尘）。

### 情绪（第四章）

- 优先级：**手动锁定 > API 注入（流式 `emotion_hint` / 注入端点 ttl）> 关键词 > 任务状态**。
- 关键词：每个 token 后重扫最近 200 字，越新的命中权重越高；候选需连续 800ms 才生效。
- 渲染参数严格按 4.2 的表，切换时 400ms 缓动，色相在 HSL 空间走最短弧。
- 界面与提示词都声明“情绪是表达风格”；状态机只接收文本、API 指令和任务状态，接口上就不存在摄像头/音频特征的入口。

### 人脸跟随（第五章）

选用**路径 B**（直接用 `@mediapipe/tasks-vision` 的 `FaceLandmarker`，放在 Web Worker 里），没有用 `mediapipe-three`：它在主线程跑推理，并把智能体挂到人脸锚点上（会跟着平移），和“只转朝向、不跟随平移”的要求相反。

- 只取偏航/俯仰，丢弃横滚；指数平滑 0.12/帧（按 dt 折算，120Hz 屏延迟一致）；超出 ±45° / ±25° 回到正面；`morph > 0.6` 停用。
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
- `prefers-reduced-motion`（或设置里手动开启）：**在初始化 WebGL 之前**判断，命中就不 import three.js、不下载点云，显示 CSS 渐变；情绪只通过颜色表达。
- 页面隐藏 / 画布离开视口：停渲染循环；隐藏时同时停指标轮询和人脸推理。
- 专注视图：画布缩到左上角，渲染降到 20fps，对话区展开。
- 低端设备（`hardwareConcurrency ≤ 2` 或 `deviceMemory < 4`）：粒子降到 40%，去掉轨道与内部粒子。
- WebGL2 不可用：three r162 自动回退 WebGL1；着色器是 GLSL ES 1.00 写法，不依赖 Transform Feedback，所以两种上下文共用一套。**three 锁定在 0.162.0**，r163 起不再支持 WebGL1。
- 上下文丢失：自动恢复（实测约 420ms）。
- 设置全部存 localStorage。摄像头/麦克风开关只在浏览器**已经授权**时才随页面加载恢复，否则复位为关闭，加载时不会弹权限请求。

## 隐私

- 人脸推理、VAD 都在浏览器本地；摄像头画面不挂到页面，Worker 只回传 4×4 矩阵。
- **MediaPipe 自带使用统计上报**：Tasks Vision 会无条件 `POST https://odml.pa.googleapis.com/v1/log`（任务类型、耗时统计，不含画面），没有公开的关闭选项。e2e 测试抓到了这条请求。`perception/networkGuard.js` 在人脸 Worker 里只放行 GET（下载模型/WASM），其它请求一律拒绝，上报器失败后自行停止。修复后 e2e 中“感知期间无数据外发”通过。
- 自托管全部 WASM 与模型（`scripts/vendor-assets.mjs`），运行时不依赖第三方 CDN；只有自托管模型缺失时才回退到 Google 官方地址**下载**人脸模型。

## 验收情况

自动化验证（`npm test` 68 项 + `npm run e2e` 33 项，全部通过）覆盖：形变 1.2s 完成且单调无跳变；七种情绪的关键词 / 注入 / 任务状态触发与手动覆盖；参数表与 400ms 过渡；对话联动（输入 → 聆听、请求 → 专注、回复 → 安抚、结束 → 亲和 → 3 秒平静）；人脸角度提取、钳制、平滑与 600ms 回正；VAD 时序（300–500ms 确认、800–1000ms 提交）；后台暂停渲染与轮询；专注视图约 20fps；reduced-motion 不加载 3D 资源且颜色仍随情绪变化；Firefox 式降级；人脸 Worker 在假摄像头下启动并报告“未检测到人脸”；VAD 模型加载；感知期间无外发；上下文恢复 ≤ 500ms；手机宽度无横向溢出。

**未能在本环境验证、需要在真机上确认的：**

- **性能指标**（60fps、人脸 + 语音同时开启 ≥ 45fps、CPU ≤ 40%）：容器里只有软件渲染（SwiftShader，约 15fps），数字没有参考意义。
- **真实人脸的跟随手感**（验收 5）：假摄像头里没有人脸。镜像方向（用户向左转头，智能体转向画面哪一侧）由 `faceMath.followTarget` 里的符号决定，真机上如果觉得反了改这一处即可。
- **真实语音识别与播报时延**（验收 8、9）：无头浏览器没有麦克风输入和中文语音包。
- **Claude 真实调用**：本环境没有 `ANTHROPIC_API_KEY`，网关的请求构造、事件映射、工具循环和拒绝处理是用本地模拟的 Messages 流式接口测试的（`tests/claudeAgent.test.mjs`）。

## 署名

Cesium Man model licensed under CC BY 4.0, donated by Cesium（页脚已展示）。模型文件来自 KhronosGroup/glTF-Sample-Assets，原始 GLB 位于 `assets/CesiumMan.glb`。
