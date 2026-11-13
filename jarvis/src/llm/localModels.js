/**
 * 本机模型（Ollama）：推荐清单 + 经本机网关的检测 / 启动 / 下载 / 删除。
 * 下载走网关转发 Ollama 的 /api/pull，逐行读进度；断了再点一次会从断点继续。
 */
const H = { 'x-jarvis-client': '1', 'content-type': 'application/json' };
const GB = 1024 ** 3;

/**
 * 推荐模型。size：下载大小（GB，约数）；ram：建议内存（GB）；tools：能否调用工具（干活）；vision：能否看图；embed：向量模型
 */
export const LOCAL_CATALOG = [
  { name: 'qwen3:4b', title: '通义千问 3 · 4B', size: 2.6, ram: 8, tools: true, tags: ['中文', '轻快'], desc: '8G 内存电脑的首选：中文好，能调用工具干活' },
  { name: 'qwen3:8b', title: '通义千问 3 · 8B', size: 5.2, ram: 16, tools: true, tags: ['中文', '均衡'], desc: '16G 内存推荐：写作、总结、调用工具都更稳' },
  { name: 'qwen3:14b', title: '通义千问 3 · 14B', size: 9.3, ram: 24, tools: true, tags: ['中文', '更聪明'], desc: '32G 内存或有独显时选它' },
  { name: 'deepseek-r1:8b', title: 'DeepSeek-R1 · 8B', size: 5.2, ram: 16, tools: true, tags: ['推理'], desc: '先思考再回答，适合数学和逻辑题，速度较慢' },
  { name: 'gemma3:4b', title: 'Gemma 3 · 4B', size: 3.3, ram: 8, tools: false, vision: true, tags: ['看图'], desc: '能看图片和截图；不支持调用工具，只能聊天' },
  { name: 'qwen2.5vl:7b', title: '通义千问 2.5-VL · 7B', size: 6.0, ram: 16, tools: false, vision: true, tags: ['看图', '中文'], desc: '中文看图（识别表格、截图里的文字）；只能聊天' },
  { name: 'llama3.2:3b', title: 'Llama 3.2 · 3B', size: 2.0, ram: 8, tools: true, tags: ['英文', '最快'], desc: '最小最快，英文为主' },
  { name: 'bge-m3', title: 'BGE-M3 向量模型', size: 1.2, ram: 4, embed: true, tags: ['向量', '检索'], desc: '让知识库和记忆“按意思检索”，完全在本机，不花钱' }
];

export const catalogEntry = (name) => LOCAL_CATALOG.find((m) => m.name === name || `${m.name}:latest` === name);

/** 按内存挑推荐的对话模型（能调用工具的里面最大的那个） */
export function recommend(ramBytes) {
  const gb = ramBytes / GB;
  const fit = LOCAL_CATALOG.filter((m) => m.tools && m.ram <= Math.max(8, gb + 0.5) && !m.tags.includes('推理') && !m.tags.includes('英文'));
  return (fit.sort((a, b) => b.ram - a.ram)[0] ?? LOCAL_CATALOG[0]).name;
}

export const formatSize = (bytes) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

async function req(origin, path, init = {}) {
  const r = await fetch(`${origin}${path}`, { ...init, headers: { ...H, ...init.headers } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `网关返回 ${r.status}`);
  return j;
}

export const status = (origin) => req(origin, '/api/ollama/status');
export const start = (origin) => req(origin, '/api/ollama/start', { method: 'POST' });
export const remove = (origin, name) => req(origin, `/api/ollama/models/${encodeURIComponent(name)}`, { method: 'DELETE' });

/**
 * 下载模型。onProgress({ status, completed, total, percent })
 * @returns {Promise<void>} 成功时 resolve；Ollama 报错时 reject
 */
export async function pull(origin, name, { onProgress, signal } = {}) {
  const r = await fetch(`${origin}/api/ollama/pull`, { method: 'POST', headers: H, body: JSON.stringify({ model: name }), signal });
  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `网关返回 ${r.status}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ok = false;
  const handle = (line) => {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.error) throw new Error(/not found|does not exist|manifest/i.test(e.error) ? `找不到模型“${name}”，请检查名字（可在 ollama.com/library 查）` : e.error);
    if (e.status === 'success') ok = true;
    const percent = e.total ? Math.min(100, (e.completed || 0) / e.total * 100) : null;
    onProgress?.({ status: e.status, completed: e.completed ?? 0, total: e.total ?? 0, percent });
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach(handle);
  }
  handle(buf);
  if (!ok) throw new Error('下载中断了，再点一次会从断点继续');
}

/** Ollama 的进度状态翻成中文 */
export function statusText(s = '') {
  if (s.startsWith('pulling manifest')) return '获取清单';
  if (s.startsWith('pulling')) return '下载中';
  if (s.startsWith('verifying')) return '校验中';
  if (s.startsWith('writing')) return '写入中';
  if (s === 'success') return '完成';
  return s;
}
