import * as ws from './workspace.js';
import { parseFile, generate } from './docs.js';
import { THEME_IDS, themeList } from './themes.js';
import { DOCUMENT_TEMPLATES, documentTemplate } from './documentTemplates.js';
import { deliverDocument } from './documentDelivery.js';
import { planDocument, documentError } from './documentPlan.js';
import { editSpreadsheet } from './spreadsheetEdit.js';
import { writeLongDocument, outlineMarkdown } from './longDoc.js';
import { editOffice } from './officeEdit.js';
import { TEMPLATE_PATH } from './docxWriter.js';
import { selfCheck, lint, fixAfterBuild, reviewSlidesByImage } from './selfCheck.js';
import { pickSheets, sheetSvg, rasterize } from './slidePreview.js';
import { throwControl } from '../core/networkRequest.js';

const S = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const fmtSize = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

/** 文档制作独立编排；入口只负责组装工具，不承担文件生成细节。 */
export function createDocumentTools(ctx) {
  /** Word 模板：指定了就用指定的；没指定就找工作区里最近改过的模板文件；"none" 不用 */
  const findTemplate = async (format, template) => {
    if (format !== 'docx' || template === 'none') return { tpl: null };
    let tplPath = template || '';
    const auto = !tplPath;
    if (auto) tplPath = (await ws.list().catch(error => { throwControl(error); throw error; })).filter((f) => TEMPLATE_PATH.test(f.path)).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0]?.path ?? '';
    if (!tplPath) return { tpl: null };
    try { return { tpl: new Uint8Array(await (await ws.readBlob(tplPath)).arrayBuffer()), tplPath, auto }; } catch (error) { throwControl(error); throw Object.assign(documentError(`找不到模板文件：${tplPath}`, 'DOCUMENT_TEMPLATE'), {cause:error}); }
  };
  return [
    {
      name: 'edit_office_document',
      description: '修改工作区里已有的 Word（.docx）或 PPT（.pptx），保留原来的排版和格式：替换文字（正文、表格、页眉页脚、每页幻灯片和备注都会找），Word 还可以在末尾追加段落（格式照抄最后一段）。适合“把文档里的 2025 改成 2026”“在合同里把甲方名称换掉”“在报告最后加一段说明”。要大改结构、或用户说“重新做 / 重做 / 再做一版”时用 create_document 重新生成。',
      input_schema: S({
        path: str('文件路径（.docx / .pptx）'),
        slides: { type: 'array', maxItems: 100, items: {type: 'integer', minimum: 1}, description: 'PPT指定实际页码（含封面，从1开始），只改这些页可见文字，不改备注；不填则沿用全文件替换' },
        expected_count: {type: 'integer', minimum: 0, description: '预期替换总次数，不符则整批不保存，防止误改同名文字'},
        replacements: { type: 'array', description: '要替换的文字', items: { type: 'object', properties: { find: str('原文（一字不差）'), replace: str('替换成') }, required: ['find', 'replace'], additionalProperties: false } },
        append: { type: 'array', items: { type: 'string' }, description: '追加到 Word 末尾的段落（每项一段，可选）' },
        save_as: str('另存为（可选，不填就改原文件；原文件会自动备份）')
      }, ['path']),
      run: async ({ path, replacements = [], append = [], slides = [], expected_count: expectedCount, save_as: saveAs }, options = {}) => {
        const kind = ws.ext(path);
        if (!['docx', 'pptx'].includes(kind)) throw new Error('只能修改 .docx 或 .pptx 文件；文本文件用 edit_file');
        const r = await editOffice(await ws.readBlob(path), kind, { replacements: Array.isArray(replacements) ? replacements : [], append: Array.isArray(append) ? append : [], slides, expectedCount, signal: options.signal });
        const hit = r.replaced.filter((x) => x.count);
        const miss = r.replaced.filter((x) => !x.count);
        if (!hit.length && !r.appended) throw new Error(`文件里没有找到要替换的文字：${miss.map((x) => `“${x.find}”`).join('、') || '（没有给出修改）'}。先用 read_file 看准原文`);
        const target = saveAs ? saveAs.replace(/\.[a-z0-9]+$/i, '') + `.${kind}` : path;
        const w = await deliverDocument(ctx, {blob:r.blob,ext:kind}, target, options);
        const parts = hit.map((x) => `“${x.find}”替换了 ${x.count} 处`);
        if (r.appended) parts.push(`追加了 ${r.appended} 段`);
        if (miss.length) parts.push(`没找到：${miss.map((x) => `“${x.find}”`).join('、')}`);
        return `已保存 ${w.path}（格式保留）：${parts.join('；')}；${w.notes.join('；')}${w.backup === 'saved' ? '。原文件已自动备份，可在“工作区 → 改动记录”里恢复' : ''}`;
      }
    },
    {
      name:'get_document_template',
      description:'查看未央内置的PPT、Word、Excel模板与制作检查清单。没有id时列出模板；有id时返回结构、版式和资料要求。先读用户材料，按实际用途填充，不能把模板当成已经完成的文件。',
      input_schema:S({id:str('模板编号；不填则列出全部模板')}),
      run:async({id})=>id?documentTemplate(id):JSON.stringify(DOCUMENT_TEMPLATES.map(({id,format,name,purpose})=>({id,format,name,purpose})),null,2)
    },
    {
      name: 'plan_document',
      description: '制作文档前选择场景方案，返回章节、布局骨架和检查要求，不请求模型、不写盘。先读取用户附件；返回的来源清单不代表已核实。普通任务不需停下来等用户确认。',
      input_schema: S({format:{type:'string',enum:['docx','pptx','xlsx','pdf','html','md']},task:str('用户原始要求'),template_id:str('可选，指定模板编号；auto自动选择'),audience:str('受众，已有信息足够时不要追问'),sources:{type:'array',maxItems:12,items:{type:'string'}}},['format','task']),
      run: async args => JSON.stringify(planDocument(args), null, 2)
    },
    {
      name: 'check_document',
      description: '对工作区真实Office文件重新检查结构、读回、公式，返回短检查报告；不写文件、不自动生成预览。静态检查或转换不证明事实准确，也不等于视觉验收。',
      input_schema: S({path:str('工作区文件路径'),required_text:{type:'array',maxItems:20,items:{type:'string'},description:'应出现的文字，只做片段匹配，不冒充语义审核'}},['path']),
      run: async ({path, required_text:requiredText = []}, options = {}) => {
        const ext = ws.ext(path);
        if (!['docx','pptx','xlsx'].includes(ext)) throw documentError('目前重新检查支持Word、PPT和Excel');
        const blob = await ws.readBlob(path);
        // 重新检查不重写原文件，也不因本地文件夹另存而生成无意义副本。
        const { inspectDocument, qualitySummary } = await import('./documentQuality.js');
        const report = await inspectDocument(blob,path,{requiredText,signal:options.signal});
        await options.checkpoint?.({type:'artifact_validation',path,validation:report});
        return JSON.stringify({path,...report,summary:qualitySummary(report)},null,2);
      }
    },
    {
      name: 'edit_spreadsheet',
      description: '精确修改已有Excel的指定格，保留其他部件；可带expected核对旧值，任何冲突整批不保存。修改公式缓存会失效，打开Office时重算，不伪造结果。新增行列或大改结构用create_document。',
      input_schema: S({path:str('工作区xlsx路径'),save_as:str('另存路径，可选'),edits:{type:'array',minItems:1,maxItems:100,items:S({sheet:str('实际工作表名'),cell:str('A1式地址'),value:{type:['string','number','boolean','null']},formula:str('公式，与value二选一'),expected:{type:['string','number','boolean','null']}},['sheet','cell'])}},['path','edits']),
      run: async ({path,edits,save_as:saveAs},options = {}) => {
        if (ws.ext(path) !== 'xlsx') throw documentError('只支持xlsx工作簿');
        const edited = await editSpreadsheet(await ws.readBlob(path),edits,{signal:options.signal});
        const target = saveAs ? saveAs.replace(/\.[a-z0-9]+$/i,'')+'.xlsx' : path;
        const saved = await deliverDocument(ctx,{blob:edited.blob,ext:'xlsx'},target,options);
        return `已修改${edited.changed}个单元格，保存${saved.path}；${saved.notes.join('；')}`;
      }
    },
    {
      name: 'create_document',
      description: `生成 Office / 文档文件并保存到工作区；需要模板时先get_document_template。生成后自动检查文件结构、读回内容，可用时由本机LibreOffice生成真实PDF预览。结构/估算检查不等于Office视觉验收。排版自动完成（A4、标题样式、编号列表、带表头底色的表格、页码；Word / PDF 的二级标题有 3 个以上时自动加目录）。
content 用 Markdown：
- docx / pdf / html：开头一个“# 文档标题”，正文用 ## 一级标题、### 二级标题、#### 三级标题；支持多级列表（缩进两个空格）、| 表格 |（:--: 居中、--: 右对齐）、**粗体**、*斜体*、~~删除线~~、[链接](https://…)、> 引用、代码块、--- 分隔线、单独一行 [分页]、![图注](工作区里的图片路径)
- pptx：每页用“## 页标题”，页标题写成一句观点（如“建设必要性：补齐告警到处置的人工断点”），版式按内容自动选：
  · 3–8 条“标签：说明”的要点 → 卡片（如“预警研判：多源证据汇聚……”）；页标题含流程 / 场景 / 步骤 / 闭环时 → 一排步骤箭头
  · 2–6 条以数字开头的要点（“67 万元：总投资”“0/12：雷达安装数”）→ 大数字卡片
  · 3–7 条以日期开头（“10-19 支架到货”“11月1日：初验”）→ 时间线
  · 3–8 条“名称：百分比”，或只有百分比列的表格（完成率、占比）→ 进度条
  · 一句“A→B→C→D”的链路 → 流程箭头图
  · 带数字列的表格 → 柱状图（合计行和单位不同的列写在旁边；大小差几十倍时改成表格）；其他表格 → 表格
  · 两个 ### 小标题 → 左右对比；一两句话，或一句话 + 一两条“标签：说明” → 大字重点页；标题是“第一部分……” → 章节页；“谢谢” → 结尾页
  · 每页多出一两句不带标签的话（总结、提醒）放进底部深色横条
  · 页内单独一行“版式：卡片”（大数字 / 卡片 / 步骤 / 时间线 / 流程 / 对比 / 图表 / 进度 / 表格 / 重点句 / 章节 / 要点）可以指定版式
  每条一句完整的话，不要整页长段落；同一种版式不要连续超过 2 页，普通要点列表全篇不超过 3 页；封面信息（单位、日期）用 author 和副标题，不要再做一页“副封面”
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
        issuer: str('公文发文单位（可选，如“××县人民政府办公室”）：正式公文（通知、请示、函）填了会加红头“××文件”；不填时从文末落款单位取'),
        docNo: str('公文文号（可选，如“×政办发〔2026〕12号”），显示在红头下面'),
        toc: { type: 'string', enum: ['auto', 'yes', 'no'], description: '目录：auto（默认，二级标题 3 个以上时加）/ yes / no' },
        template_id: str('场景配方编号（get_document_template或plan_document查看），不填按要求选择；不替代用户上传的template文件'),
        template: str('Word 模板路径（工作区里的 .docx，可选）：沿用模板的字体、标题和正文样式。不填时，工作区“模板 / templates”文件夹里或文件名带“模板”的 .docx 会自动使用；传 "none" 不用模板'),
        requirements: str('用户对这份文档的原始要求（尽量用原话：主题、必须包含的内容、字数页数、格式）。填了会在生成前对照检查有没有漏项，并自动改一轮')
      }, ['format', 'path', 'content']),
      run: async ({ format, path, title, content, theme, cover, subtitle, author, issuer, docNo, toc, template, template_id: templateId, requirements }, { progress, signal, checkpoint } = {}) => {
        const loadImage = async (src) => {
          if (/^(https?:|data:)/i.test(src)) return null;
          try { return new Uint8Array(await (await ws.readBlob(src)).arrayBuffer()); } catch { return null; }
        };
        const { tpl, tplPath, auto } = await findTemplate(format, template);
        const plan = ['docx','pptx','xlsx','pdf','html','md'].includes(format) ? planDocument({format,task:requirements || title || content.slice(0,2000),template_id:templateId}) : null;
        const taskRules = requirements && plan ? requirements+'\n制作约束：'+plan.rules.join('；') : requirements;
        const chosenTheme = theme || (templateId && templateId !== 'auto' ? plan?.theme : undefined);
        // 生成前自查：规则检查；有原始要求或硬伤时请模型对照检查并改一轮
        const check = await selfCheck({ format, content, requirements:taskRules, llm: ctx.reasonLlm ?? ctx.llm ?? null, signal, onProgress: (t) => progress?.(t) });
        const build = (text) => generate(format, {
          title: title || path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), content: text, theme:chosenTheme, layout:plan?.options.layout, cover: cover ?? plan?.options.cover ?? false, subtitle, author, issuer, docNo,
          toc: (toc || plan?.options.toc) === 'yes' ? true : (toc || plan?.options.toc) === 'no' ? false : 'auto', loadImage, toPdf: ctx.toPdf ?? null, template: tpl
        });
        let out = await build(check.content);
        // 生成后才查得出的问题：Excel 公式错、PPT 字放不下 / 互相压住；有硬伤请模型改一轮再生成
        const built = (o) => [...(o.info?.formulaIssues ?? []), ...(o.info?.layoutIssues ?? [])];
        let post = null;
        if (built(out).length) {
          post = await fixAfterBuild({
            format, content: check.content, issues: built(out), layout: out.info?.layout, requirements, llm: ctx.reasonLlm ?? ctx.llm ?? null, signal,
            rebuild: async (text) => { const o = await build(text); return { out: o, issues: built(o) }; },
            onProgress: (t) => progress?.(t), label: format === 'xlsx' ? '检查公式…' : '检查排版…'
          });
          if (post.result) out = post.result.out;
        }
        // PPT：画出每页的样子，交给能看图的模型检查一轮（没配能看图的模型、或者画不出图时跳过）
        let looked = null;
        if (format === 'pptx' && ctx.visionLlm && out.info?.preview?.length) {
          try {
            const errors = (o) => built(o).filter((x) => x.level === 'error').length;
            const sheets = pickSheets(out.info.preview, built(out));
            const images = [];
            for (const g of sheets) { const img = await (ctx.rasterize ?? rasterize)(sheetSvg(g)); if (img) images.push(img); }
            if (images.length) {
              progress?.('看图检查排版…');
              const pages = sheets.flat().map((x) => x.n);
              const current = post?.result ? post.content : check.content;
              const v = await reviewSlidesByImage({ images, pages, content: current, requirements, llm: ctx.visionLlm, signal });
              looked = { pages: pages.length, problems: v.problems, changed: 0 };
              if (v.changed) {
                const o = await build(v.content);
                if (errors(o) <= errors(out)) { out = o; looked.changed = v.changed; }
              }
            }
          } catch (e) { throwControl(e, signal); }
        }
        const target = path.replace(/\.[a-z0-9]+$/i, '') + `.${out.ext}`;
        const r = await deliverDocument(ctx,out,target,{progress,signal,checkpoint,plan,issues:check.issues});
        const notes = [`主题：${out.theme.name}`, '已检查真实文件结构并读回有效内容', ...(plan ? ['制作方案：'+plan.templateName] : []), ...r.notes];
        if (check.checked) notes.push(check.changed ? `生成前对照要求自查，修正了 ${check.changed} 处${check.problems.length ? `（${check.problems.slice(0, 4).join('；')}）` : ''}` : '生成前对照要求自查，没发现问题');
        const what = format === 'xlsx' ? '公式' : '排版';
        if (post?.fixed) notes.push(`生成后检查${what}，自动修正了 ${post.fixed} 处`);
        if (looked) notes.push(looked.changed ? `看图检查了 ${looked.pages} 页，修正了 ${looked.changed} 处${looked.problems.length ? `（${looked.problems.slice(0, 3).join('；')}）` : ''}` : `看图检查了 ${looked.pages} 页${looked.problems.length ? `，发现的问题没能自动改：${looked.problems.slice(0, 3).join('；')}` : '，没发现明显问题'}`);
        const left = [...check.issues, ...built(out)];
        if (left.length) notes.push(`还需要注意：${left.map((x) => x.text).join('；')}`);
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
      run: async ({ task, format = 'docx', path, title, material, material_files: materialFiles, words, outline_only: outlineOnly, outline, review = true, theme, cover, subtitle, author }, { progress, signal, checkpoint } = {}) => {
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
        const w = await deliverDocument(ctx,out,target,{progress,signal,checkpoint,issues:lint(format,r.markdown)});
        const previewNotes=w.notes;
        const chars = r.markdown.replace(/[\s#|*\-`>]/g, '').length;
        const lines = [`已生成 ${w.path}（${fmtSize(out.blob.size)}，${r.outline.length} 节，约 ${chars} 字，主题：${out.theme.name}）`];
        lines.push('已检查真实文件结构并读回有效内容',...previewNotes);
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
  ].map(tool => ({ ...tool, run: async (...args) => {
    try {
      return await tool.run(...args);
    } catch (error) {
      throwControl(error, args[1]?.signal);
      if (!error.code && !error.status && !error.kind) {
        error.code = 'DOCUMENT_OPERATION';
        error.kind = 'document';
      }
      throw error;
    }
  } }));
}
