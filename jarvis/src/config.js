/**
 * 运行时配置。正常版：资源都指向本站自托管文件（scripts/vendor-assets.mjs 生成）；
 * 单文件版（__STANDALONE__）：没有自己的服务器，人脸 / 语音检测的 WASM 和模型改从公共 CDN 下载。
 */
const base = import.meta.env?.BASE_URL ?? '/';
export const STANDALONE = typeof __STANDALONE__ !== 'undefined' && __STANDALONE__;
/** 安卓 App（Capacitor 打包）：同单文件版没有自己的服务器 */
export const MOBILE = typeof __MOBILE__ !== 'undefined' && __MOBILE__;
const CDN = {
  mediapipe: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm',
  vad: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/',
  ort: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/'
};
const FACE_MODEL_CDN = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export const FACE = {
  wasmBase: STANDALONE ? CDN.mediapipe : `${base}vendor/mediapipe`,
  // 自托管模型缺失时回退到官方地址：只是下载模型文件，不会上传任何画面
  modelUrls: STANDALONE ? [FACE_MODEL_CDN] : [`${base}models/face_landmarker.task`, FACE_MODEL_CDN],
  fps: 15,
  degradedFps: 10,
  budgetMs: 33,
  maxMisses: 30
};

export const VAD = {
  baseAssetPath: STANDALONE ? CDN.vad : `${base}vendor/vad/`,
  onnxWASMBasePath: STANDALONE ? CDN.ort : `${base}vendor/ort/`,
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
