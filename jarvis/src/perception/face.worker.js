/**
 * 人脸关键点推理 Worker（需求 5.1，路径 B）。
 *
 * 只把 4×4 面部变换矩阵回传给主线程 —— 关键点、blendshape 表情系数都不输出（blendshape 根本不开启），
 * 模型与 WASM 在初始化时从本站 /vendor、/models 下载一次；除此之外的出站请求由 networkGuard 拦截
 * （包括 MediaPipe 自带的使用统计上报）。
 */
import './networkGuard.js';
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

let landmarker = null;

async function init({ wasmBase, modelUrls }) {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, true);
  let lastErr;
  for (const url of modelUrls) {
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: url, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true
      });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      await init(data);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
  } else if (data.type === 'frame') {
    const { bitmap, ts } = data;
    if (!landmarker) {
      bitmap.close();
      return;
    }
    const t0 = performance.now();
    let matrix = null;
    try {
      const res = landmarker.detectForVideo(bitmap, ts);
      const m = res.facialTransformationMatrixes?.[0]?.data;
      if (m) matrix = Array.from(m);
    } catch {
      matrix = null;
    } finally {
      bitmap.close();
    }
    self.postMessage({ type: 'result', matrix, ms: performance.now() - t0 });
  } else if (data.type === 'close') {
    landmarker?.close();
    landmarker = null;
    self.close();
  }
};
