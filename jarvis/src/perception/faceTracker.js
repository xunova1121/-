/**
 * 摄像头 + 人脸推理调度（需求 5.3、5.4）。
 *
 *  - 只在用户打开“人脸跟随”后才申请摄像头；stop() 立即停掉所有视频轨道并结束 Worker。
 *  - 推理放在 Worker 里，每次只允许一帧在途（背压），主线程 WebGL 渲染不被阻塞。
 *  - 15fps / 640×480 起步；推理耗时持续 > 33ms 时降到 10fps / 320×240。
 *  - 连续 30 次未检测到人脸：提示“未检测到人脸”，降到 2fps 低频探测，找回后自动恢复。
 */
import { yawPitchFromMatrix } from '../core/faceMath.js';
import { FACE } from '../config.js';

export class FaceTracker {
  constructor({ onAngles, onStatus } = {}) {
    this.onAngles = onAngles;
    this.onStatus = onStatus;
    this.stream = null;
    this.video = null;
    this.worker = null;
    this.timer = 0;
    this.inflight = false;
    this.fps = FACE.fps;
    this.size = { w: 640, h: 480 };
    this.degraded = false;
    this.misses = 0;
    this.lost = false;
    this.slowStreak = 0;
    this.paused = false;
    this.lastMs = 0;
  }

  get active() {
    return Boolean(this.stream);
  }

  async start() {
    if (this.stream) return;
    this.onStatus?.('starting');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 640, height: 480 },
      audio: false
    });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.stream;
    await video.play();
    this.video = video;

    this.worker = new Worker(new URL('./face.worker.js', import.meta.url), { type: 'module' });
    await new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'ready') resolve();
        else if (data.type === 'error') reject(new Error(data.message));
      };
      this.worker.postMessage({ type: 'init', wasmBase: FACE.wasmBase, modelUrls: FACE.modelUrls });
    }).catch((err) => {
      this.stop();
      throw err;
    });
    this.worker.onmessage = ({ data }) => this.#onResult(data);
    this.onStatus?.('tracking');
    this.#schedule();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.worker?.postMessage({ type: 'close' });
    this.worker?.terminate();
    this.worker = null;
    this.inflight = false;
    this.misses = 0;
    this.lost = false;
    this.onAngles?.(null);
    this.onStatus?.('off');
  }

  /** 页面隐藏时暂停推理（摄像头保持打开，避免重新授权） */
  setPaused(on) {
    this.paused = on;
    if (!on && this.stream && !this.timer) this.#schedule();
  }

  #interval() {
    return 1000 / (this.lost ? 2 : this.fps);
  }

  #schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#tick(), this.#interval());
  }

  async #tick() {
    this.timer = 0;
    if (!this.stream || this.paused) return;
    if (!this.inflight && this.video?.readyState >= 2) {
      this.inflight = true;
      try {
        const bitmap = await createImageBitmap(this.video, {
          resizeWidth: this.size.w,
          resizeHeight: this.size.h,
          resizeQuality: 'low'
        });
        this.worker?.postMessage({ type: 'frame', bitmap, ts: performance.now() }, [bitmap]);
      } catch {
        this.inflight = false;
      }
    }
    if (this.stream) this.#schedule();
  }

  #onResult({ type, matrix, ms }) {
    if (type !== 'result') return;
    this.inflight = false;
    this.lastMs = ms;

    if (!this.degraded) {
      this.slowStreak = ms > FACE.budgetMs ? this.slowStreak + 1 : 0;
      if (this.slowStreak >= 5) {
        this.degraded = true;
        this.fps = FACE.degradedFps;
        this.size = { w: 320, h: 240 };
        this.onStatus?.('degraded');
      }
    }

    if (!matrix) {
      this.misses++;
      if (this.misses >= FACE.maxMisses && !this.lost) {
        this.lost = true;
        this.onStatus?.('lost');
      }
      this.onAngles?.(null);
      return;
    }
    this.misses = 0;
    if (this.lost) {
      this.lost = false;
      this.onStatus?.(this.degraded ? 'degraded' : 'tracking');
    }
    this.onAngles?.(yawPitchFromMatrix(matrix));
  }
}
