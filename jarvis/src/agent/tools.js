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

const S = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const clip = (s, n = 20000) => (s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字）` : s);

/**
 * @param {object} ctx
 * @param {() => Promise<object>} ctx.metrics
 * @param {(path: string) => void} [ctx.onPreview]
 * @param {(path: string) => void} [ctx.onFileChanged]
 * @param {(url: string, init?: object) => Promise<Response>} [ctx.fetchViaGateway]  有网关时绕过浏览器跨域限制
 * @param {string} [ctx.tavilyKey]
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
      description: '读取技能附带的文件（模板、参考资料、脚本），路径来自 use_skill 返回的文件列表。',
      input_schema: S({ name: str('技能名称'), path: str('文件相对路径') }, ['name', 'path']),
      run: async ({ name, path }) => {
        const p = await packs.get(name);
        const text = p?.files?.[path.replace(/^\.?\//, '')];
        if (text == null) throw new Error(`技能「${name}」里没有文件 ${path}`);
        return clip(text, 30000);
      }
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
      description: '运行 Python（浏览器内的 Pyodide，首次使用需联网加载）。工作目录 /workspace 就是工作区，读写的文件会同步回工作区。可用 numpy、pandas 等常见库（自动加载）。',
      input_schema: S({ code: str('Python 代码') }, ['code']),
      run: async ({ code }) => {
        const listing = (await ws.list()).filter((f) => f.size < 5e6).slice(0, 60);
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

  if (ctx.tavilyKey) {
    tools.push({
      name: 'web_search',
      description: '联网搜索最新信息（新闻、价格、版本、事件等时效性内容）。回答时注明来源链接。',
      input_schema: S({ query: str('搜索词') }, ['query']),
      run: async ({ query }) => {
        const url = 'https://api.tavily.com/search';
        const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: ctx.tavilyKey, query, max_results: 5, include_answer: true }) };
        const res = ctx.fetchViaGateway ? await ctx.fetchViaGateway(url, init) : await fetch(url, init);
        if (!res.ok) throw new Error(`搜索服务返回 ${res.status}`);
        const j = await res.json();
        return [j.answer && `摘要：${j.answer}`, ...(j.results ?? []).map((r) => `- ${r.title}\n  ${r.url}\n  ${String(r.content || '').slice(0, 300)}`)].filter(Boolean).join('\n');
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
