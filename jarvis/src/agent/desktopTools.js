/**
 * 桌面版专属工具：直接操作这台电脑（任意文件夹、打开程序、运行命令、截屏、剪贴板）。
 * 只在 Electron 桌面版里出现；实际操作由主进程执行（desktop/main.cjs），
 * 写入、移动、删除、打开、运行命令、读剪贴板都会先在对话里征得用户同意。
 */
import * as ws from './workspace.js';
import { parseFile } from './docs.js';
import { isImageName, prepareImage } from './images.js';

const S = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const clip = (s, n = 20000) => (s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字）` : s);
const DOC = /\.(docx|pdf|pptx|xlsx|xls|ods)$/i;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function blobToB64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const fmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * @param {{ invoke: (op: string, args?: object) => Promise<any>, platform: string }} desktop
 * @param {{ onFileChanged?: (path: string) => void }} ctx
 */
export function createDesktopTools(desktop, ctx = {}) {
  const call = (op, args) => desktop.invoke(op, args);
  const PATH_HINT = '可以用绝对路径，或以 ~、桌面、文档、下载 开头（如“桌面/报告.docx”）';
  return [
    {
      name: 'computer_list_dir',
      description: `列出电脑上某个文件夹的内容（文件名、大小、修改时间）。${PATH_HINT}。`,
      input_schema: S({ path: str('文件夹路径') }, ['path']),
      run: async ({ path }) => {
        const r = await call('listDir', { path });
        if (!r.entries.length) return `${r.path} 是空文件夹。`;
        return `${r.path}（${r.entries.length} 项${r.truncated ? '，只显示前 300 项' : ''}）\n${r.entries.map((e) => `${e.dir ? '[文件夹]' : `[${fmt(e.size)}]`} ${e.name}  ${new Date(e.mtime).toLocaleString('zh-CN', { hour12: false })}`).join('\n')}`;
      }
    },
    {
      name: 'computer_search',
      description: '在电脑的某个文件夹（含子文件夹）里按文件名搜索。',
      input_schema: S({ dir: str(`从哪个文件夹开始搜索。${PATH_HINT}`), keyword: str('文件名里包含的关键词') }, ['dir', 'keyword']),
      run: async ({ dir, keyword }) => {
        const r = await call('search', { dir, keyword });
        return r.hits.length ? `找到 ${r.hits.length} 个${r.truncated ? '（只显示前 50 个）' : ''}：\n${r.hits.join('\n')}` : `在 ${r.dir} 里没有找到文件名包含「${keyword}」的文件。`;
      }
    },
    {
      name: 'computer_read_file',
      description: `读取电脑上的文件内容（Word、PDF、PPT、Excel 会提取文字；代码与文本原样返回；图片会直接给你看）。${PATH_HINT}。`,
      input_schema: S({ path: str('文件路径') }, ['path']),
      run: async ({ path }) => {
        const r = await call('readFile', { path });
        const name = r.path.split(/[\\/]/).pop();
        if (isImageName(name)) {
          const img = await prepareImage(new Blob([b64ToBytes(r.base64)]));
          return { text: `图片 ${r.path}（${img.width}×${img.height}）`, images: [{ mime: img.mime, data: img.data }] };
        }
        if (DOC.test(name)) return clip((await parseFile(new Blob([b64ToBytes(r.base64)]), name)).text);
        return clip(new TextDecoder().decode(b64ToBytes(r.base64)));
      }
    },
    {
      name: 'computer_write_file',
      description: `把文本内容写入电脑上的文件（代码、Markdown、CSV、网页等；会覆盖同名文件）。Word / PPT / Excel 请先用 create_document 在工作区生成，再用 computer_save_from_workspace 保存到电脑。${PATH_HINT}。`,
      input_schema: S({ path: str('目标文件路径'), content: str('文件内容') }, ['path', 'content']),
      approval: ({ path, content }) => ({ key: 'fs-write', title: `写入文件：${path}`, detail: content.slice(0, 600) }),
      run: async ({ path, content }) => {
        const r = await call('writeFile', { path, text: content });
        return `已写入 ${r.path}（${fmt(r.size)}）。`;
      }
    },
    {
      name: 'computer_save_from_workspace',
      description: '把工作区里的文件（如刚生成的 docx / pptx / xlsx / 网页）保存到电脑上的指定位置。',
      input_schema: S({ workspace_path: str('工作区里的文件路径'), dest_path: str(`保存到电脑的路径（含文件名）。${PATH_HINT}`) }, ['workspace_path', 'dest_path']),
      approval: ({ workspace_path: from, dest_path: to }) => ({ key: 'fs-write', title: `保存到电脑：${to}`, detail: `来源：工作区/${from}` }),
      run: async ({ workspace_path: from, dest_path: to }) => {
        const blob = await ws.readBlob(from);
        const r = await call('writeFile', { path: to, base64: await blobToB64(blob) });
        return `已保存到 ${r.path}（${fmt(r.size)}）。`;
      }
    },
    {
      name: 'computer_move',
      description: '移动或重命名电脑上的文件 / 文件夹。',
      input_schema: S({ from: str('原路径'), to: str('新路径（含新名称）') }, ['from', 'to']),
      approval: ({ from, to }) => ({ key: 'fs-move', title: '移动 / 重命名', detail: `${from}\n→ ${to}` }),
      run: async ({ from, to }) => { const r = await call('move', { from, to }); return `已移动到 ${r.path}。`; }
    },
    {
      name: 'computer_copy',
      description: '复制电脑上的文件 / 文件夹。',
      input_schema: S({ from: str('原路径'), to: str('复制到的路径（含名称）') }, ['from', 'to']),
      approval: ({ from, to }) => ({ key: 'fs-write', title: '复制', detail: `${from}\n→ ${to}` }),
      run: async ({ from, to }) => { const r = await call('copy', { from, to }); return `已复制到 ${r.path}。`; }
    },
    {
      name: 'computer_trash',
      description: '把电脑上的文件 / 文件夹移到回收站（可以从回收站恢复）。',
      input_schema: S({ path: str('路径') }, ['path']),
      approval: ({ path }) => ({ key: 'fs-trash', title: `移到回收站：${path}` }),
      run: async ({ path }) => { const r = await call('trash', { path }); return `已把 ${r.path} 移到回收站。`; }
    },
    {
      name: 'computer_open',
      description: '用系统默认程序打开文件、文件夹或网址；也可以打开程序（填程序名，如“记事本”“计算器”“微信”“Visual Studio Code”）。',
      input_schema: S({ target: str('文件路径、文件夹路径、网址或程序名') }, ['target']),
      approval: ({ target }) => ({ key: 'open', title: `打开：${target}` }),
      run: async ({ target }) => { const r = await call('open', { target }); return r.message; }
    },
    {
      name: 'computer_run',
      description: `在这台电脑上运行一条命令（${desktop.platform === 'win32' ? 'Windows PowerShell' : 'bash / zsh'}），返回输出。用于查看系统信息、批量处理文件、调用已安装的命令行工具等。不要运行会删除数据或修改系统设置的命令。`,
      input_schema: S({ command: str('要运行的命令'), cwd: str('工作目录（可选）') }, ['command']),
      approval: ({ command, cwd }) => ({ key: 'run', title: '运行命令', detail: `${cwd ? `[${cwd}] ` : ''}${command}` }),
      run: async ({ command, cwd }) => {
        const r = await call('run', { command, cwd });
        return clip([`退出码：${r.code}${r.timedOut ? '（超时被终止）' : ''}`, r.stdout && `输出：\n${r.stdout}`, r.stderr && `错误输出：\n${r.stderr}`].filter(Boolean).join('\n'), 12000);
      }
    },
    {
      name: 'computer_screenshot',
      description: '截取整个屏幕，保存到工作区（截图/）。look=true（默认）时截图会发给你看，可以分析屏幕上的界面、报错、表格等；只想存档时设 look=false。',
      input_schema: S({ look: { type: 'boolean', description: '是否把截图发给模型查看，默认 true' } }),
      approval: ({ look }) => (look === false ? null : { key: 'screen-look', title: '查看屏幕截图', detail: '截图会发送给当前使用的大模型服务进行分析。' }),
      run: async ({ look } = {}) => {
        const r = await call('screenshot');
        const path = `截图/屏幕-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
        const blob = new Blob([b64ToBytes(r.base64)], { type: 'image/png' });
        const saved = (await ws.write(path, blob))?.path || path;
        ctx.onFileChanged?.(saved);
        const text = `已截屏（${r.width}×${r.height}），保存到工作区 ${saved}。`;
        if (look === false) return text;
        const img = await prepareImage(blob);
        return { text, images: [{ mime: img.mime, data: img.data }] };
      }
    },
    {
      name: 'clipboard_read',
      description: '读取剪贴板里的文字。',
      input_schema: S({}),
      approval: () => ({ key: 'clipboard-read', title: '读取剪贴板（内容会发给大模型）' }),
      run: async () => { const r = await call('clipboardRead'); return r.text ? clip(r.text) : '剪贴板里没有文字。'; }
    },
    {
      name: 'clipboard_write',
      description: '把文字放进剪贴板，方便用户粘贴。',
      input_schema: S({ text: str('文字') }, ['text']),
      run: async ({ text }) => { await call('clipboardWrite', { text }); return '已复制到剪贴板。'; }
    },
    {
      name: 'computer_notify',
      description: '弹出系统通知（例如长任务完成时提醒用户）。',
      input_schema: S({ title: str('标题'), body: str('内容') }, ['title']),
      run: async ({ title, body }) => { await call('notify', { title, body }); return '已通知。'; }
    }
  ];
}
