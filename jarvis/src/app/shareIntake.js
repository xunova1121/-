/**
 * 安卓“分享 → 未央”：在相册、微信、文件管理器里选图片 / 文件分享给未央。
 * 原生插件 ShareIntake（android/…/ShareIntakePlugin.java）把文件复制到 App 缓存目录；这里读出来，
 * 交给输入框原有的上传流程 app.addFiles（和点 ＋ 选文件一样：存进工作区“上传/”，附在下一条消息里）；
 * 分享的文字接在输入框末尾。只放进输入框，不自动发送。
 *
 * - 冷启动时分享来的：等启动恢复（接回上次对话）做完再取，免得刚放进去就被切走（main.js 里在 resumeOnStart 之后调 start）
 * - 读完一批就让原生删掉缓存（done）；没读成的原生端 24 小时后自己清
 */
import { toast as defaultToast } from './env.js';

const MAX_TEXT = 20000; // 和原生端一致

export function createShareIntake(
  app,
  {
    plugin = () => globalThis.__jarvisShareIntake,
    fileUrl = (path) => globalThis.Capacitor?.convertFileSrc?.(path),
    fetchImpl = (url) => globalThis.fetch(url),
    toast = defaultToast
  } = {}
) {
  let started = false;
  let running = null;

  async function readFile(f) {
    const url = fileUrl(f.path);
    if (!url) return null;
    const res = await fetchImpl(url).catch(() => null);
    if (!res?.ok) return null;
    const blob = await res.blob();
    return new File([blob], f.name || '分享的文件', { type: f.type || blob.type || 'application/octet-stream' });
  }

  function appendText(text) {
    const t = String(text || '')
      .trim()
      .slice(0, MAX_TEXT);
    const box = app.prompt;
    if (!t || !box) return;
    box.value = box.value.trim() ? `${box.value.replace(/\s+$/, '')}\n${t}` : t;
    app.autosize?.();
  }

  /** 取走原生端攒着的分享；返回放进来的文件个数。同时只跑一次（事件和启动可能同时触发） */
  function takeShared() {
    const native = plugin();
    if (!native || !started) return Promise.resolve(0);
    running ??= (async () => {
      let count = 0;
      try {
        const { batches = [] } = (await native.take()) || {};
        for (const b of batches) {
          const files = [];
          let failed = Number(b.skipped) || 0;
          for (const f of b.files || []) {
            const file = await readFile(f);
            if (file) files.push(file);
            else failed++;
          }
          if (files.length) await app.addFiles(files);
          appendText(b.text);
          if (failed) toast(`有 ${failed} 个文件太大（单个最多 32MB）或读不了，没放进来`);
          count += files.length;
          native.done?.({ id: b.id })?.catch?.(() => {});
        }
      } catch (e) {
        toast(`分享的内容没放进来：${e?.message || e}`);
      } finally {
        running = null;
      }
      return count;
    })();
    return running;
  }

  /** 启动恢复做完后调用：先取冷启动时攒下的，之后每次分享进来（App 已开着）都收 */
  function start() {
    const native = plugin();
    if (!native || started) return;
    started = true;
    native.addListener?.('shared', () => {
      void takeShared();
    });
    void takeShared();
  }

  return { shareIntake: { start, takeShared } };
}
