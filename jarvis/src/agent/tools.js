/**
 * 智能体工具。每个工具：name / description / input_schema（JSON Schema）/ run(args) → 字符串结果。
 * 参数在执行前统一校验（流式工具参数可能被截断，模型偶尔也会漏参数），不合格就返回明确的错误让模型自行修正。
 */
import * as ws from './workspace.js';
import * as memory from './memory.js';
import * as kb from './knowledge.js';
import { parseFile, generate, htmlToText } from './docs.js';
import { runJavaScript, runPython } from './sandbox.js';
import * as packs from './skillPacks.js';
import { isImageName, prepareImage } from './images.js';
import * as scheduler from './scheduler.js';
import * as sessions from './sessions.js';
import { createSearch } from './webSearch.js';
import { deepResearch, DEPTHS } from './research.js';

const S = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
/**
 * run_python 要带进 Python 环境的工作区文件：代码里提到的文件、以及提到的文件夹（如 skills/某技能）里的文件优先，
 * 其余按新近排，总共不超过 300 个 / 150 MB（技能模板可能很大）。
 */
export function pickPythonFiles(list, code, { maxFiles = 300, maxBytes = 150e6 } = {}) {
  const src = String(code);
  const mentioned = (path) => {
    if (src.includes(path)) return 2;
    const parts = path.split('/');
    for (let i = parts.length - 1; i > 0; i--) if (src.includes(parts.slice(0, i).join('/'))) return 1;
    return 0;
  };
  const ranked = list.filter((f) => f.size < 30e6).map((f) => ({ f, score: mentioned(f.path) }))
    .sort((a, b) => b.score - a.score || (b.f.mtime ?? 0) - (a.f.mtime ?? 0));
  const out = [];
  let bytes = 0;
  for (const { f } of ranked) {
    if (out.length >= maxFiles || bytes + f.size > maxBytes) continue;
    out.push(f);
    bytes += f.size;
  }
  return out;
}
const clip = (s, n = 20000) => (s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字）` : s);

/**
 * @param {object} ctx
 * @param {() => Promise<object>} ctx.metrics
 * @param {(path: string) => void} [ctx.onPreview]
 * @param {(path: string) => void} [ctx.onFileChanged]
 * @param {(url: string, init?: object) => Promise<Response>} [ctx.fetchViaGateway]  有网关时绕过浏览器跨域限制
 * @param {string} [ctx.tavilyKey]
 * @param {((p: { system: string, prompt: string, signal?: AbortSignal }) => Promise<string>) | null} [ctx.llm]  深度调研用的大模型（内置演示时为空）
 */
export function createTools(ctx) {
  const tools = [
    {
      name: 'remember',
      description: '把关于用户的长期信息存入记忆（偏好、身份、习惯、目标、重要事实）。用户说“记住……”或透露了以后用得上的个人信息时调用。和已有记忆重复会自动合并，同一件事的新说法会自动取代旧的（旧版本保留为历史）。不要记录密码、密钥等敏感信息。',
      input_schema: S({
        content: str('要记住的一句话，用第三人称陈述，如“用户喜欢简洁的回答”'),
        category: { type: 'string', enum: ['profile', 'preference', 'fact', 'goal', 'other'], description: 'profile 身份 / preference 偏好 / fact 事实 / goal 目标' },
        importance: { type: 'integer', minimum: 1, maximum: 5, description: '重要度 1–5，身份信息和明确的长期偏好给 4–5' }
      }, ['content']),
      run: async ({ content, category, importance }) => {
        const m = await memory.remember(content, category, { importance });
        return m.action === 'NOOP' ? `这条已经记得（${m.content}），已刷新。`
          : m.action === 'UPDATE' ? `已更新记忆：「${m.previous}」→「${m.content}」（旧的保留为历史）。`
            : `已记住（${m.content}）。`;
      }
    },
    {
      name: 'recall',
      description: '在长期记忆和过往对话摘要中检索与问题相关的内容。',
      input_schema: S({ query: str('检索关键词或问题') }, ['query']),
      run: async ({ query }) => {
        const r = await memory.recall(query);
        const lines = [
          ...r.memories.map((m) => `- [${m.id}] ${m.content}（${memory.CATEGORIES[m.category] ?? '其他'}，重要度 ${m.importance}${m.history?.length ? `，更新过 ${m.history.length} 次` : ''}）`),
          ...r.episodes.map((e) => `- [对话 ${new Date(e.ts).toLocaleDateString('zh-CN')}] ${e.summary}`)
        ];
        return lines.length ? lines.join('\n') : '没有相关记忆。';
      }
    },
    {
      name: 'forget',
      description: '让一条记忆失效（用户要求忘掉某事时）。先用 recall 找到 id。失效的记忆归档保存，不再出现在上下文里。',
      input_schema: S({ id: str('记忆 id') }, ['id']),
      run: async ({ id }) => { await memory.forget(id); return '已忘记。'; }
    },
    {
      name: 'core_memory_update',
      description: '改写核心记忆（每轮对话都会带上的两段简短文字）。human：关于用户最重要的信息（称呼、身份、长期目标、沟通偏好）；persona：你在这位用户面前的设定（语气、称呼方式、约定）。用整段新内容替换旧内容，保留仍然有效的信息，控制在 300 字以内。',
      input_schema: S({ block: { type: 'string', enum: ['human', 'persona'] }, content: str('新的完整内容') }, ['block', 'content']),
      run: async ({ block, content }) => { const t = await memory.setCore(block, content); return `核心记忆（${block === 'human' ? '关于用户' : '我的设定'}）已更新，共 ${t.length} 字。`; }
    },
    {
      name: 'save_skill',
      description: '把刚刚完成的、以后可复用的做法保存为技能（例如“生成周报的格式与步骤”）。同名技能会升级为新版本。只在多步任务成功后、且方法确实可复用时调用。',
      input_schema: S({ name: str('技能名称'), description: str('什么情况下用'), steps: str('具体步骤 / 模板 / 要点') }, ['name', 'steps']),
      run: async (a) => { const s = await memory.saveSkill(a); return `技能「${s.name}」已保存（v${s.version}）。`; }
    },
    {
      name: 'use_skill',
      description: '读取一个已安装技能的完整说明（SKILL.md）。任务与“已安装的技能”里某个技能的描述相符，或用户用“/技能名”点名时，先调用它，再按说明执行。',
      input_schema: S({ name: str('技能名称') }, ['name']),
      run: async ({ name }) => {
        const p = await packs.get(name);
        if (!p) return `没有名为「${name}」的技能。已安装：${(await packs.enabled()).map((x) => x.name).join('、') || '无'}`;
        if (!p.enabled) return `技能「${name}」已被用户停用。`;
        return clip(packs.render(p), 30000);
      }
    },
    {
      name: 'read_skill_file',
      description: '读取技能附带的文本文件（参考资料、模板说明、脚本），路径来自 use_skill 返回的文件列表。',
      input_schema: S({ name: str('技能名称'), path: str('文件相对路径') }, ['name', 'path']),
      run: async ({ name, path }) => {
        const p = await packs.get(name);
        const f = p?.files?.[path.replace(/^\.?\//, '')];
        if (f == null) throw new Error(`技能「${name}」里没有文件 ${path}`);
        if (packs.isBinaryFile(f)) return `${path} 是二进制文件（${Math.round(f.size / 1024)} KB），不能直接读。用 copy_skill_file 复制到工作区，再用 run_python 处理（例如 python-pptx 打开 .pptx 模板）。`;
        const text = await packs.fileText(f);
        return text.length > 30000 ? `${text.slice(0, 30000)}\n…（文件很大，共 ${text.length} 字，只显示了开头。完整内容请 copy_skill_file 到工作区后用 run_python 按需读取，例如 json.load 后只打印需要的部分）` : text;
      }
    },
    {
      name: 'copy_skill_file',
      description: '把技能附带的文件复制到工作区（模板 .pptx / .docx / .xlsx、图片、脚本等），之后 run_python 可以在 /workspace 下读到。path 以 / 结尾时复制整个文件夹（如 "scripts/"、"templates/某模板/"）。在线附件会自动下载。',
      input_schema: S({ name: str('技能名称'), path: str('文件或文件夹的相对路径（use_skill 的文件列表里）'), to: str('复制到工作区的路径（可选，只对单个文件有效；默认 skills/技能名/原路径）') }, ['name', 'path']),
      run: async ({ name, path, to }, { progress } = {}) => {
        const p = await packs.get(name);
        if (!p) throw new Error(`没有名为「${name}」的技能`);
        const rel = String(path).replace(/^\.?\//, '');
        const all = Object.keys(p.files || {});
        const folder = rel === '' || rel.endsWith('/') ? rel : all.some((k) => k.startsWith(`${rel}/`)) && !p.files[rel] ? `${rel}/` : null;
        const list = folder !== null ? all.filter((k) => k.startsWith(folder)) : [rel];
        if (!list.length || (folder === null && p.files[rel] == null)) throw new Error(`技能「${name}」里没有 ${path}（可用：${all.slice(0, 20).join('、') || '无'}）`);
        if (list.length > 60) throw new Error(`${path} 下有 ${list.length} 个文件，太多了：请复制更具体的子文件夹或单个文件`);
        const out = [];
        let bytes = 0;
        for (const [n, k] of list.entries()) {
          if (packs.isRemoteFile(p.files[k])) progress?.(`正在下载 ${k}（${n + 1}/${list.length}）`);
          const blob = await packs.fileBlob(p.files[k]);
          const w = await ws.write(folder === null && to ? to : `skills/${p.name}/${k}`, blob);
          ctx.onFileChanged?.(w.path);
          out.push(w.path);
          bytes += blob.size;
        }
        return out.length === 1
          ? `已复制到工作区：${out[0]}（${Math.round(bytes / 1024)} KB）。在 run_python 里的路径是 /workspace/${out[0]}`
          : `已复制 ${out.length} 个文件（${(bytes / 1048576).toFixed(1)} MB）到工作区 skills/${p.name}/${folder}：\n${out.map((x) => `- /workspace/${x}`).join('\n')}`;
      }
    },
    {
      name: 'show_image',
      description: '把工作区里的一张图片（png / jpg / webp / gif / svg）显示在对话里给用户看，例如模板预览图、图表。',
      input_schema: S({ path: str('工作区里的图片路径') }, ['path']),
      run: async ({ path }) => {
        if (!(await ws.exists(path))) throw new Error(`找不到文件：${path}`);
        const blob = await ws.readBlob(path);
        const type = /\.svg$/i.test(path) ? 'image/svg+xml' : blob.type || 'image/png';
        ctx.onImage?.(URL.createObjectURL(new Blob([blob], { type })), path);
        return `已在对话里显示 ${path}`;
      }
    },
    {
      name: 'generate_image',
      description: '画图 / 生成图片（海报、插画、头像、配图等）：用服务商的画图模型（如 gpt-image）按描述生成一张图片，保存到工作区并显示在对话里。用户说“画一张… / 做个…的图片 / 生成图片”时使用。描述写具体：主体、风格、色调、构图。',
      input_schema: S({ prompt: str('图片描述（中英文都可以，越具体越好）'), size: str('尺寸：1024x1024（默认）、1536x1024（横图）、1024x1536（竖图）') }, ['prompt']),
      run: async ({ prompt, size }) => {
        if (!ctx.imageGen) throw new Error('当前环境不能画图');
        const r = await ctx.imageGen({ prompt, size: /^\d+x\d+$/.test(size || '') ? size : '1024x1024' });
        const ext = /jpe?g/.test(r.blob.type) ? 'jpg' : /webp/.test(r.blob.type) ? 'webp' : 'png';
        const name = String(prompt).replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16) || 'image';
        const w = await ws.write(`images/${name}-${Date.now().toString(36)}.${ext}`, r.blob);
        ctx.onFileChanged?.(w.path);
        ctx.onImage?.(URL.createObjectURL(r.blob), w.path);
        return `已生成图片（${r.model}）并显示在对话里，保存在工作区 ${w.path}。${r.revised ? `模型改写后的描述：${r.revised}` : ''}`;
      }
    },
    {
      name: 'generate_video',
      description: '生成视频（短片、动画、产品展示、风景镜头等）：用服务商的视频模型（如 sora / veo / kling）按描述生成一段几秒的视频，保存到工作区并显示在对话里。用户说“生成一段视频 / 做个…的视频 / 拍一段…”时使用。需要一到几分钟。描述写具体：画面主体、动作、镜头运动、风格、光线。',
      input_schema: S({ prompt: str('视频描述（中英文都可以，越具体越好）'), seconds: { type: 'number', description: '时长（秒），默认由模型决定，常见 4 / 5 / 8 / 10' }, size: str('分辨率，如 1280x720（横屏，默认）、720x1280（竖屏）') }, ['prompt']),
      run: async ({ prompt, seconds, size }, { progress, signal } = {}) => {
        if (!ctx.videoGen) throw new Error('当前环境不能生成视频');
        const r = await ctx.videoGen({ prompt, seconds: Number(seconds) > 0 ? Number(seconds) : undefined, size: /^\d+x\d+$/.test(size || '') ? size : undefined, signal, onProgress: (t) => progress?.(t) });
        const ext = /webm/.test(r.blob.type) ? 'webm' : /quicktime/.test(r.blob.type) ? 'mov' : 'mp4';
        const name = String(prompt).replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16) || 'video';
        const w = await ws.write(`videos/${name}-${Date.now().toString(36)}.${ext}`, r.blob);
        ctx.onFileChanged?.(w.path);
        ctx.onVideo?.(URL.createObjectURL(r.blob), w.path);
        return `已生成视频（${r.model}）并显示在对话里，保存在工作区 ${w.path}。`;
      }
    },
    {
      name: 'schedule_task',
      description: '创建定时任务：到点自动让你执行一段指令，结果保存为一段对话并通知用户。用户说“每天 / 每周 / 工作日 / 明天几点 / 每隔多久 帮我……”或“提醒我……”时使用。',
      input_schema: S({
        title: str('任务名称（简短）'),
        prompt: str('到点时要执行的完整指令，写清楚要做什么、输出什么，例如“总结今天的工作区文件改动，列出待办”'),
        when: str('时间，如：每天 9:00、工作日 18:30、每周五 17:30、每 30 分钟、明天 8 点、2026-10-20 15:00、10 分钟后'),
        unattended: { type: 'boolean', description: '是否允许无人值守时执行需要确认的操作（写文件、运行命令等），默认 false' }
      }, ['title', 'prompt', 'when']),
      run: async ({ title, prompt, when, unattended }) => {
        const s = await scheduler.upsert({ title, prompt, unattended, ...scheduler.parseWhen(when) });
        ctx.onSchedulesChanged?.();
        return `已创建定时任务「${s.title}」：${scheduler.describe(s)}，下一次在 ${new Date(s.nextRun).toLocaleString('zh-CN', { hour12: false })}。到时会自动执行并通知（应用需要在运行中：桌面版在托盘里也可以）。`;
      }
    },
    {
      name: 'list_schedules',
      description: '列出已有的定时任务。',
      input_schema: S({}),
      run: async () => {
        const list = await scheduler.list();
        return list.length ? list.map((s) => `- [${s.id}] ${s.title}：${scheduler.describe(s)}${s.enabled ? '' : '（已停用）'}，下一次 ${s.nextRun ? new Date(s.nextRun).toLocaleString('zh-CN', { hour12: false }) : '—'}；指令：${s.prompt.slice(0, 60)}`).join('\n') : '还没有定时任务。';
      }
    },
    {
      name: 'cancel_schedule',
      description: '删除一个定时任务（先用 list_schedules 找到 id）。',
      input_schema: S({ id: str('任务 id') }, ['id']),
      run: async ({ id }) => { await scheduler.remove(id); ctx.onSchedulesChanged?.(); return '已删除。'; }
    },
    {
      name: 'kb_search',
      description: '在用户的本地知识库（导入的文档）中检索。回答涉及用户资料、公司文档、导入的文件时先检索，并在回答中注明来源文件名。',
      input_schema: S({ query: str('检索问题') }, ['query']),
      run: async ({ query }) => {
        const hits = await kb.search(query, 5, 0.15);
        return hits.length ? hits.map((h) => `【来源：${h.name}】\n${h.text}`).join('\n\n') : '知识库里没有找到相关内容。';
      }
    },
    {
      name: 'search_conversations',
      description: '搜索用户和你之前的所有对话（跨对话）。用户提到“上次 / 之前说过 / 那天聊的”、或需要以前对话里的细节（方案、数据、结论、文件名）时使用。返回对话 id、标题、日期和命中的原话。',
      input_schema: S({ query: str('要找的内容，关键词或一句话') }, ['query']),
      run: async ({ query }) => {
        const hits = await sessions.searchMessages(query, { exclude: ctx.currentSessionId?.(), k: 6, minScore: 0.5 });
        if (!hits.length) return '之前的对话里没有找到相关内容。';
        return hits.map((h) => `- id: ${h.sessionId}「${h.title}」${new Date(h.ts).toLocaleString('zh-CN', { hour12: false })}\n  用户：${h.user.slice(0, 200)}${h.reply ? `\n  贾维斯：${h.reply.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`).join('\n');
      }
    },
    {
      name: 'read_conversation',
      description: '读取之前某段对话的全文（id 来自 search_conversations 或上下文里的“最近的其他对话”）。内容很长时可以给 query，只读相关的部分。',
      input_schema: S({ id: str('对话 id'), query: str('可选：只看和这个相关的部分') }, ['id']),
      run: async ({ id, query }) => {
        const s = await sessions.get(id);
        if (!s) throw new Error(`找不到对话 ${id}，先用 search_conversations 查 id`);
        let msgs = s.messages;
        if (query && msgs.length > 20) {
          const q = String(query).toLowerCase();
          const idx = msgs.findIndex((m) => String(m.content).toLowerCase().includes(q));
          if (idx >= 0) msgs = msgs.slice(Math.max(0, idx - 4), idx + 8);
        }
        const text = msgs.map((m) => `【${m.role === 'user' ? '用户' : '贾维斯'} · ${new Date(m.ts ?? s.updatedAt).toLocaleString('zh-CN', { hour12: false })}】\n${m.content}`).join('\n\n');
        return `对话「${s.title}」（${s.messages.length} 条）\n\n${text.length > 12000 ? `…（前面省略）\n${text.slice(-12000)}` : text}`;
      }
    },
    {
      name: 'list_files',
      description: '列出工作区里的文件（虚拟工作区，或用户连接的本地文件夹）。',
      input_schema: S({ path: str('可选，子目录') }),
      run: async ({ path }) => {
        const files = await ws.list(path || '');
        return files.length ? files.map((f) => `${f.path}  (${fmtSize(f.size)})`).join('\n') : '工作区是空的。';
      }
    },
    {
      name: 'read_file',
      description: '读取工作区里的文件。Word、PDF、PPT、Excel 会自动转换成文字；代码和文本原样返回；图片（png / jpg / webp）会直接给你看。',
      input_schema: S({ path: str('文件路径') }, ['path']),
      run: async ({ path }) => {
        const blob = await ws.readBlob(path);
        if (isImageName(path) && typeof document !== 'undefined') {
          const img = await prepareImage(blob);
          return { text: `图片 ${path}（${img.width}×${img.height}）`, images: [{ mime: img.mime, data: img.data }] };
        }
        if (ws.isText(path)) return clip(await blob.text());
        return clip((await parseFile(blob, path)).text);
      }
    },
    {
      name: 'write_file',
      description: '在工作区写入文本文件（代码、网页、Markdown、CSV、JSON 等）。编写程序时把每个文件分别写入。',
      input_schema: S({ path: str('文件路径，如 app/index.html'), content: str('完整文件内容') }, ['path', 'content']),
      run: async ({ path, content }) => {
        const r = await ws.write(path, content);
        ctx.onFileChanged?.(r.path);
        return `已写入 ${r.path}（${fmtSize(new Blob([content]).size)}）${r.renamed ? '，本地已有同名文件，未覆盖，另存为此名' : ''}`;
      }
    },
    {
      name: 'create_document',
      description: '生成 Office / 文档文件并保存到工作区。content 用 Markdown：docx/pdf/html/md 支持 # 标题、列表、| 表格 |、**粗体**；pptx 用“# 标题”分页、列表作为要点；xlsx 用 CSV 或 Markdown 表格，“## 名称”分出多个工作表。',
      input_schema: S({
        format: { type: 'string', enum: ['docx', 'pptx', 'xlsx', 'pdf', 'html', 'md', 'txt'] },
        path: str('保存路径（扩展名会自动修正）'),
        title: str('文档标题'),
        content: str('Markdown 内容')
      }, ['format', 'path', 'content']),
      run: async ({ format, path, title, content }) => {
        const out = await generate(format, { title: title || path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), content });
        const target = path.replace(/\.[a-z0-9]+$/i, '') + `.${out.ext}`;
        const r = await ws.write(target, out.blob);
        ctx.onFileChanged?.(r.path);
        return `${r.path}（${fmtSize(out.blob.size)}）${out.note ? `。${out.note}` : ''}`;
      }
    },
    {
      name: 'run_javascript',
      description: '在隔离的沙箱里运行 JavaScript（无 DOM，可用 fetch），用于计算、数据处理、验证代码。用 console.log 输出，return 返回值。超时 8 秒。',
      input_schema: S({ code: str('JavaScript 代码（作为 async 函数体执行）') }, ['code']),
      run: async ({ code }) => formatRun(await runJavaScript(code))
    },
    {
      name: 'run_python',
      description: '运行 Python（浏览器内的 Pyodide，首次使用需联网加载）。工作目录 /workspace 就是工作区，读写的文件会同步回工作区。可用 numpy、pandas 等常见库（自动加载）；python-pptx / python-docx / openpyxl 等纯 Python 库在代码开头用 `import micropip; await micropip.install("python-pptx")` 安装。',
      input_schema: S({ code: str('Python 代码') }, ['code']),
      run: async ({ code }) => {
        const listing = pickPythonFiles(await ws.list(), code);
        const files = await Promise.all(listing.map(async (f) => ({ path: f.path, bytes: await (await ws.readBlob(f.path)).arrayBuffer() })));
        const r = await runPython(code, { files });
        const saved = [];
        for (const c of r.changed ?? []) {
          const w = await ws.write(c.path, new Blob([c.bytes]));
          saved.push(w.path);
          ctx.onFileChanged?.(w.path);
        }
        return formatRun(r) + (saved.length ? `\n已同步到工作区：${saved.join('、')}` : '');
      }
    },
    {
      name: 'preview',
      description: '在界面右侧打开工作区里的网页（.html，同目录引用的 css / js 会自动内联）或文档进行预览。写完网页后调用，让用户直接看到效果。',
      input_schema: S({ path: str('文件路径') }, ['path']),
      run: async ({ path }) => {
        if (!(await ws.exists(path))) throw new Error(`找不到文件：${path}`);
        ctx.onPreview?.(ws.normalize(path));
        return `已在预览区打开 ${path}`;
      }
    },
    {
      name: 'fetch_url',
      description: '获取网页内容（转换为文字），用于读取用户给出的链接或最新资料。',
      input_schema: S({ url: str('http(s) 地址') }, ['url']),
      run: async ({ url }) => {
        if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http(s) 地址');
        const res = ctx.fetchViaGateway ? await ctx.fetchViaGateway(url) : await fetch(url).catch(() => { throw new Error('浏览器无法直接读取该网站（跨域限制）。请使用完整版网关，或让我用联网搜索。'); });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get('content-type') || '';
        const body = await res.text();
        return clip(type.includes('html') ? htmlToText(body) : body, 15000);
      }
    },
    {
      name: 'get_current_time',
      description: '读取当前日期和时间（含时区）。',
      input_schema: S({}),
      run: async () => JSON.stringify({ local: new Date().toLocaleString('zh-CN', { hour12: false }), iso: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    },
    {
      name: 'get_local_metrics',
      description: '读取本机 / 浏览器的运行状态（CPU、内存、网络）。',
      input_schema: S({}),
      run: async () => JSON.stringify(await ctx.metrics())
    }
  ];

  const engine = createSearch(ctx);
  const readPage = async (url) => {
    const res = ctx.fetchViaGateway ? await ctx.fetchViaGateway(url) : await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/html|text|json|xml/.test(type)) throw new Error('不是网页');
    const body = await res.text();
    return type.includes('html') ? htmlToText(body) : body;
  };
  if (engine) {
    tools.push({
      name: 'web_search',
      description: `联网搜索最新信息（新闻、价格、版本、事件等时效性内容；搜索源：${engine.name}）。回答时注明来源链接。需要全面、有出处的研究时改用 deep_research。`,
      input_schema: S({ query: str('搜索词') }, ['query']),
      run: async ({ query }) => {
        const hits = await engine.search(query, 6);
        if (!hits.length) return '没有搜索结果，换个搜索词试试';
        return hits.map((r) => `- ${r.title}\n  ${r.url}\n  ${String(r.snippet || '').slice(0, 300)}`).join('\n');
      }
    });
    tools.push({
      name: 'deep_research',
      description: '深度调研：自动多轮搜索、逐篇阅读网页、找缺口补查，最后写成带引用编号的 Markdown 报告保存到工作区并打开预览。适合“帮我调研 / 研究 / 对比 / 写一份关于…的报告”这类需要全面资料的问题；耗时 1-5 分钟。简单的事实查询用 web_search。',
      input_schema: S({
        question: str('调研问题，写完整（含范围、时间、关注点）'),
        depth: { type: 'string', enum: Object.keys(DEPTHS), description: 'quick 快速（约 4 个来源）/ standard 标准（约 8 个）/ deep 深入（约 14 个，多轮补查）' }
      }, ['question']),
      run: async ({ question, depth = 'standard' }, { progress, signal } = {}) => {
        const r = await deepResearch({
          question, depth, llm: ctx.llm ?? null, signal,
          search: (q, n) => engine.search(q, n),
          read: readPage,
          onProgress: ({ text }) => progress?.(text)
        });
        const safe = r.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '调研报告';
        const w = await ws.write(`调研/${safe}.md`, r.markdown);
        ctx.onFileChanged?.(w.path);
        ctx.onPreview?.(w.path);
        return `报告已保存到 ${w.path} 并已打开预览（检索 ${r.queries.length} 次，引用 ${r.sources.length} 个来源）。请用几句话向用户概括结论，不要整篇复述；用户需要时可以用 create_document 转成 Word / PDF。\n\n${clip(r.markdown, 6000)}`;
      }
    });
  }
  return tools;
}

/** 校验参数：必填项存在、类型正确、枚举值合法 */
export function validateArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '参数必须是对象';
  const { properties = {}, required = [] } = tool.input_schema;
  for (const k of required) if (args[k] === undefined || args[k] === null || args[k] === '') return `缺少必填参数 ${k}`;
  for (const [k, v] of Object.entries(args)) {
    const p = properties[k];
    if (!p) continue;
    if (p.type === 'string' && typeof v !== 'string') return `参数 ${k} 应为字符串`;
    if (p.type === 'number' && !Number.isFinite(Number(v))) return `参数 ${k} 应为数字`;
    if (p.enum && !p.enum.includes(v)) return `参数 ${k} 只能是 ${p.enum.join(' / ')}`;
  }
  return null;
}

function formatRun(r) {
  const parts = [];
  if (r.logs?.length) parts.push(`输出：\n${r.logs.join('\n')}`);
  if (r.ok && r.value !== undefined) parts.push(`返回值：${r.value}`);
  if (!r.ok) parts.push(`错误：${r.error}`);
  if (!parts.length) parts.push(r.ok ? '运行成功（没有输出）' : '运行失败');
  return clip(parts.join('\n'), 12000);
}

export function fmtSize(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
