import {createArchitectureWorkflowTool} from './architectureWorkflow.js';
import { assertArchitectureMutationBatch } from './architectureStateProtection.js';
import { architecturePathParts, isArchitectureMetadataPath } from './architectureStateOwnership.js';
import {createDocumentNavigation} from './documentNavigation.js';
import {createDocumentFileAccess} from './documentFileAccess.js';
import { createArchitecturePackageTool } from './architecturePackage.js';
import { createArchitectureRevisionTool } from './architectureRevision.js';
import { communicationPreferenceSupported } from './communicationPreferences.js';
import { createWorkRecordsTool } from './workLedger.js';
import { readGovernmentGuide } from './governmentGuide.js';
import { formatPageResult } from './pageLinks.js';
import { createDocumentTools } from './documentTools.js';
import { searchRequest, screenSearchHits } from './retrievalQuality.js';
import { createStockKlineTool } from './stockKline.js';
import { createSportsScoresTool } from './sportsScores.js';
import { queryGuardTool, guardQuery } from './queryGuard.js';
import { searchAggregateHints, safeFallbackQuery } from './searchFallback.js';
import { throwControl } from '../core/networkRequest.js';
import { createVerificationTool, currentTime } from './verifyNumbers.js';
import { checkpointView } from '../../shared/taskCheckpoint.js';
import { skillCompatibility } from './skillCompatibility.js';
import { MOBILE } from '../config.js';
/**
 * 智能体工具。每个工具：name / description / input_schema（JSON Schema）/ run(args) → 字符串结果。
 * 参数在执行前统一校验（流式工具参数可能被截断，模型偶尔也会漏参数），不合格就返回明确的错误让模型自行修正。
 */
import * as ws from './workspace.js';
import * as memory from './memory.js';
import * as kb from './knowledge.js';
import { withBom } from './xlsxWriter.js';
import { applyEdits } from './textEdit.js';
import { runJavaScript, runPython } from './sandbox.js';
import * as packs from './skillPacks.js';
import { isImageName, prepareImage } from './images.js';
import * as scheduler from './scheduler.js';
import * as sessions from './sessions.js';
import { createSearch } from './webSearch.js';
import { getWeather } from './weather.js';
import { createPageReader } from './pageReader.js';
import { withWebDeadline } from './retrievalBudget.js';
import { matchFiles } from './fileSearch.js';
import { deepResearch, DEPTHS } from './research.js';
import { factCheck, formatReport } from './factCheck.js';
import { preferenceClaim, preferenceSupported } from './memoryPreference.js';
import { evidence as evidenceStore } from './evidenceStore.js';
import { createSongTool } from './music.js';
import { createOcrTool } from './ocrTool.js';
import { createArchitectureEvidenceTool } from './architectureEvidenceTool.js';
import { createArchitecturePlanTool } from './architectureTool.js';
import { createDiagramTool } from './diagramTool.js';
import { createInspectImageTool } from './inspectImage.js';
import { createRenderDiagramTool, diagramPreview } from './diagramReview.js';
import { createExportDiagramTool } from './diagramExport.js';
import { assertImageExtension, imageFormat } from './imageFormat.js';

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
/** read_file 一次给多少字；长文件（如十几页的 PDF）分段读，结尾告诉模型从哪接着读 */
export const READ_PAGE_CHARS = 20000;
export function fileSegment(text, offset = 0, n = READ_PAGE_CHARS) {
  const start = Math.max(0, Math.min(Math.floor(Number(offset) || 0), text.length));
  if (!start && text.length <= n) return text;
  const end = Math.min(text.length, start + n);
  const tail = end < text.length ? `还没读完：接着读请再调用 read_file，offset 填 ${end}。没读完不能说已经看过全文。` : '已读到结尾。';
  return `${text.slice(start, end)}\n…（这是第 ${start + 1}–${end} 字，共 ${text.length} 字；${tail}）`;
}

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
  const navigation=createDocumentNavigation();
  const fileAccess=createDocumentFileAccess(navigation,fileSegment);
  ctx={...ctx,readDocument:navigation.read};
  const readPage = createPageReader(ctx); // 直接打不开或没读到正文时，有 Tavily Key 就让 Tavily 代读
  const seenFiles = new Set(); // 这次读过或写过的工作区文件（覆盖没读过的文件前先拦一下）
  const overwriteWarned = new Set();
  const tools = [
    createVerificationTool(),
    createWorkRecordsTool(),
    createSongTool(ctx),
    createOcrTool(ctx),
    createInspectImageTool(ctx),
    createArchitectureEvidenceTool(ctx),
    createArchitecturePlanTool(ctx),
    createArchitectureRevisionTool(ctx),
    createArchitecturePackageTool(ctx),
    createArchitectureWorkflowTool(ctx),
    createDiagramTool(ctx, {requireArchitecture:true}),
    createExportDiagramTool(ctx),
    createRenderDiagramTool(ctx),
    createStockKlineTool(ctx),
    createSportsScoresTool(ctx),
    queryGuardTool(),
    {
      name: 'remember',
      description: '把关于用户的长期信息存入记忆（偏好、身份、习惯、目标、重要事实）。用户说“记住……”或透露了以后用得上的个人信息时调用。用户纠正你的做事方式、说“记住这个教训”时用 category: lesson，记成经验教训。只有调用成功才算记住，不能只在回答里说“记住了”。和已有记忆重复会自动合并，同一件事的新说法会自动取代旧的（旧版本保留为历史）。不要记录密码、密钥等敏感信息。',
      input_schema: S({
        content: str('要记住的一句话，用第三人称陈述，如“用户喜欢简洁的回答”'),
        category: { type: 'string', enum: ['profile', 'preference', 'fact', 'goal', 'lesson', 'other'], description: 'profile 身份 / preference 偏好 / fact 事实 / goal 目标 / lesson 用户纠正过的做事方式（经验教训）' },
        importance: { type: 'integer', minimum: 1, maximum: 5, description: '重要度 1–5，身份信息和明确的长期偏好给 4–5' }
      }, ['content']),
      run: async ({ content, category, importance }, { sessionId, requestText, rawRequestText } = {}) => {
        const currentSession = sessionId ? await sessions.get(sessionId) : null;
        const said = requestText || rawRequestText || [...(currentSession?.messages || [])].reverse().find(message=>message.role==='user')?.content || '';
        const preference = category === 'preference' || preferenceClaim(content, category);
        const explicit = preference ? (preferenceSupported(content, said, category) || communicationPreferenceSupported(content, said)) : /记住|记下|我叫|我的名字|我住在/.test(said);
        // 做事方式的教训放进“经验教训”（每轮上下文里有一节），不混在关于用户的记忆里
        if (category === 'lesson') {
          const l = await memory.addLesson(content, said);
          return `已记为经验教训（${l.content}），以后的对话会带上。`;
        }
        const m = await memory.remember(content, category, {importance,source:explicit?'用户明确指令经工具记录':'模型工具记录，待核实',evidence:String(said).slice(0,500)});
        return m.action === 'NOOP' ? `这条已经记得（${m.content}），已刷新。`
          : m.action === 'UPDATE' ? `已更新记忆：「${m.previous}」→「${m.content}」（旧的保留为历史）。`
            : `已记录（${m.content}）${m.pending?'，待结合用户原话核实':''}。`;
      }
    },
    {
      name: 'recall',
      description: '在长期记忆、经验教训和过往对话摘要中检索与问题相关的内容。用户问“你记住了吗 / 有没有放进记忆”时先用它查，查到才说记住了。',
      input_schema: S({ query: str('检索关键词或问题') }, ['query']),
      run: async ({ query }) => {
        const r = await memory.recall(query);
        const lines = [
          ...(r.lessons ?? []).map((l) => `- [经验教训] ${l.content}`),
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
        const compatibility = skillCompatibility(p, { mobile: MOBILE });
        if (compatibility.status === 'blocked') return `${compatibility.label}：${compatibility.reason}`;
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
      run: async ({ name, path, to }, { progress, signal } = {}) => {
        throwControl(null, signal);
        const p = await packs.get(name);
        if (!p) throw new Error(`没有名为「${name}」的技能`);
        const rel = String(path).replace(/^\.?\//, '');
        const all = Object.keys(p.files || {});
        const folder = rel === '' || rel.endsWith('/') ? rel : all.some((k) => k.startsWith(`${rel}/`)) && !p.files[rel] ? `${rel}/` : null;
        const list = folder !== null ? all.filter((k) => k.startsWith(folder)) : [rel];
        if (!list.length || (folder === null && p.files[rel] == null)) throw new Error(`技能「${name}」里没有 ${path}（可用：${all.slice(0, 20).join('、') || '无'}）`);
        if (list.length > 60) throw new Error(`${path} 下有 ${list.length} 个文件，太多了：请复制更具体的子文件夹或单个文件`);
        const planned = list.map((key, index) => ({ key, index, path: folder === null && to ? to : `skills/${p.name}/${key}` }));
        await assertArchitectureMutationBatch(planned, { signal });
        const load = async (item) => {
          throwControl(null, signal);
          if (packs.isRemoteFile(p.files[item.key])) progress?.(`正在下载 ${item.key}（${item.index + 1}/${list.length}）`);
          try {
            const blob = await packs.fileBlob(p.files[item.key], signal ? { fetchImpl: url => globalThis.fetch(url, { signal }) } : undefined);
            throwControl(null, signal);
            return blob;
          } catch (error) { throwControl(error, signal); throw error; }
        };
        // 先核对所有候选JSON再写首文件；最多60份×2MB，普通大模板仍按原顺序流式复制。
        for (const item of planned) if (isArchitectureMetadataPath(architecturePathParts(item.path).join('/'))) {
          item.data = await load(item);
          await assertArchitectureMutationBatch([item], { signal });
        }
        await assertArchitectureMutationBatch(planned, { signal });
        const out = [];
        let bytes = 0;
        for (const item of planned) {
          const blob = item.data ?? await load(item);
          throwControl(null, signal);
          const w = await ws.write(item.path, blob);
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
        const type = (await imageFormat(blob))?.mime || (/\.svg$/i.test(path) ? 'image/svg+xml' : blob.type || 'image/png');
        ctx.onImage?.(URL.createObjectURL(new Blob([blob], { type })), path);
        return `已在对话里显示 ${path}`;
      }
    },
    {
      name: 'generate_image',
      description: '画图 / 生成图片（海报、插画、头像、配图等）：用服务商的画图模型（如 gpt-image）按描述生成一张图片，保存到工作区并显示在对话里。用户说“画一张… / 做个…的图片 / 生成图片”时使用。描述先明确主体、构图、风格、光线和必须保留/避免的内容。修改或参考已有图必须传referencePaths，不能只凭文字重画冒充原图编辑；精确架构图用create_diagram。',
      input_schema: S({ prompt: str('先写主体、构图、用途、风格与精确文字；改图还要写保留和修改范围'), size: str('标准尺寸或auto；GPT Image 2可用16倍数的自定义尺寸，如1536x864'), quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] }, outputFormat: { type: 'string', enum: ['png', 'jpeg', 'webp'] }, background: { type: 'string', enum: ['auto', 'opaque', 'transparent'] }, referencePaths: { type: 'array', maxItems: 3, items: { type: 'string' }, description: '参考/编辑已有图片时必须传真实工作区原图路径；不传表示从零创作' } }, ['prompt']),
      run: async ({ prompt: imagePrompt, size, referencePaths = [], quality, outputFormat, background }, { signal, retrieval } = {}) => {
        if (!ctx.imageGen) throw new Error('当前环境不能画图');
        const images = [];
        for (const path of referencePaths) {
          const blob = await ws.readBlob(path);
          if (blob.size > 10e6 || !/\.(png|jpe?g|webp)$/i.test(path)) throw Object.assign(new Error('参考图需为10MB以内的PNG/JPEG/WebP'), { code: 'IMAGE_EDIT_INPUT', kind: 'input' });
          images.push(blob);
        }
        if (images.length && !ctx.imageEdit) throw Object.assign(new Error('当前线路未提供原图编辑能力，不能把重新生成冒充编辑'), { code: 'IMAGE_EDIT_UNAVAILABLE', kind: 'capability' });
        const options = Object.fromEntries(Object.entries({ quality, outputFormat, background }).filter(([, value]) => value !== undefined));
        const r = await (images.length ? ctx.imageEdit : ctx.imageGen)({ prompt: imagePrompt, images, size: size || '1024x1024', signal, beforeRequest: () => retrieval?.consume('model'), ...options });
        const ext = /jpe?g/.test(r.blob.type) ? 'jpg' : /webp/.test(r.blob.type) ? 'webp' : 'png';
        await assertImageExtension('image.' + ext, r.blob);
        const name = String(imagePrompt).replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16) || 'image';
        const w = await ws.write(`images/${name}-${Date.now().toString(36)}.${ext}`, r.blob);
        ctx.onFileChanged?.(w.path);
        ctx.onImage?.(URL.createObjectURL(r.blob), w.path);
        return `已生成图片（${r.model}）并显示在对话里，保存在工作区 ${w.path}。生成成功不代表已通过视觉验收；需要时用inspect_image读取该文件检查。${r.revised ? `模型改写后的描述：${r.revised}` : ''}`;
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
      description: '搜索用户和你的所有对话（包括本段对话），只返回最相关的几处（每段对话一处），列不全：要列全“我问过哪些…”时改用 list_my_messages。用户提到“上次 / 之前说过 / 那天聊的”、或需要以前对话里的细节（方案、数据、结论、文件名）时使用。返回对话 id、标题、日期和命中的原话。',
      input_schema: S({ query: str('要找的内容，关键词或一句话') }, ['query']),
      run: async ({ query }, { sessionId } = {}) => {
        // 优先用任务绑定的会话，避免后台执行时跟随界面切到另一段。
        const currentId = sessionId ?? ctx.currentSessionId?.();
        const hits = await sessions.searchMessages(query, { current: currentId, k: 6, minScore: 0.5 });
        if (!hits.length) return '之前的对话里没有找到相关内容。';
        return hits.map((h) => `- id: ${h.sessionId}${h.sessionId === currentId ? '（就是本段对话）' : ''}「${h.title}」${new Date(h.ts).toLocaleString('zh-CN', { hour12: false })}\n  用户：${h.user.slice(0, 200)}${h.reply ? `\n  未央：${h.reply.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`).join('\n');
      }
    },
    {
      name: 'list_my_messages',
      description:
        '按时间逐条翻看用户在所有对话里说过的话（一页 40 条，一条不漏）。要列全时用：“我问过 / 搜过哪些…”“我所有的…”“我说过几次…”。可以给关键词（空格隔开，含任意一个就算）或日期范围缩小；没给关键词时要把每一页都翻完再回答。回答时只列这里出现过的，并说明一共翻了多少条、从哪天到哪天。',
      input_schema: S(
        {
          query: str('可选：关键词，空格隔开（如“公司 企业 股份 集团”）'),
          from: str('可选：开始日期，如 2026-09-01'),
          to: str('可选：结束日期，如 2026-10-22'),
          page: { type: 'integer', minimum: 1, description: '第几页，从 1 开始' }
        },
        []
      ),
      run: async ({ query, from, to, page = 1 }, { sessionId } = {}) => {
        const day = (s, end) => (s ? new Date(`${s}T${end ? '23:59:59' : '00:00:00'}+08:00`).getTime() : NaN);
        const r = await sessions.listUserMessages({ query, from: day(from) || 0, to: day(to, true) || Infinity, page, current: sessionId ?? ctx.currentSessionId?.() });
        if (!r.total) return query ? `所有对话里没有含“${query}”的话。` : '还没有聊天记录。';
        const date = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
        const head = `共 ${r.total} 条（${date(r.span[0])} 到 ${date(r.span[1])}），第 ${r.page}/${r.pages} 页${r.page < r.pages ? `；还有下一页，用 page: ${r.page + 1} 接着翻` : '；已经是最后一页'}`;
        return `${head}\n${r.items.map((m) => `- ${date(m.ts)}「${m.title}」（id: ${m.sessionId}）：${m.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}`;
      }
    },
    {
      name: 'read_conversation',
      description: '读取本段或其他对话的全文（id 来自 search_conversations 或上下文里的对话记录）。内容很长时可以给 query，只读相关的部分。',
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
      name: 'find_files',
      description: '按文件名找工作区里的文件：支持 * 和 **（如 “*.docx”“报告*”“src/**/*.js”），也可以只给名字里的几个字。比 list_files 列全部再找快。',
      input_schema: S({ pattern: str('文件名或通配符，如 *.xlsx、周报、site/**/*.html') }, ['pattern']),
      run: async ({ pattern }) => {
        const hits = matchFiles(await ws.list(''), pattern).slice(0, 80);
        return hits.length ? hits.map((f) => `${f.path}  (${fmtSize(f.size)})`).join('\n') : `没有找到和“${pattern}”匹配的文件。可以换个关键词，或用 list_files 看全部文件`;
      }
    },
    {
      name: 'search_in_files',
      description: '搜工作区原文。path明确指定DOCX/PDF/PPT/Excel时解析该原件，返回真实命中位置及sectionId；不把未检索说成未找到。目录扫描仅搜代码/文本，每次最多100文件。先定位再按章节读，不顺序反复翻整份招标书。',
      input_schema: S({ query: str('要找的文字（不区分大小写）'), path: str('可选：只在这个目录或文件里找'), regex: { type: 'boolean', description: 'query 当正则表达式用' } }, ['query']),
      run: (args,execution) => fileAccess.search(args,execution)
    },
    {
      name: 'read_file',
      description: '读取原文件。长Word/PDF先用view=sections取得程序生成的目录与sectionId，或用query定位，再以sectionId读相关原文；不要猜章节名或反复顺序翻整份文件。正文分页2万字，95%以上重叠范围不重复发送；目录和片段不代表全文已读。代码文本原样返回，图片直接查看。',
      input_schema: S({ path: str('文件路径'), offset: { type: 'integer', minimum: 0, description: '正文/关键词的字符起点；sectionId存在时为该范围内偏移' }, view:{type:'string',enum:['text','sections']},query:{type:'string',maxLength:120},sectionId:{type:'string',maxLength:120},recover:{type:'boolean',description:'仅在旧工具结果已过期且确需原文时恢复该页；每个重叠范围最多恢复一次，不能用offset加1绕过'},catalogOffset:{type:'integer',minimum:0,maximum:1000},limit:{type:'integer',minimum:1,maximum:20} }, ['path']),
      run: async ({ path, offset = 0,...options }, { signal } = {}) => {
        let blob = await ws.readBlob(path);
        seenFiles.add(ws.normalize(path));
        if(isImageName(path)&&typeof document==='undefined'){
          if ((await imageFormat(blob))?.ext === 'svg') blob = await diagramPreview(ctx, await blob.text(), { signal });
          if(blob.size>8e6)throw new Error('图片超过8MB，请先压缩后再补充，或作为新消息发送');
          const bytes=new Uint8Array(await blob.arrayBuffer());
          const head=String.fromCharCode(...bytes.slice(0,12));
          const mime=bytes[0]===0x89&&head.slice(1,4)==='PNG'?'image/png':bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff?'image/jpeg':/^GIF8[79]a/.test(head)?'image/gif':head.startsWith('RIFF')&&head.slice(8,12)==='WEBP'?'image/webp':null;
          if(!mime)throw new Error('图片文件头无效，无法交给模型查看');
          return {text:'图片 '+path,images:[{mime,data:Buffer.from(bytes).toString('base64')}]};
        }
        if (isImageName(path) && typeof document !== 'undefined') {
          const img = await prepareImage(blob);
          return { text: `图片 ${path}（${img.width}×${img.height}）`, images: [{ mime: img.mime, data: img.data }] };
        }
        if (ws.isText(path)&&!options.query&&!options.sectionId&&options.view!=='sections') return fileSegment(await blob.text(), offset);
        return fileAccess.read({path,offset,...options},{signal});
      }
    },
    {
      name: 'write_file',
      description: '在工作区写入文本文件（代码、网页、Markdown、CSV、JSON 等）。编写程序时把每个文件分别写入。',
      input_schema: S({ path: str('文件路径，如 app/index.html'), content: str('完整文件内容') }, ['path', 'content']),
      run: async ({ path, content }) => {
        await assertImageExtension(path, new Blob([content]));
        if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(path)) throw Object.assign(new Error('write_file只能写文本，不能把文本或Base64当位图；请保存.svg后用render_diagram转换，或调用generate_image'), { code: 'IMAGE_BINARY_WRITE', kind: 'input' });
        // 先读后改：已经存在、这次还没读过也没写过的文件，第一次要整个覆盖时先拦一下（坚持再写一次就放行）
        const key = ws.normalize(path);
        if (ws.mode() !== 'folder' && !seenFiles.has(key) && !overwriteWarned.has(key) && await ws.exists(path).catch(() => false)) { // 本地文件夹里本来就不覆盖同名文件（会另存）
          overwriteWarned.add(key);
          throw new Error(`${path} 已经存在，你还没读过它。先用 read_file 看看现在的内容；只改一部分用 edit_file；确认要整个覆盖就再调用一次 write_file`);
        }
        seenFiles.add(key);
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
        let r;
        try { r = applyEdits(before, Array.isArray(edits) ? edits : []); } catch (e) {
          throw seenFiles.has(ws.normalize(path)) ? e : new Error(`${e.message}。你还没读过这个文件：先用 read_file 看准原文再改`);
        }
        seenFiles.add(ws.normalize(path));
        await assertImageExtension(path, new Blob([r.text]));
        const w = await ws.write(path, r.text);
        ctx.onFileChanged?.(w.path);
        return `已修改 ${w.path}：替换 ${r.count} 处${w.renamed ? '（本地文件夹里不覆盖同名文件，另存为此名）' : ''}${w.backup === 'saved' ? '；原来的内容已自动备份，可在“工作区 → 改动记录”里恢复' : ''}`;
      }
    },
    ...createDocumentTools(ctx),
    {
      name:'read_task_checkpoint',
      description:'读取当前会话最近任务的持久检查点：完整要求、补充、成功/失败步骤、文件以及结果未知的操作，还有已经读过的网页证据编号（看原文用 read_evidence）。恢复任务时先核对，不自动重放有副作用的动作。',
      input_schema:S({}),
      run:async(_,{sessionId}={})=>{const id=sessionId??ctx.currentSessionId?.();const s=id&&await sessions.get(id);const evidence=id?await evidenceStore.index(id):[];return s?.taskCheckpoint||evidence.length?JSON.stringify({current:checkpointView(s?.taskCheckpoint),recoveries:(s?.recoveryCheckpoints||[]).map(checkpointView),...(evidence.length&&{evidence:evidence.map(({id,url,title})=>({id,url,title}))})},null,2):'当前会话没有服务器持久检查点；可读取对话原文和工作区文件核对。';}
    },
    {
      name:'read_evidence',
      description:'按编号取回这段对话里已经读过的网页原文片段（fact_check、fetch_url 读过的，最多 6000 字），不用重新联网。不填编号时列出全部编号。编号见 read_task_checkpoint 的 evidence 或 fetch_url 结果末尾。',
      input_schema:S({id:str('证据编号，如 e1a2b3c；不填则列出全部')}),
      run:async({id},{sessionId}={})=>{
        const sid=sessionId??ctx.currentSessionId?.();
        if(!id){const list=await evidenceStore.index(sid);return list.length?list.map(x=>`${x.id}  ${x.title||'（无标题）'}  ${x.url}`).join('\n'):'这段对话还没有存下的网页证据（超过 24 小时会清掉）；需要时用 fetch_url 重新读取。';}
        const e=await evidenceStore.get(sid,String(id).trim());
        return e?`${e.title||'（无标题）'}\n${e.url}\n\n${e.text}`:`找不到证据 ${id}（可能已过期或不是这段对话的）；需要时用 fetch_url 重新读取。`;
      }
    },
    {
      name: 'run_javascript',
      description: '在不透明来源隔离环境运行 JavaScript：无DOM、不可访问应用存储、不可联网。用于计算、数据处理和验证代码；联网读取用fetch_url工具。用console.log输出，return返回值；超时8秒，可停止。',
      input_schema: S({ code: str('JavaScript 代码（作为 async 函数体执行）') }, ['code']),
      run: async ({ code }, {signal} = {}) => {const r=await runJavaScript(code,{signal});throwControl(null, signal);if(!r.ok)throw new Error(formatRun(r));return formatRun(r);}
    },
    {
      name: 'run_python',
      description: '运行 Python（浏览器内的 Pyodide，首次使用需联网下载几十 MB，手机上常要几分钟；读文件用 read_file、生成文档用 create_document，不要用它代替）。工作目录 /workspace 就是工作区，读写的文件会同步回工作区。可用 numpy、pandas 等常见库（自动加载）；python-pptx / python-docx / openpyxl 等纯 Python 库在代码开头用 `import micropip; await micropip.install("python-pptx")` 安装。',
      input_schema: S({ code: str('Python 代码') }, ['code']),
      run: async ({ code }, { signal } = {}) => {
        const listing = pickPythonFiles(await ws.list(), code);
        const files = await Promise.all(listing.map(async (f) => ({ path: f.path, bytes: await (await ws.readBlob(f.path)).arrayBuffer() })));
        const r = await runPython(code, { files, signal });
        throwControl(null, signal);
        if(!r.ok)throw new Error(formatRun(r));
        await assertArchitectureMutationBatch(r.changed ?? [], { signal });
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
        return `已在预览区打开 ${path}。这是预览入口，不代表已经运行或通过项目测试；有测试命令时仍需执行。`;
      }
    },
    {
      name: 'fetch_url',
      description: '读取网页或PDF正文，附页面栏目和附件链接；链接指向的内容需继续读取。',
      input_schema: S({ url: str('http(s) 地址') }, ['url']),
      run: async ({ url }, { signal, progress, retrieval, sessionId, requestText } = {}) => {
        if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http(s) 地址');
        retrieval?.consume('read');
        let text;
        try {
          text = await readPage(url, { signal, progress, consume: kind => retrieval?.consume(kind) });
        } catch (error) {
          throwControl(error, signal);
          if (error.code === 'PRIVATE_NETWORK_BLOCKED') throw error;
          const hints = await searchAggregateHints(safeFallbackQuery(url, requestText), {
            get: ctx.fetchViaGateway ?? ((...args) => fetch(...args)), signal, retrieval
          });
          return '原网页读取失败：' + error.message + '\n以下只是聚合搜索线索，未取得原站正文，不能声称已核实：\n' + JSON.stringify(hints);
        }
        const guide = await readGovernmentGuide({ text, url, requestText, signal, read: async address => {
          retrieval?.consume('read');
          return readPage(address, { signal, progress, consume: kind => retrieval?.consume(kind) });
        } });
        // 存一份原文片段：之后要细节用 read_evidence 取，不用重新联网
        const sid = sessionId ?? ctx.currentSessionId?.();
        const [id] = sid && text ? await evidenceStore.put(sid, { sources: [{ url, title: String(text).split('\n').find((l) => l.trim())?.trim().slice(0, 120), text }, ...(guide ? [{ url: guide.url, title: '政府申请指南', text: guide.text }] : [])] }).catch(() => []) : [];
        return '【网页读取回执】' + JSON.stringify({ url: guide?.url || url }) + '\n' + (guide ? formatPageResult(guide.text) + '\n\n【最初页面（不作为指南正文证据）】\n' + formatPageResult(text) : formatPageResult(text)) + (id ? `\n\n（已存为证据 ${id}，之后要看原文用 read_evidence）` : '');
      }
    },
    {
      name: 'get_current_time',
      description: '读取当前日期和时间（含时区）。',
      input_schema: S({}),
      run: async () => JSON.stringify(currentTime())
    },
    {
      name: 'get_weather',
      description: ctx.qweather
        ? '查天气：某个城市的实况（体感、湿度、风向风力、气压、能见度）、未来两小时降水、逐小时、未来几天预报（日出日落、紫外线）、空气质量、生活指数和天气预警，数据来自和风天气（国内气象数据）。'
        : '查天气：某个城市的实况和未来几天预报（温度、天气、降水概率、风），数据来自国际气象模型。国内城市如果你能联网搜索，再搜一下“城市 日期 天气 中国天气网”核对一次，两者不一致时以中国气象局（中国天气网）为准。',
      input_schema: S({ place: str('城市或地区名，如“南京”“上海浦东”“Tokyo”'), days: { type: 'number', description: '要几天预报，默认 3，最多 7' } }, ['place']),
      run: async ({ place, days }, { signal, retrieval } = {}) => getWeather(place, { signal, retrieval, qweather: ctx.qweather, get: ctx.fetchViaGateway || ((u, o) => fetch(u, o)), days: Math.min(7, Math.max(1, Number(days) || 3)) })
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
      run: async ({ query, queries, freshness }, { signal, retrieval, requestText, progress } = {}) => {
        const list = [...new Set([query, ...(Array.isArray(queries) ? queries : [])].map((q) => String(q || '').trim()).filter(Boolean).map(q => guardQuery(q, { original: requestText }).query))].slice(0, 8);
        if (!list.length) throw new Error('请给出搜索词');
        let successes = 0;
        const one = async (q) => {
          try {
            const selected = searchRequest(q, requestText, freshness);
            retrieval?.registerQuery?.(selected.query);
            retrieval?.consume('search');
            const rawHits = await withWebDeadline((s) => engine.search(selected.query, list.length > 1 ? 5 : 6, { freshness: selected.freshness, signal: s, progress, consume: kind => retrieval?.consume(kind) }), { signal, timeoutMs: 40000 });
            const screened = screenSearchHits(rawHits, requestText);
            const hits = screened.hits;
            if (!hits.length && screened.rejected) throw Object.assign(new Error('检索结果与今日新闻不对应，请换原始报道来源，不用年度日历代替新闻'), { code: 'IRRELEVANT_SEARCH_RESULTS', kind: 'api' });
            if (hits.length) successes++;
            return hits.length ? hits.map((r) => `- ${r.title}\n  ${r.url}\n  ${String(r.snippet || '').slice(0, r.source === 'deepseek' ? 800 : 300)}${r.source === 'deepseek' ? '\n  （DeepSeek检索摘要，未读原文）' + (r.publishedAt ? ' 发布时间：' + r.publishedAt : '') : ''}`).join('\n') : '（没有结果：换个说法、换成英文或原文再搜）';
          } catch (e) {
            if (signal?.aborted || e.name === 'AbortError') throw e;
            // 预算用完：别的词搜到了就照常返回；全没搜到才把预算错误交给主循环（它会让模型直接整理答案，而不是换词再搜）
            if (e.code === 'RETRIEVAL_BUDGET') { budgetHit = e; return `（没有搜：${e.message}）`; }
            lastSearchError = e;
            return `（搜索失败：${e.message}）`;
          }
        };
        let budgetHit = null;
        let lastSearchError = null;
        const outs = await Promise.all(list.map(one));
        if (!successes) {
          if (budgetHit) throw budgetHit;
          throw Object.assign(new Error('搜索失败：' + outs.join('\n')), { cause: lastSearchError, kind: lastSearchError?.kind, code: lastSearchError?.code || 'NO_SEARCH_RESULTS', status: lastSearchError?.status, name: lastSearchError?.name || 'SearchError' });
        }
        return list.length === 1 ? outs[0] : list.map((q, i) => `### ${q}\n${outs[i]}`).join('\n\n');
      }
    });
    tools.push({
      name: 'fact_check',
      description: '逐项联网查证：要查的对象有好几个（截图里的多场比赛、多只股票、多个产品的价格、清单里的多个事件），或用户明确要求逐项、交叉核验时使用。普通单一问题先用 web_search 搜索、必要时读一两条官方原文，证据足够就回答。程序会对每一项：还原原文名、多语言搜索、读原文、让模型摘答案并给原文引用、核对引用确实在原文里、实际读到的官方原文可单源核实，其他来源要求两个网站一致，不够就换搜索词再查。比自己用 web_search 拼凑准确得多。调用前先把图片 / 文字里的每一项原样列进 items（编号、名称、时间、相关选项都写进 label / details），不要漏项、不要改名。',
      input_schema: S({
        question: str('每一项要查什么，写具体，如“这场比赛的全场比分（和半场比分）”“今天收盘价和涨跌幅”'),
        items: { type: 'array', description: '要查证的对象，逐项列出（最多 20 项）', items: { type: 'object', properties: { label: str('对象名称，原样照抄，如“迪拜连接 VS 吉达国民”'), details: str('补充信息：编号、联赛、开赛时间、日期等，如“周一001，开赛 10-12 23:00”') }, required: ['label'], additionalProperties: false } },
        date: str('事件发生的日期或时间范围，如 2026-10-12（不知道就留空）'),
        context: str('背景，如“中国体育彩票竞彩足球，第 2610121 期”')
      }, ['question', 'items']),
      run: async ({ question, items, date, context }, { progress, signal, retrieval, sessionId } = {}) => {
        const sid=sessionId??ctx.currentSessionId?.(); // 用这轮任务所属的对话，不用界面上当前打开的
        const session=sid ? await sessions.get(sid).catch(()=>null) : null;
        const resuming=/^(?:继续|恢复|接着)(?:[：:，,。\s]|$)/.test([...session?.messages||[]].reverse().find(m=>m.role==='user')?.content||'');
        const records=resuming ? await evidenceStore.records(sid).catch(()=>[]) : [];
        const r = await factCheck({
          question, items, date, context, signal,
          mode: retrieval && !retrieval.extensive && items?.length===1 ? 'quick' : 'thorough',
          consume: kind => retrieval?.consume(kind),
          evidence: records,
          onEvidence: evidence => signal?.aborted || !sid ? undefined : evidenceStore.put(sid,evidence),
          llm: ctx.reasonLlm ?? ctx.llm ?? null,
          search: (q, n, o) => engine.search(q, n, { ...o, signal, consume: kind => retrieval?.consume(kind) }),
          read: (url) => readPage(url, { signal, progress, consume: kind => retrieval?.consume(kind) }),
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
      run: async ({ question, depth = 'standard' }, { progress, signal, retrieval, sessionId } = {}) => {
        const r = await deepResearch({
          question, depth, llm: ctx.llm ?? null, signal,
          consume: kind => retrieval?.consume(kind),
          evidence: sessionId ? await evidenceStore.records(sessionId) : [],
          onEvidence: item => sessionId ? evidenceStore.put(sessionId, item) : undefined,
          search: (q, n) => engine.search(q, n, { signal, consume: kind => retrieval?.consume(kind) }),
          read: (url) => readPage(url, { signal, progress, consume: kind => retrieval?.consume(kind) }),
          onProgress: ({ text }) => progress?.(text)
        });
        if (signal?.aborted) throw Object.assign(new Error('已停止调研'), { name: 'AbortError' });
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
