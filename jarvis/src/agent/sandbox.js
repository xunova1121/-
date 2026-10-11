/**
 * 代码运行沙箱（智能体“独立编程”的执行环境）：
 *   JavaScript：一次性 Web Worker，捕获 console 输出与返回值，超时强制终止；
 *               Worker 没有 DOM、拿不到页面里的数据（密钥、记忆都在主线程）。
 *   Python：Pyodide（WebAssembly 版 CPython），首次使用时从 CDN 加载约 10MB，之后复用；
 *           运行前把工作区里的小文件放进 /workspace，运行后把新建 / 修改的文件写回工作区。
 */
const JS_TIMEOUT = 8000;

const jsWorkerSource = `
self.onmessage = async ({ data }) => {
  const logs = [];
  const fmt = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch { return String(v); } };
  const push = (k) => (...a) => logs.push((k === 'log' ? '' : '[' + k + '] ') + a.map(fmt).join(' '));
  self.console = { log: push('log'), info: push('log'), warn: push('warn'), error: push('error'), table: push('log') };
  try {
    const fn = new (Object.getPrototypeOf(async function () {}).constructor)(data.code);
    const value = await fn();
    self.postMessage({ ok: true, logs, value: value === undefined ? undefined : fmt(value) });
  } catch (e) {
    self.postMessage({ ok: false, logs, error: String(e && e.stack || e) });
  }
};`;

export function runJavaScript(code, { timeout = JS_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([jsWorkerSource], { type: 'text/javascript' }));
    const w = new Worker(url);
    const done = (r) => { clearTimeout(t); w.terminate(); URL.revokeObjectURL(url); resolve(r); };
    const t = setTimeout(() => done({ ok: false, logs: [], error: `运行超过 ${timeout / 1000} 秒，已终止（可能有死循环）` }), timeout);
    w.onmessage = ({ data }) => done(data);
    w.onerror = (e) => done({ ok: false, logs: [], error: e.message });
    w.postMessage({ code });
  });
}

// ---------------------------------------------------------------- Python（Pyodide）
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const pyWorkerSource = `
importScripts('${PYODIDE}pyodide.js');
let py = null;
self.onmessage = async ({ data }) => {
  const out = [];
  try {
    if (!py) {
      py = await loadPyodide({ indexURL: '${PYODIDE}' });
    }
    py.setStdout({ batched: (s) => out.push(s) });
    py.setStderr({ batched: (s) => out.push('[stderr] ' + s) });
    try { py.FS.mkdir('/workspace'); } catch {}
    for (const f of data.files) {
      const parts = f.path.split('/');
      let dir = '/workspace';
      for (const p of parts.slice(0, -1)) { dir += '/' + p; try { py.FS.mkdir(dir); } catch {} }
      py.FS.writeFile('/workspace/' + f.path, new Uint8Array(f.bytes));
    }
    py.FS.chdir('/workspace');
    await py.loadPackagesFromImports(data.code);
    const before = new Map(data.files.map((f) => [f.path, f.bytes.byteLength]));
    const runStart = Date.now();
    await new Promise((r) => setTimeout(r, 2));
    const value = await py.runPythonAsync(data.code);
    const changed = [];
    const walk = (dir, rel) => {
      for (const name of py.FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const full = dir + '/' + name, r = rel ? rel + '/' + name : name;
        const st = py.FS.stat(full);
        if (py.FS.isDir(st.mode)) walk(full, r);
        else if (!before.has(r) || before.get(r) !== st.size || (st.mtime instanceof Date ? st.mtime.getTime() : st.mtime * 1000) > runStart) {
          const bytes = py.FS.readFile(full);
          if (bytes.byteLength < 20e6) changed.push({ path: r, bytes: bytes.buffer });
        }
      }
    };
    walk('/workspace', '');
    self.postMessage({ ok: true, logs: out, value: value === undefined || value === null ? undefined : String(value), changed });
  } catch (e) {
    self.postMessage({ ok: false, logs: out, error: String(e && e.message || e) });
  }
};`;

let pyWorker = null;
let pyBusy = Promise.resolve();

/**
 * @param {string} code
 * @param {{ files?: Array<{path, bytes: ArrayBuffer}>, timeout?: number }} opts
 */
export function runPython(code, { files = [], timeout = 120000 } = {}) {
  const job = pyBusy.then(() => new Promise((resolve) => {
    if (!pyWorker) pyWorker = new Worker(URL.createObjectURL(new Blob([pyWorkerSource], { type: 'text/javascript' })));
    const w = pyWorker;
    const t = setTimeout(() => {
      w.terminate();
      pyWorker = null;
      resolve({ ok: false, logs: [], error: `运行超过 ${timeout / 1000} 秒，已终止` });
    }, timeout);
    w.onmessage = ({ data }) => { clearTimeout(t); resolve(data); };
    w.onerror = (e) => {
      clearTimeout(t);
      w.terminate();
      pyWorker = null;
      resolve({ ok: false, logs: [], error: `Python 环境加载失败（需要联网下载 Pyodide）：${e.message || '网络错误'}` });
    };
    w.postMessage({ code, files });
  }));
  pyBusy = job.catch(() => {});
  return job;
}
