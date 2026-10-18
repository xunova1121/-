import { MOBILE } from '../config.js';
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
  let logged=0;
  const push = (k) => (...a) => {if(logs.length>=200||logged>=128000)return;const line=((k==='log'?'':'['+k+'] ')+a.map(fmt).join(' ')).slice(0,4000);logged+=line.length;logs.push(line);};
  self.console = { log: push('log'), info: push('log'), warn: push('warn'), error: push('error'), table: push('log') };
  try {
    const fn = new (Object.getPrototypeOf(async function () {}).constructor)(data.code);
    const value = await fn();
    self.postMessage({ ok: true, logs, value: value === undefined ? undefined : fmt(value).slice(0,64000) });
  } catch (e) {
    self.postMessage({ ok: false, logs, error: String(e && e.stack || e) });
  }
};`;

/** 一次性不透明来源 iframe 内的 Worker；CSP 禁止联网，不能访问应用存储。 */
export function runJavaScript(code, { timeout = JS_TIMEOUT, signal } = {}) {
  return new Promise(resolve => {
    if(typeof document==='undefined'){resolve({ok:false,logs:[],error:'当前环境没有浏览器隔离执行器'});return;}
    const frame=document.createElement('iframe');frame.hidden=true;frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('aria-hidden','true');
    const token=crypto.randomUUID();let finished=false;
    const done=result=>{if(finished)return;finished=true;clearTimeout(timer);removeEventListener('message',receive);signal?.removeEventListener('abort',abort);try{frame.contentWindow?.postMessage({token,stop:true},'*');}catch{}frame.remove();resolve(result);};
    const receive=e=>{if(e.source===frame.contentWindow&&e.data?.token===token)done(e.data.result);};
    const abort=()=>done({ok:false,logs:[],error:'已停止运行'});
    const timer=setTimeout(()=>done({ok:false,logs:[],error:'运行超过 '+timeout/1000+' 秒，已终止（可能有死循环）'}),timeout);
    addEventListener('message',receive);signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    const bootstrap=(workerSource,token)=>{
      let worker=null;
      addEventListener('message',e=>{
        if(e.source!==parent||e.data?.token!==token)return;
        if(e.data.stop){worker?.terminate();return;}
        if(worker)return;
        const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);
        worker.onmessage=ev=>{parent.postMessage({token,result:ev.data},'*');worker.terminate();};
        worker.onerror=ev=>{parent.postMessage({token,result:{ok:false,logs:[],error:ev.message}},'*');worker.terminate();};
        worker.postMessage({code:e.data.code});
      });
    };
    frame.srcdoc='<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\' blob:; worker-src blob:; connect-src \'none\'"><script>('+bootstrap.toString()+')('+JSON.stringify(jsWorkerSource)+','+JSON.stringify(token)+')<'+ '/script>';
    frame.onload=()=>{if(!finished)frame.contentWindow.postMessage({token,code:String(code)},'*');};document.body.append(frame);
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
    if (!pyWorker) {
      const url = URL.createObjectURL(new Blob([pyWorkerSource], { type: 'text/javascript' }));
      pyWorker = new Worker(url); URL.revokeObjectURL(url);
    }
    const w = pyWorker;
    const t = setTimeout(() => {
      w.terminate();
      pyWorker = null;
      resolve({ ok: false, logs: [], error: `运行超过 ${timeout / 1000} 秒，已终止` });
    }, timeout);
    w.onmessage = ({ data }) => { clearTimeout(t); if (MOBILE) { w.terminate(); pyWorker = null; } resolve(data); };
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
