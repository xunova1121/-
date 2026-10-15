/**
 * 智能体工具。每个工具：name / description / input_schema（JSON Schema）/ run(args) → 字符串结果。
 * 参数在执行前统一校验（流式工具参数可能被截断，模型偶尔也会漏参数），不合格就返回明确的错误让模型自行修正。
 */
import * as ws from './workspace.js';
import * as memory from './memory.js';
import * as kb from './knowledge.js';
import { parseFile, generate } from './docs.js';
import { THEME_IDS, themeList } from './themes.js';
import { writeLongDocument, outlineMarkdown } from './longDoc.js';
import { withBom } from './xlsxWriter.js';
import { applyEdits } from './textEdit.js';
import { editOffice } from './officeEdit.js';
import { TEMPLATE_PATH } from './docxWriter.js';
import { selfCheck, lint } from './selfCheck.js';
import { runJavaScript, runPython } from './sandbox.js';
import * as packs from './skillPacks.js';
import { isImageName, prepareImage } from './images.js';
import * as scheduler from './scheduler.js';
import * as sessions from './sessions.js';
import { createSearch } from './webSearch.js';
import { getWeather } from './weather.js';
import { createPageReader } from './pageReader.js';
import { deepResearch, DEPTHS } from './research.js';
import { factCheck, formatReport } from './factCheck.js';

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
 * @param {(html: string) => Promise<Uint8Array>} [ctx.toPdf]  桌面版：排好版的 HTML 直接转 PDF
 */
export function createTools(ctx) {
  const readPage = createPageReader(ctx); // 直接打不开或没读到正文时，有 Tavily Key 就让 Tavily 代读
  /** Word 模板：指定了就用指定的；没指定就找工作区里最近改过的模板文件；"none" 不用 */
  const findTemplate = async (format, template) => {
    if (format !== 'docx' || template === 'none') return { tpl: null };
    let tplPath = template || '';
    const auto = !tplPath;
    if (auto) tplPath = (await ws.list().catch(() => [])).filter((f) => TEMPLATE_PATH.test(f.path)).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0]?.path ?? '';
    if (!tplPath) return { tpl: null };
    try { return { tpl: new Uint8Array(await (await ws.readBlob(tplPath)).arrayBuffer()), tplPath, auto }; } catch { throw new Error(`找不到模板文件：${tplPath}`); }
  };
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
      name: 'install_skill',
      description: '安装技能：path 填工作区里的技能文件夹（里面有 SKILL.md，如 "skills-draft/sales-report"），或 GitHub 上的技能文件夹地址（https://github.com/…/tree/main/skills/xxx）。同名技能会覆盖升级。用户同意后才调用；界面会再请用户确认一次。',
      input_schema: S({ path: str('工作区文件夹路径，或 GitHub 地址') }, ['path']),
      approval: ({ path }) => ({ key: 'skill-install', title: `安装技能：${path}`, detail: '技能里的说明会在以后的对话中被读取并照做，请确认来源可信。' }),
      run: async ({ path }, { progress } = {}) => {
        const src = String(path).trim();
        let pack;
        if (/^https?:\/\//i.test(src)) pack = await packs.installFromGitHub(src, { onProgress: progress });
        else {
          const dir = src.replace(/^\/?workspace\//, '').replace(/^\.?\//, '').replace(/\/?SKILL\.md$/i, '').replace(/\/$/, '');
          if (!dir) throw new Error('请填技能所在的文件夹（如 skills-draft/sales-report），不能是整个工作区');
          const listing = await ws.list(dir);
          if (!listing.some((f) => /(^|\/)SKILL\.md$/i.test(f.path))) throw new Error(`工作区 ${dir || '根目录'} 里没有 SKILL.md`);
          const files = {};
          for (const f of listing) {
            const blob = await ws.readBlob(f.path);
            files[f.path] = packs.isText(f.path) ? await blob.text() : packs.binaryFile(await blob.arrayBuffer());
          }
          pack = await packs.installFromFiles(files, { source: '工作区' });
        }
        const n = Object.keys(pack.files || {}).length;
        return `已安装技能「${pack.name}」${n ? `（带 ${n} 个附件）` : ''}${pack.also?.length ? `，另外还装了：${pack.also.map((p) => p.name).join('、')}` : ''}。用户以后输入“/${pack.name} 具体要求”就能点名使用；现在可以用 use_skill 读取它试一次。`;
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
        return hits.map((h) => `- id: ${h.sessionId}「${h.title}」${new Date(h.ts).toLocaleString('zh-CN', { hour12: false })}\n  用户：${h.user.slice(0, 200)}${h.reply ? `\n  未央：${h.reply.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`).join('\n');
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
        const text = msgs.map((m) => `【${m.role === 'user' ? '用户' : '未央'} · ${new Date(m.ts ?? s.updatedAt).toLocaleString('zh-CN', { hour12: false })}】\n${m.content}`).join('\n\n');
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
        // CSV 加 UTF-8 BOM：Excel 双击打开时中文不乱码
        const r = await ws.write(path, /\.csv$/i.test(path) ? withBom(content) : content);
        ctx.onFileChanged?.(r.path);
        const kept = { saved: '，覆盖了同名文件，原来的内容已自动备份，可在“工作区 → 改动记录”里恢复', 'too-big': '，覆盖了同名文件，原文件太大没有自动备份' }[r.backup] ?? '';
        return `已写入 ${r.path}（${fmtSize(new Blob([content]).size)}）${r.renamed ? '，本地已有同名文件，未覆盖，另存为此名' : ''}${kept}`;
      }
    },
    {
      name: 'edit_file',
      description: '按片段修改工作区里的文本文件（代码、网页、Markdown、CSV 等）：给出原文里一字不差的一段 old_text 和替换后的 new_text，只改这一段，其余不动。改大文件的一小部分时用它，比 write_file 整个重写省事、也不容易改坏。可以一次给多处修改。原文出现多次时多带几行上下文，或设 replace_all。Word / PPT 用 edit_office_document。',
      input_schema: S({
        path: str('文件路径'),
        edits: {
          type: 'array', description: '一处或多处修改，按顺序执行',
          items: { type: 'object', properties: { old_text: str('原文片段（一字不差）'), new_text: str('替换成'), replace_all: { type: 'boolean', description: '替换所有出现的地方' } }, required: ['old_text', 'new_text'], additionalProperties: false }
        }
      }, ['path', 'edits']),
      run: async ({ path, edits }) => {
        if (!ws.isText(path)) throw new Error(`${path} 不是文本文件。Word / PPT 请用 edit_office_document`);
        const before = await ws.readText(path);
        const r = applyEdits(before, Array.isArray(edits) ? edits : []);
        const w = await ws.write(path, r.text);
        ctx.onFileChanged?.(w.path);
        return `已修改 ${w.path}：替换 ${r.count} 处${w.renamed ? '（本地文件夹里不覆盖同名文件，另存为此名）' : ''}${w.backup === 'saved' ? '；原来的内容已自动备份，可在“工作区 → 改动记录”里恢复' : ''}`;
      }
    },
    {
      name: 'edit_office_document',
      description: '修改工作区里已有的 Word（.docx）或 PPT（.pptx），保留原来的排版和格式：替换文字（正文、表格、页眉页脚、每页幻灯片和备注都会找），Word 还可以在末尾追加段落（格式照抄最后一段）。适合“把文档里的 2025 改成 2026”“在合同里把甲方名称换掉”“在报告最后加一段说明”。要大改结构时用 create_document 重新生成。',
      input_schema: S({
        path: str('文件路径（.docx / .pptx）'),
        replacements: { type: 'array', description: '要替换的文字', items: { type: 'object', properties: { find: str('原文（一字不差）'), replace: str('替换成') }, required: ['find', 'replace'], additionalProperties: false } },
        append: { type: 'array', items: { type: 'string' }, description: '追加到 Word 末尾的段落（每项一段，可选）' },
        save_as: str('另存为（可选，不填就改原文件；原文件会自动备份）')
      }, ['path']),
      run: async ({ path, replacements = [], append = [], save_as: saveAs }) => {
        const kind = ws.ext(path);
        if (!['docx', 'pptx'].includes(kind)) throw new Error('只能修改 .docx 或 .pptx 文件；文本文件用 edit_file');
        const r = await editOffice(await ws.readBlob(path), kind, { replacements: Array.isArray(replacements) ? replacements : [], append: Array.isArray(append) ? append : [] });
        const hit = r.replaced.filter((x) => x.count);
        const miss = r.replaced.filter((x) => !x.count);
        if (!hit.length && !r.appended) throw new Error(`文件里没有找到要替换的文字：${miss.map((x) => `“${x.find}”`).join('、') || '（没有给出修改）'}。先用 read_file 看准原文`);
        const target = saveAs ? saveAs.replace(/\.[a-z0-9]+$/i, '') + `.${kind}` : path;
        const w = await ws.write(target, r.blob);
        ctx.onFileChanged?.(w.path);
        const parts = hit.map((x) => `“${x.find}”替换了 ${x.count} 处`);
        if (r.appended) parts.push(`追加了 ${r.appended} 段`);
        if (miss.length) parts.push(`没找到：${miss.map((x) => `“${x.find}”`).join('、')}`);
        return `已保存 ${w.path}（格式保留）：${parts.join('；')}${w.backup === 'saved' ? '。原文件已自动备份，可在“工作区 → 改动记录”里恢复' : ''}`;
      }
    },
    {
      name: 'create_document',
      description: `生成 Office / 文档文件并保存到工作区，排版自动完成（A4、标题样式、编号列表、带表头底色的表格、页码；Word / PDF 的二级标题有 3 个以上时自动加目录）。
content 用 Markdown：
- docx / pdf / html：开头一个“# 文档标题”，正文用 ## 一级标题、### 二级标题、#### 三级标题；支持多级列表（缩进两个空格）、| 表格 |（:--: 居中、--: 右对齐）、**粗体**、*斜体*、~~删除线~~、[链接](https://…)、> 引用、代码块、--- 分隔线、单独一行 [分页]、![图注](工作区里的图片路径)
- pptx：每页用“## 页标题”，页标题写成一句观点（如“建设必要性：补齐告警到处置的人工断点”），版式按内容自动选：
  · 3–6 条“标签：说明”的要点 → 卡片网格（如“预警研判：多源证据汇聚……”）；页标题含流程 / 场景 / 步骤 / 闭环时 → 一排步骤箭头；可以再加一句不带标签的总结，放在页脚
  · 一句“A→B→C→D”的链路 → 流程箭头图
  · 2–4 条以数字开头的要点（“67 万元：总投资”）→ 大数字卡片
  · 带数字列的表格 → 柱状图（合计行和单位不同的列会写在旁边说明里）；其他表格 → 表格
  · 两个 ### 小标题 → 左右对比；只有一两句话 → 大字重点页；标题是“第一部分……” → 章节页；“谢谢” → 结尾页
  每页 3–6 条，每条一句完整的话，不要整页长段落；封面信息（单位、日期）用 author 和副标题，不要写成第二页的要点
- xlsx：CSV 或 Markdown 表格，“## 名称”分出多个工作表；“合计”行和“增长率 / 同比 / 完成率 / 占比”列会自动写成 Excel 公式（占比列留空即可），也可以直接写“=SUM(B2:B5)”；1,200、18%、¥300、2026-10-14 会自动设成对应的数字格式。
  一个工作表里可以排成报表：“## 名称”下面第一行普通文字是副标题；“### 小节”是小节标题；可以放多张表（空行隔开）；表格之间的普通文字是说明 / 备注（整行显示）；不写“|---|”分隔行的表格是信息表（“| 项目名称 | xxx | 编号 | xxx |”，左边是名目）。只放一张表、没有文字时就是普通数据表（表头在第一行、带筛选）。
  把文档 / 材料整理成 Excel 时：第一个工作表做“总览”（基本信息用信息表，关键数字、投资结构、核心结论）；后面按主题分表，材料里的清单、明细逐项全部收进来，不要只摘一部分；每个小节、每个模块有小计；材料前后不一致或要核对的地方，写在说明里。新建表格用这个格式，不要自己写 openpyxl 代码排版
- csv：单个表格，自动加 BOM（Excel 打开中文不乱码）
theme 可选：${themeList()}。不填按内容自动选；公文（通知、请示、报告、函等）用 gongwen。`,
      input_schema: S({
        format: { type: 'string', enum: ['docx', 'pptx', 'xlsx', 'pdf', 'html', 'md', 'txt', 'csv'] },
        path: str('保存路径（扩展名会自动修正）'),
        title: str('文档标题'),
        content: str('Markdown 内容'),
        theme: { type: 'string', enum: THEME_IDS, description: '配色主题，不填自动选' },
        cover: { type: 'boolean', description: 'Word / PDF 加封面（正式报告、方案、标书类建议加）' },
        subtitle: str('副标题（可选）'),
        author: str('署名，如单位或部门（可选，用在封面）'),
        toc: { type: 'string', enum: ['auto', 'yes', 'no'], description: '目录：auto（默认，二级标题 3 个以上时加）/ yes / no' },
        template: str('Word 模板路径（工作区里的 .docx，可选）：沿用模板的字体、标题和正文样式。不填时，工作区“模板 / templates”文件夹里或文件名带“模板”的 .docx 会自动使用；传 "none" 不用模板'),
        requirements: str('用户对这份文档的原始要求（尽量用原话：主题、必须包含的内容、字数页数、格式）。填了会在生成前对照检查有没有漏项，并自动改一轮')
      }, ['format', 'path', 'content']),
      run: async ({ format, path, title, content, theme, cover, subtitle, author, toc, template, requirements }, { progress, signal } = {}) => {
        const loadImage = async (src) => {
          if (/^(https?:|data:)/i.test(src)) return null;
          try { return new Uint8Array(await (await ws.readBlob(src)).arrayBuffer()); } catch { return null; }
        };
        const { tpl, tplPath, auto } = await findTemplate(format, template);
        // 生成前自查：规则检查；有原始要求或硬伤时请模型对照检查并改一轮
        const check = await selfCheck({ format, content, requirements, llm: ctx.reasonLlm ?? ctx.llm ?? null, signal, onProgress: (t) => progress?.(t) });
        const out = await generate(format, {
          title: title || path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), content: check.content, theme, cover: Boolean(cover), subtitle, author,
          toc: toc === 'yes' ? true : toc === 'no' ? false : 'auto', loadImage, toPdf: ctx.toPdf ?? null, template: tpl
        });
        const target = path.replace(/\.[a-z0-9]+$/i, '') + `.${out.ext}`;
        const r = await ws.write(target, out.blob);
        ctx.onFileChanged?.(r.path);
        const notes = [`主题：${out.theme.name}`];
        if (check.checked) notes.push(check.changed ? `生成前对照要求自查，修正了 ${check.changed} 处${check.problems.length ? `（${check.problems.slice(0, 4).join('；')}）` : ''}` : '生成前对照要求自查，没发现问题');
        if (check.issues.length) notes.push(`还需要注意：${check.issues.map((x) => x.text).join('；')}`);
        if (out.info?.toc) notes.push('已加目录（Word 打开时如提示更新域，点“是”即可填上页码；WPS 里右键目录 →“更新目录”）');
        if (out.info?.missingImages?.length) notes.push(`这些图片没找到，用占位文字代替了：${out.info.missingImages.join('、')}`);
        if (tpl) notes.push(`${auto ? '自动' : ''}沿用了模板 ${tplPath} 的样式${auto ? '（不想用模板就传 template: "none"）' : ''}`);
        if (out.note) notes.push(out.note);
        return `${r.path}（${fmtSize(out.blob.size)}）。${notes.join('；')}`;
      }
    },
    {
      name: 'write_long_document',
      description: `写长文档（约 3000 字以上的报告、方案、总结、标书、调研分析等）：先列大纲，再逐节写（每节都带着大纲和前文摘要，前后连贯），通读统一术语和衔接，然后请一位不了解背景的“读者”试读，按读者意见把有问题的节改一轮，最后生成文件。耗时 1–5 分钟。
用户说“先看大纲 / 先给我大纲”时 outline_only=true，只返回大纲给用户确认；用户确认或修改后，把定下来的大纲放进 outline 再调用一次。短文档（通知、函、几百字的说明）直接用 create_document。`,
      input_schema: S({
        task: str('写作要求，写完整：写什么、给谁看、用途、重点、风格、特殊要求'),
        format: { type: 'string', enum: ['docx', 'pdf', 'html', 'md'], description: '输出格式，默认 docx' },
        path: str('保存路径（扩展名会自动修正）'),
        title: str('文档标题（可选，不填由模型拟定）'),
        material: str('用户在对话里直接给的材料、数据、要点（原样放进来，不要概括）'),
        material_files: { type: 'array', items: { type: 'string' }, description: '用户给的参考文件（工作区路径，Word/PDF/PPT/Excel/文本都行）。有文件时一定放这里，程序会读取全文，不要自己读了再概括进 material' },
        words: { type: 'number', description: '目标字数（可选）' },
        outline_only: { type: 'boolean', description: '只出大纲，等用户确认' },
        outline: { type: 'array', description: '已确认的大纲（跳过列大纲）', items: { type: 'object', properties: { heading: str('一级标题'), points: { type: 'array', items: { type: 'string' } }, words: { type: 'number' } }, required: ['heading'], additionalProperties: false } },
        review: { type: 'boolean', description: '读者试读并修改（默认 true）' },
        theme: { type: 'string', enum: THEME_IDS, description: '配色主题，不填自动选' },
        cover: { type: 'boolean', description: '加封面' },
        subtitle: str('副标题（可选）'),
        author: str('署名（可选）')
      }, ['task', 'path']),
      run: async ({ task, format = 'docx', path, title, material, material_files: materialFiles, words, outline_only: outlineOnly, outline, review = true, theme, cover, subtitle, author }, { progress, signal } = {}) => {
        // 参考文件由程序读全文，不经模型转述（模型转述时会压缩，长材料还会被截断）
        const files = [];
        for (const f of Array.isArray(materialFiles) ? materialFiles.slice(0, 8) : []) {
          try {
            const blob = await ws.readBlob(f);
            files.push(`【参考文件：${f}】\n${ws.isText(f) ? await blob.text() : (await parseFile(blob, f)).text}`);
          } catch (e) { throw new Error(`读不到参考文件 ${f}：${e.message}`); }
        }
        if (files.length) material = [material, ...files].filter(Boolean).join('\n\n');
        const r = await writeLongDocument({
          task, title, material, words: Number(words) || 0, outline: Array.isArray(outline) ? outline : null, outlineOnly: Boolean(outlineOnly),
          review: review !== false, llm: ctx.llm ?? null, readerLlm: ctx.reasonLlm ?? null, onProgress: (t) => progress?.(t), signal
        });
        if (outlineOnly) {
          return `大纲如下（还没有写正文）。把大纲给用户看，问是否需要调整；用户确认后，把最终大纲放进 outline 参数，再调用一次 write_long_document（其他参数照旧）。\n\n${outlineMarkdown(r.title, r.outline)}`;
        }
        const { tpl, tplPath } = await findTemplate(format);
        const out = await generate(format, {
          title: r.title, content: r.markdown, theme, cover: Boolean(cover), subtitle, author,
          loadImage: async (src) => { try { return new Uint8Array(await (await ws.readBlob(src)).arrayBuffer()); } catch { return null; } },
          toPdf: ctx.toPdf ?? null, template: tpl
        });
        const target = path.replace(/\.[a-z0-9]+$/i, '') + `.${out.ext}`;
        const w = await ws.write(target, out.blob);
        ctx.onFileChanged?.(w.path);
        const chars = r.markdown.replace(/[\s#|*\-`>]/g, '').length;
        const lines = [`已生成 ${w.path}（${fmtSize(out.blob.size)}，${r.outline.length} 节，约 ${chars} 字，主题：${out.theme.name}）`];
        if (tpl) lines.push(`沿用了工作区里的模板 ${tplPath}`);
        const left = lint(format, r.markdown);
        if (left.length) lines.push(`自查还需要注意：${left.map((x) => x.text).join('；')}`);
        if (r.edits) lines.push(`通读后统一修改了 ${r.edits} 处术语 / 衔接`);
        if (r.review?.issues?.length) {
          lines.push(`读者试读发现 ${r.review.issues.length} 个问题，已修改的节：${r.review.revised.join('、') || '无（改动没通过检查，保留原文）'}`);
          lines.push(...r.review.issues.map((x) => `- 【${x.type}】${x.section ? `${x.section}：` : ''}${x.problem}`));
        } else if (r.review) lines.push(r.review.failed ? '读者试读没有完成（模型出错），未修改' : '读者试读没有发现明显问题');
        if (out.note) lines.push(out.note);
        lines.push('请用几句话告诉用户文件位置、结构和需要用户确认的地方（如“待确认”的数据），不要复述全文。');
        return lines.join('\n');
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
        return clip(await readPage(url), 15000);
      }
    },
    {
      name: 'get_current_time',
      description: '读取当前日期和时间（含时区）。',
      input_schema: S({}),
      run: async () => JSON.stringify({ local: new Date().toLocaleString('zh-CN', { hour12: false }), iso: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    },
    {
      name: 'get_weather',
      description: '查天气：某个城市的实况和未来几天预报（温度、天气、降水概率、风）。问天气一律用这个，不要用 web_search 搜天气。',
      input_schema: S({ place: str('城市或地区名，如“南京”“上海浦东”“Tokyo”'), days: { type: 'number', description: '要几天预报，默认 3，最多 7' } }, ['place']),
      run: async ({ place, days }) => getWeather(place, { get: ctx.fetchViaGateway || ((u) => fetch(u)), days: Math.min(7, Math.max(1, Number(days) || 3)) })
    },
    {
      name: 'get_local_metrics',
      description: '读取本机 / 浏览器的运行状态（CPU、内存、网络）。',
      input_schema: S({}),
      run: async () => JSON.stringify(await ctx.metrics())
    }
  ];

  const engine = createSearch(ctx);
  if (engine) {
    tools.push({
      name: 'web_search',
      description: `联网搜索最新信息（比分赛果、新闻、价格、版本、事件等时效性内容；搜索源：${engine.name}）。外国的队名、人名、公司用原文或英文搜；多个对象（如几场比赛）放进 queries 一次并行搜。结果不够时用 fetch_url 读原文。回答时注明来源链接。需要全面、有出处的研究时改用 deep_research。`,
      input_schema: S({
        query: str('搜索词'),
        queries: { type: 'array', items: { type: 'string' }, description: '可选：多个搜索词，一次并行搜索（最多 8 个），例如每场比赛一个' },
        freshness: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '可选：只要最近一天 / 一周 / 一个月 / 一年内的结果（新闻、刚结束的比赛、最新价格时用）' }
      }, []),
      run: async ({ query, queries, freshness }) => {
        const list = [...new Set([query, ...(Array.isArray(queries) ? queries : [])].map((q) => String(q || '').trim()).filter(Boolean))].slice(0, 8);
        if (!list.length) throw new Error('请给出搜索词');
        const one = async (q) => {
          try {
            const hits = await engine.search(q, list.length > 1 ? 5 : 6, { freshness });
            return hits.length ? hits.map((r) => `- ${r.title}\n  ${r.url}\n  ${String(r.snippet || '').slice(0, 300)}`).join('\n') : '（没有结果：换个说法、换成英文或原文再搜）';
          } catch (e) { return `（搜索失败：${e.message}）`; }
        };
        const outs = await Promise.all(list.map(one));
        return list.length === 1 ? outs[0] : list.map((q, i) => `### ${q}\n${outs[i]}`).join('\n\n');
      }
    });
    tools.push({
      name: 'fact_check',
      description: '逐项联网查证：要查的对象有好几个（截图里的多场比赛、多只股票、多个产品的价格、清单里的多个事件），或者答案必须准确时使用。程序会对每一项：还原原文名、多语言搜索、读原文、让模型摘答案并给原文引用、核对引用确实在原文里、两个网站一致才算已核实，不够就换搜索词再查。比自己用 web_search 拼凑准确得多。调用前先把图片 / 文字里的每一项原样列进 items（编号、名称、时间、相关选项都写进 label / details），不要漏项、不要改名。',
      input_schema: S({
        question: str('每一项要查什么，写具体，如“这场比赛的全场比分（和半场比分）”“今天收盘价和涨跌幅”'),
        items: { type: 'array', description: '要查证的对象，逐项列出（最多 20 项）', items: { type: 'object', properties: { label: str('对象名称，原样照抄，如“迪拜连接 VS 吉达国民”'), details: str('补充信息：编号、联赛、开赛时间、日期等，如“周一001，开赛 10-12 23:00”') }, required: ['label'], additionalProperties: false } },
        date: str('事件发生的日期或时间范围，如 2026-10-12（不知道就留空）'),
        context: str('背景，如“中国体育彩票竞彩足球，第 2610121 期”')
      }, ['question', 'items']),
      run: async ({ question, items, date, context }, { progress, signal } = {}) => {
        const r = await factCheck({
          question, items, date, context, signal,
          llm: ctx.reasonLlm ?? ctx.llm ?? null,
          search: (q, n, o) => engine.search(q, n, o),
          read: readPage,
          onProgress: (t) => progress?.(t)
        });
        return formatReport(r);
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
/** 模型常把参数名写成别的样子：认得出来的改回正确的名字（改的是传进来的对象） */
const ALIASES = {
  path: ['file_path', 'filepath', 'file', 'filename', 'file_name', 'fileName', 'filePath', 'paths'],
  content: ['text', 'body', 'data'],
  query: ['q', 'keyword', 'keywords', 'search', 'question'],
  url: ['link', 'href', 'uri']
};
export function normalizeArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const { properties = {} } = tool.input_schema ?? {};
  for (const [k, names] of Object.entries(ALIASES)) {
    if (!properties[k] || (args[k] !== undefined && args[k] !== '')) continue;
    const alt = names.find((n) => !properties[n] && args[n] !== undefined && args[n] !== '');
    if (alt === undefined) continue;
    let v = args[alt];
    if (Array.isArray(v) && properties[k].type === 'string') v = v[0];
    args[k] = v;
    delete args[alt];
  }
  return args;
}

export function validateArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '参数必须是对象';
  normalizeArgs(tool, args);
  const { properties = {}, required = [] } = tool.input_schema;
  const got = () => { const s = JSON.stringify(args); return s === '{}' ? '（这次收到的参数是空的）' : `（这次收到的参数：${s.slice(0, 120)}）`; };
  for (const k of required) if (args[k] === undefined || args[k] === null || args[k] === '') return `缺少必填参数 ${k}${got()}`;
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
