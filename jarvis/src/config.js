/** 运行时配置：资源路径都指向本站自托管文件（scripts/vendor-assets.mjs 生成） */
const base = import.meta.env?.BASE_URL ?? '/';

export const FACE = {
  wasmBase: `${base}vendor/mediapipe`,
  modelUrls: [
    `${base}models/face_landmarker.task`,
    // 自托管模型缺失时的回退：只是下载模型文件，不会上传任何画面
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
  ],
  fps: 15,
  degradedFps: 10,
  budgetMs: 33,
  maxMisses: 30
};

export const VAD = {
  baseAssetPath: `${base}vendor/vad/`,
  onnxWASMBasePath: `${base}vendor/ort/`,
  loadTimeoutMs: 10000
};

export const API = {
  chat: `${base}api/chat`,
  metrics: `${base}api/local/metrics`,
  events: `${base}api/agent/events`,
  metricsIntervalMs: 3000
};

/** 全息胸像：网格 + 元数据（scripts/build-hologram.mjs 生成） */
export const FIGURE = {
  mesh: `${base}models/bust-mesh.bin`,
  meta: `${base}models/bust.json`
};
