/**
 * 把感知层运行时需要的 WASM / 模型文件放到 public/ 下自托管（npm install 后自动执行）：
 *
 *   public/vendor/mediapipe/   MediaPipe Tasks Vision 的 WASM（人脸关键点）
 *   public/vendor/vad/         Silero VAD 的 ONNX 模型与 AudioWorklet
 *   public/vendor/ort/         onnxruntime-web 的 WASM
 *   public/models/face_landmarker.task   人脸关键点模型（从 Google 官方存储下载一次）
 *
 * 自托管的意义：运行时不依赖第三方 CDN，内网/离线可用，也更容易审计“没有数据外发”。
 * 这些文件体积大（约 50MB），已在 .gitignore 中排除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const pub = (...p) => path.join(root, 'public', ...p);

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

for (const f of fs.readdirSync(nm('@mediapipe/tasks-vision/wasm'))) {
  copy(nm('@mediapipe/tasks-vision/wasm', f), pub('vendor/mediapipe', f));
}
for (const f of ['silero_vad_v5.onnx', 'silero_vad_legacy.onnx', 'vad.worklet.bundle.min.js']) {
  copy(nm('@ricky0123/vad-web/dist', f), pub('vendor/vad', f));
}
for (const f of fs.readdirSync(nm('onnxruntime-web/dist'))) {
  if (/^ort-wasm-simd-threaded\.(mjs|wasm)$/.test(f)) copy(nm('onnxruntime-web/dist', f), pub('vendor/ort', f));
}

const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const faceOut = pub('models/face_landmarker.task');
if (!fs.existsSync(faceOut)) {
  try {
    const res = await fetch(FACE_MODEL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(faceOut, Buffer.from(await res.arrayBuffer()));
    console.log('已下载人脸模型 →', path.relative(root, faceOut));
  } catch (err) {
    // 下载失败不阻断安装：运行时会回退到官方地址加载（见 src/config.js）
    console.warn('人脸模型下载失败，运行时将回退到官方地址：', err.message);
  }
}
console.log('感知层资源已就绪 → public/vendor');
