import { reviewRealPresentation } from './presentationVisualReview.js';
import { preparePresentationImages } from './presentationImagePlan.js';
import { documentOutputPath } from './documentPath.js';
import { officeTypography } from './officeTypography.js';
import { requestedSlides, presentationCover } from './documentPageBudget.js';
import * as ws from './workspace.js';
import { generate } from './docs.js';
import { THEME_IDS, themeList } from './themes.js';
import { planDocument, documentError } from './documentPlan.js';
import { chooseDesign, DOC_KINDS, SHEET_KINDS } from './documentDesign.js';
import { styleRequests, relativeTypography, lastStyle } from './styleCheck.js';
import { STYLE_IDS, STYLE_NAMES } from './pptStyles.js';
import { deliverDocument } from './documentDelivery.js';
import { selfCheck, lint, fixAfterBuild, reviewSlidesByImage } from './selfCheck.js';
import { pickSheets, sheetSvg, rasterize } from './slidePreview.js';
import { throwControl } from '../core/networkRequest.js';
import { S, str, fmtSize, findTemplate } from './documentSchema.js';
import { formattingSource, verifyFormattingContent } from './documentPreservation.js';
import { formatDocumentFile } from './documentFileFormat.js';
import { documentTypography, typographyFromText } from './documentTypography.js';
import { presentationDesign } from './presentationDesign.js';
import { spreadsheetDesign, SHEET_STYLE_IDS, SHEET_STYLE_NAMES } from './spreadsheetDesign.js';

/** 保留原有一轮自修复与PPT看图检查，不额外叠加无界模型审稿。 */
/** 同一轮里同一个文件：内容一样就直接用上次的结果；已经请模型自查过的文件，重新生成时不再自查（评测里一份 PPT 生成了四遍，每遍都等自查） */
const sameRun = new WeakMap();
// 只保存摘要键，不把整篇正文留在缓存键里；缓存条数严格有界。
const digestOf = async (bytes) => {
  if (!globalThis.crypto?.subtle || bytes.length > 25_000_000) return null;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) => x.toString(16).padStart(2, '0')).join('');
};
const keyOf = async (args) => {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  if (bytes.length > 2_000_000) return null;
  return digestOf(bytes);
};
const keep = (map, key, value) => {
  if (!key) return;
  map.delete(key);
  map.set(key, value);
  while (map.size > 16) map.delete(map.keys().next().value);
};

export function createDocumentGenerateTool(ctx) {
  const memoOwner = ctx.documentMemoOwner || ctx;
  const memo = sameRun.get(memoOwner) ?? { results: new Map(), reviewed: new Map(), scopes: new WeakMap() };
  sameRun.set(memoOwner, memo);
  return {
    name: 'create_document',
    description: `生成 Office / 文档文件并保存到工作区；需要模板时先get_document_template。已有Word仅重排时用source_path保留原件结构，content可空；粘贴原文可用source_requirement_id绑定，不改写正文。生成后自动检查文件结构、读回内容，可用时由本机LibreOffice生成真实PDF预览。结构/估算检查不等于Office视觉验收。排版自动完成（A4、标题样式、编号列表、带表头底色的表格、页码；Word / PDF 的二级标题有 3 个以上时自动加目录）。
content 用 Markdown：
- docx / pdf / html：开头一个“# 文档标题”，正文用 ## 一级标题、### 二级标题、#### 三级标题；支持多级列表（缩进两个空格）、| 表格 |（:--: 居中、--: 右对齐）、**粗体**、*斜体*、~~删除线~~、[链接](https://…)、> 引用、代码块、--- 分隔线、单独一行 [分页]、![图注](工作区里的图片路径)
  招租、出租、招聘、启事、寻物、海报、宣传单这类贴出去的一页告示：kind 填 poster（不填也会自动认），字号按页面自动取最大、上下铺满一页、不加横线。用户说“字大点 / 小点 / 不要横线 / 铺满”时照原话调用，程序会换算成真实字号；改刚做好的文件时 path 用原文件路径直接覆盖，不要另起新文件名。交付后按回执里“读回实际”的字号回答，不要自己说“已加大”
- pptx：每页用“## 页标题”。汇报、方案类的页标题写成一句观点（如“建设必要性：补齐告警到处置的人工断点”）；剧情、介绍、攻略类用简洁准确的标题，不硬写观点句。用户自己给了分段的，一段一页、顺序不变。设计风格用 style（不填自动选）。版式按内容自动选：
  · 3–8 条“标签：说明”的要点 → 卡片（如“预警研判：多源证据汇聚……”）；页标题含流程 / 场景 / 步骤 / 闭环时 → 一排步骤箭头
  · 2–6 条以数字开头的要点（“67 万元：总投资”“0/12：雷达安装数”）→ 大数字卡片
  · 3–7 条以日期开头（“10-19 支架到货”“11月1日：初验”）→ 时间线
  · 3–8 条“名称：百分比”，或只有百分比列的表格（完成率、占比）→ 进度条
  · 一句“A→B→C→D”的链路 → 流程箭头图
  · 带数字列的表格 → 柱状图（合计行和单位不同的列写在旁边；大小差几十倍时改成表格）；其他表格 → 表格
  · 两个 ### 小标题 → 左右对比；一两句话，或一句话 + 一两条“标签：说明” → 大字重点页；标题是“第一部分……” → 章节页；“谢谢” → 结尾页
  · 每页多出一两句不带标签的话（总结、提醒）放进底部深色横条
  · 标题有“关系 / 人物 / 构成 / 架构”且写成 3–6 条“名称：说明”→ 关系图（一句不带标签的话当中心）；占比加起来 100% 的表格 → 环形图；行名是月份 / 季度 / 年份的数字表 → 折线图
  · 页内单独一行“版式：卡片”（大数字 / 卡片 / 步骤 / 时间线 / 流程 / 对比 / 图表 / 柱状图 / 饼图 / 折线图 / 关系图 / 进度 / 表格 / 重点句 / 章节 / 要点）可以指定版式，前后各空一行；排不成时生成结果里会说明
  图标可用get_ppt_icon_catalog按主题获取名字与含义，再在页内单独写“图标：volleyball, trophy”，按内容挑选；不必把全目录放进对话。
  每条一句完整的话，不要整页长段落；同一种版式不要连续超过 2 页，普通要点列表全篇不超过 3 页；封面信息（单位、日期）用 author 和副标题，不要再做一页“副封面”
- xlsx：CSV 或 Markdown 表格，“## 名称”分出多个工作表；“合计”行和“增长率 / 同比 / 完成率 / 执行率 / 占比”列会自动写成 Excel 公式（占比列留空即可），有“毛重 / 皮重（筐重）/ 净重”列时净重自动 = 毛重 − 皮重，有“数量（净重）/ 单价 / 金额”列时金额自动 = 数量 × 单价；也可以直接写“=SUM(B2:B5)”，汇总表引用明细表写“=明细!G10”；录入的数显示蓝字、公式格灰底，负数、超预算、“逾期 / 未付”自动标红，状态列有下拉选项，打印区域和页码自动设好；kind 填 settlement / ledger / budget / analysis 按用途排（不填自动判断）；1,200、18%、¥300、2026-10-14 会自动设成对应的数字格式。
  一个工作表里可以排成报表：“## 名称”下面第一行普通文字是副标题；“### 小节”是小节标题；可以放多张表（空行隔开）；表格之间的普通文字是说明 / 备注（整行显示）；不写“|---|”分隔行的表格是信息表（“| 项目名称 | xxx | 编号 | xxx |”，左边是名目）。只放一张表、没有文字时就是普通数据表（表头在第一行、带筛选）。
  把文档 / 材料整理成 Excel 时：第一个工作表做“总览”（基本信息用信息表，关键数字、投资结构、核心结论）；后面按主题分表，材料里的清单、明细逐项全部收进来，不要只摘一部分；每个小节、每个模块有小计；材料前后不一致或要核对的地方，写在说明里。新建表格用这个格式，不要自己写 openpyxl 代码排版
- csv：单个表格，自动加 BOM（Excel 打开中文不乱码）
theme 可选：${themeList()}。不填按内容自动选；公文（通知、请示、报告、函等）用 gongwen。`,
    input_schema: S(
      {
        format: { type: 'string', enum: ['docx', 'pptx', 'xlsx', 'pdf', 'html', 'md', 'txt', 'csv'] },
        path: str('保存路径；新建可省略，自动保存到outputs且重名不覆盖。修改指定原文件时必须提供原路径'),
        title: str('文档标题'),
        font_size: { type: 'number', minimum: 8, maximum: 72, description: '正文/单元格字号，磅；用户明确原话优先' },
        title_font_size: { type: 'number', minimum: 8, maximum: 72, description: '标题字号，磅' },
        content: str('Markdown 内容'),
        source_requirement_id: str('只排版、内容不变时，绑定read_task_requirements中用户原文编号；不从助手旧稿重写正文'),
        source_path: str('只排版已有Word时绑定工作区原DOCX路径；保留原文表格图片及关联，与source_requirement_id二选一'),
        theme: { type: 'string', enum: THEME_IDS, description: '配色主题，不填自动选' },
        style: { type: 'string', enum: STYLE_IDS, description: 'PPT 设计风格（构图不同，不只是颜色）：business 稳重商务（汇报、方案）/ minimal 简洁留白（产品、设计、品牌）/ story 叙事氛围（剧情、人物、历史、文化、旅行）/ data 数据报告（经营、财务、统计）。不填按用户要求和内容自动选' },
        sheet_style: { type: 'string', enum: SHEET_STYLE_IDS, description: 'Excel视觉风格：business商务表格/minimal简洁留白/ledger紧凑台账/analysis分析报表；不填按用户原话、Excel偏好和kind选。样式不移动行列，不改公式数据' },
        kind: { type: 'string', enum: [...Object.keys(DOC_KINDS), ...Object.keys(SHEET_KINDS)], description: `文种 / 用途，决定结构和排法。Word：${Object.entries(DOC_KINDS).map(([k, v]) => `${k} ${v}`).join('、')}；Excel：${Object.entries(SHEET_KINDS).map(([k, v]) => `${k} ${v}`).join('、')}。不填按标题和要求自动判断` },
        cover: { type: 'boolean', description: 'Word / PDF 加封面（正式报告、方案、标书类建议加）' },
        subtitle: str('副标题（可选）'),
        author: str('署名，如单位或部门（可选，用在封面）'),
        issuer: str('公文发文单位（可选，如“××县人民政府办公室”）：正式公文（通知、请示、函）填了会加红头“××文件”；不填时从文末落款单位取'),
        docNo: str('公文文号（可选，如“×政办发〔2026〕12号”），显示在红头下面'),
        toc: { type: 'string', enum: ['auto', 'yes', 'no'], description: '目录：auto（默认，二级标题 3 个以上时加）/ yes / no' },
        template_id: str('场景配方编号（get_document_template或plan_document查看），不填按要求选择；不替代用户上传的template文件'),
        template: str(
          'Word 模板路径（工作区里的 .docx，可选）：沿用模板的字体、标题和正文样式。不填且工作区只有一份Word模板时沿用；多份时先选定路径；传 "none" 不用模板'
        ),
        requirements: str('用户对这份文档的原始要求（尽量用原话：主题、必须包含的内容、字数页数、格式）。填了会在生成前对照检查有没有漏项，并自动改一轮')
      },
      ['format', 'content']
    ),
    run: async (
      { format, path, title, content, font_size: bodySize, title_font_size: titleSize, theme, style, sheet_style: sheetStyle, kind, cover, subtitle, author, issuer, docNo, toc, template, template_id: templateId, requirements, source_requirement_id: sourceId, source_path: sourcePath },
      execution = {}
    ) => {
      const { progress, signal, checkpoint, rawRequestText, requestText, executionScope, sessionId } = execution;
      path = await documentOutputPath(path, title, format, { signal });
      if (format !== 'docx' && (sourceId || sourcePath)) throw documentError('原Word/原文绑定请使用docx输出；PDF使用该Word的真实Office预览，不能另写一份替代原稿', 'DOCUMENT_SOURCE');
      // 每轮独立作用域，跨轮不能以旧回执跳过检查。
      let cache = memo;
      if (executionScope) {
        if (!memo.scopes.has(executionScope)) memo.scopes.set(executionScope, { results: new Map(), reviewed: new Map() });
        cache = memo.scopes.get(executionScope);
      }
      const goal = requestText || rawRequestText || requirements || '';
      let typography = format === 'docx' ? await documentTypography(ctx, goal, signal) : ['pptx','xlsx'].includes(format) ? officeTypography(rawRequestText || goal, { body: bodySize, title: titleSize }) : {};
      if (format === 'docx' && (bodySize !== undefined || titleSize !== undefined)) { const supplied = officeTypography('', { body: bodySize, title: titleSize }); for (const role of ['body','title']) typography[role] = { ...supplied[role], ...typography[role] }; }
      const source = format === 'docx' ? await formattingSource({ request: rawRequestText || goal, sessionId, sourceId, sourcePath, signal }) : null;
      if (source?.kind === 'docx') {
        // 按原文件重新排版时也要换算“大点 / 小点 / 不要横线”（第三轮 30 题：这条路先走了，正文 16→16、横线没管）
        const restyleAsks = styleRequests(rawRequestText || goal);
        let restyled = typography;
        if (restyleAsks.some((a) => a.id === 'bigger' || a.id === 'smaller'))
          ({ typography: restyled } = relativeTypography(typography, restyleAsks, { kind: kind || '', previous: await lastStyle(sessionId, executionScope), format, request: rawRequestText || goal, explicit: typographyFromText(rawRequestText || goal) }));
        return formatDocumentFile(ctx, source, { path, theme, kind, cover, toc, template, requirements, typography: restyled, noRules: restyleAsks.some((a) => a.id === 'noRule') }, execution);
      }
      // 排版时绕过模型提供的正文和改写审稿，确定性沿用已绑定的用户原文。
      if (source) content = source.content;
      const designOptions = { format, title, content, requirements, style, kind };
      const design = format === 'pptx'
        ? await presentationDesign(ctx, goal, designOptions, signal)
        : chooseDesign(designOptions);
      const sheetDesign = format === 'xlsx' ? await spreadsheetDesign(ctx, goal, { kind: design.kind, sheetStyle }, signal) : null;
      // 用户说“字大点 / 小点 / 铺满 / 不要横线”：换算成真实的字号和排法（见 styleCheck.js），改完由读回核对确认
      const asks = ['docx','pptx','xlsx'].includes(format) ? styleRequests(rawRequestText || goal) : [];
      if (format === 'docx' && asks.some((a) => a.id === 'fill') && design.kind === 'general' && String(content).replace(/\s/g, '').length <= 400) design.kind = 'poster';
      const noRules = asks.some((a) => a.id === 'noRule');
      let scale = 0;
      if (asks.some((a) => a.id === 'bigger' || a.id === 'smaller'))
        ({ typography, scale } = relativeTypography(typography, asks, { kind: design.kind, previous: await lastStyle(sessionId, executionScope), format, request: rawRequestText || goal, explicit: typographyFromText(rawRequestText || goal) }));
      const { forbidCover, requireCover } = presentationCover(goal);
      const expectedSlides = format === 'pptx' ? requestedSlides('PPT ' + goal) : null;
      const callKey = await keyOf({ format, path, title, content, theme, design, sheetDesign, kind, cover, subtitle, author, issuer, docNo, toc, template, templateId, requirements, goal, typography, noRules, scale, sessionId, sourceId: source?.id, workflow: ctx.documentContentReview?.workflowFile || null });
      // 记住的结果只管 10 分钟（同一个任务里重复调用）；隔得久了照常重新生成
      const fresh = (m, key, ms) => m.has(key) && Date.now() - m.get(key).at < ms;
      const cached = cache.results.get(callKey);
      const unchanged = cached && await ws.readBlob(cached.path).then(async (blob) => await digestOf(new Uint8Array(await blob.arrayBuffer())) === cached.digest && cached.digest !== null).catch(() => false);
      if (fresh(cache.results, callKey, 600_000) && unchanged) return `${cache.results.get(callKey).text}；这次的内容和上次完全一样，没有重新生成，文件就是上面这份`;
      const pathKey = await keyOf({ path, goal });
      const loadImage = async (src) => {
        if (/^(https?:|data:)/i.test(src)) return null;
        try {
          return new Uint8Array(await (await ws.readBlob(src)).arrayBuffer());
        } catch {
          return null;
        }
      };
      const { tpl, tplPath, auto } = await findTemplate(format, template);
      const plan = ['docx', 'pptx', 'xlsx', 'pdf', 'html', 'md'].includes(format)
        ? planDocument({ format, task: requirements || title || content.slice(0, 2000), template_id: templateId })
        : null;
      const taskRules = requirements && plan ? requirements + '\n制作约束：' + plan.rules.join('；') : requirements;
      const chosenTheme = theme || (templateId && templateId !== 'auto' ? plan?.theme : undefined);
      const chosenToc = toc || (templateId && content.length < 1500 ? 'no' : plan?.options.toc);
      // 生成前自查：规则检查；有原始要求或硬伤时请模型对照检查并改一轮
      // 请模型对照要求自查（十几秒）：同一个文件第一次生成、内容不算短，或规则检查查出了硬伤时才做；
      // 重新生成同一个文件（模型按检查结果改过一遍）不再自查。规则检查、排版检查、转 PDF 逐页检查照常每次都做
      const quick = fresh(cache.reviewed, pathKey, 1_800_000) || String(content).replace(/\s/g, '').length < 1200;
      const check = await selfCheck({
        format,
        content,
        requirements: taskRules,
        quick,
        kind: design.kind,
        llm: source || ctx.documentContentReview ? null : ctx.reasonLlm ?? ctx.llm ?? null,
        signal,
        onProgress: (t) => progress?.(t)
      });
      let imagePlan = [];
      const build = async (text) => {
        const prepared = format === 'pptx' ? await preparePresentationImages(ctx, text, { title: title || path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), requirements: goal, style: design.style, expectedSlides, requireCover, forbidCover }, execution) : { content: text, issues: [], plan: [] };
        imagePlan = prepared.plan;
        const generated = await generate(format, {
          // 文件名常带“_5页”：封面标题不要这个尾巴
          title: (title || path.replace(/^.*\//, '').replace(/\.[^.]+$/, '')).replace(/[_\s-]*\d+\s*页$/, ''),
          content: prepared.content,
          typography,
          noRules,
          scale,
          expectedSlides,
          requireCover,
          forbidCover,
          theme: chosenTheme,
          style: design.style,
          sheetStyle: sheetDesign?.style,
          kind: design.kind,
          layout: plan?.options.layout,
          cover: cover ?? plan?.options.cover ?? false,
          subtitle,
          author,
          issuer,
          docNo,
          toc: chosenToc === 'yes' ? true : chosenToc === 'no' ? false : 'auto',
          loadImage,
          renderSvg: ctx.renderSvg,
          signal,
          toPdf: ctx.toPdf ?? null,
          template: tpl
        });
        if (format === 'pptx') {
          generated.info.layoutIssues = [...(generated.info.layoutIssues || []), ...prepared.issues];
          generated.info.imagePlan = prepared.plan;
        }
        return generated;
      };
      let finalContent = check.content;
      let out = await build(finalContent);
      // 生成后才查得出的问题：Excel 公式错、PPT 字放不下 / 互相压住；有硬伤请模型改一轮再生成
      const built = (o) => [...(o.info?.formulaIssues ?? []), ...(o.info?.layoutIssues ?? [])];
      let post = null;
      if (built(out).length && !source) {
        post = await fixAfterBuild({
          format,
          content: check.content,
          issues: built(out),
          layout: out.info?.layout,
          requirements,
          llm: ctx.reasonLlm ?? ctx.llm ?? null,
          signal,
          rebuild: async (text) => {
            const o = await build(text);
            return { out: o, issues: built(o) };
          },
          onProgress: (t) => progress?.(t),
          label: format === 'xlsx' ? '检查公式…' : '检查排版…'
        });
        if (post.result) {
          out = post.result.out;
          finalContent = post.content;
        }
      }
      // PPT：画出每页的样子，交给能看图的模型检查一轮（没配能看图的模型、或者画不出图时跳过）
      let looked = null;
      // 看图检查（十几秒）：第一次生成照样看；同一个文件重新生成、估算也没排版问题的不再看
      const wantLook = built(out).length > 0 || !fresh(cache.reviewed, pathKey, 1_800_000);
      if (format === 'pptx' && !ctx.presentationOverview && ctx.visionLlm && out.info?.preview?.length && wantLook) {
        try {
          const errors = (o) => built(o).filter((x) => x.level === 'error').length;
          const sheets = pickSheets(out.info.preview, built(out));
          const images = [];
          for (const g of sheets) {
            const img = await (ctx.rasterize ?? rasterize)(sheetSvg(g));
            if (img) images.push(img);
          }
          if (images.length) {
            progress?.('看图检查排版…');
            const pages = sheets.flat().map((x) => x.n);
            const current = post?.result ? post.content : check.content;
            const v = await reviewSlidesByImage({ images, pages, content: current, requirements, llm: ctx.visionLlm, signal });
            looked = { pages: pages.length, problems: v.problems, changed: 0 };
            if (v.changed) {
              const o = await build(v.content);
              if (errors(o) <= errors(out)) {
                out = o;
                finalContent = v.content;
                looked.changed = v.changed;
              }
            }
          }
        } catch (e) {
          throwControl(e, signal);
        }
      }
      if (format === 'pptx' && ctx.presentationOverview) {
        const real = await reviewRealPresentation(ctx, out, finalContent, { requirements: goal, signal, progress, retrieval: execution.retrieval, build });
        out = real.out; finalContent = real.content;
      }
      const target = path.replace(/\.[a-z0-9]+$/i, '') + `.${out.ext}`;
      if (source && out.info?.missingImages?.length) throw Object.assign(new Error('只排版原文中的图片未完整载入，未覆盖目标文件'), { code: 'DOCUMENT_SOURCE', kind: 'validation' });
      const preservation = source ? {
        ...await verifyFormattingContent(out.blob, source.content, signal),
        sourceId: source.id,
        sourceSessionId: typeof sessionId === 'string' ? sessionId.slice(0, 160) : null,
        sourceDigest: await keyOf(source.content)
      } : null;
      if (ctx.documentContentReview && finalContent !== content) {
        ctx.documentContentReview.business = 'needs_recheck';
      }
      const r = await deliverDocument(ctx, out, target, { progress, signal, checkpoint, plan, issues: lint(format, finalContent, { kind: design.kind }), generatorReview: looked, requirements: goal || requirements, preservation, design: sheetDesign || design });
      const notes = [
        ...(imagePlan.length ? [`配图计划${imagePlan.length}段，来源顺序：用户指定图片、已有图表/图标、已验证图库、AI配图；成功资产缓存复用，实际页数与图片以读回回执为准`] : []),
        `主题：${out.theme.name}`,
        ...(design.label ? [`设计：${STYLE_NAMES[out.info?.style] || design.label}（${out.info?.style && out.info.style !== design.style ? '公文主题固定稳重商务，与请求风格冲突；未按请求风格生成' : design.reason}）`] : []),
        ...(sheetDesign ? [`表格样式：${SHEET_STYLE_NAMES[out.info?.sheetStyle] || sheetDesign.label}（${out.info?.sheetStyle !== sheetDesign.style ? '公文主题与请求风格冲突；未按请求风格生成' : sheetDesign.reason}）`] : []),
        r.validation.readback === 'passed' ? '已检查真实文件并读回有效内容' : '已检查文件头或结构',
        ...(plan ? ['制作方案：' + plan.templateName] : []),
        ...r.notes
      ];
      if (preservation) notes.push('只调整排版，已按绑定原文逐段逐格核对真实Word；未改写正文');
      if (check.checked)
        notes.push(
          check.changed
            ? `生成前对照要求自查，修正了 ${check.changed} 处${check.problems.length ? `（${check.problems.slice(0, 4).join('；')}）` : ''}`
            : '生成前对照要求自查，没发现问题'
        );
      const what = format === 'xlsx' ? '公式' : '排版';
      if (post?.fixed) notes.push(`生成后检查${what}，自动修正了 ${post.fixed} 处`);
      if (looked)
        notes.push(
          looked.changed
            ? `看图检查了 ${looked.pages} 页，修正了 ${looked.changed} 处${looked.problems.length ? `（${looked.problems.slice(0, 3).join('；')}）` : ''}`
            : `看图检查了 ${looked.pages} 页${looked.problems.length ? `，发现的问题没能自动改：${looked.problems.slice(0, 3).join('；')}` : '，没发现明显问题'}`
        );
      const left = [...lint(format, finalContent, { kind: design.kind }), ...built(out)];
      if (left.length) notes.push(`还需要注意：${left.map((x) => x.text).join('；')}`);
      // 用户指定了 PPT 字号又排不下：不能偷偷缩字，也别只报“可能溢出”就交差——精简那几页的字再生成一次（第二轮 30 题：24 磅第 3 页溢出）
      const overflow = format === 'pptx' && typography.body?.size && (r.validation.issues || []).some((i) => /放不下/.test(i.text));
      if (overflow) notes.push(`用户指定了正文 ${typography.body.size} 磅，不能靠缩小字号解决溢出：把检查提示放不下的那几页文字精简（每条一句短话，必要时少写一两条，页数不变），用同一路径再生成一次；精简后还放不下再照实告诉用户`);
      if (out.info?.toc) notes.push('已加目录（Word 打开时如提示更新域，点“是”即可填上页码；WPS 里右键目录 →“更新目录”）');
      if (out.info?.duplicatesRemoved) notes.push(`表格里有 ${out.info.duplicatesRemoved} 行和别的行重复，已自动去掉`);
      if (out.info?.duplicatesKept) notes.push(`表格里有 ${out.info.duplicatesKept} 行和别的行重复，但表里有公式没有自动删，请从原文里删掉重复行后重新生成`);
      if (out.info?.missingImages?.length) notes.push(`这些图片没找到，用占位文字代替了：${out.info.missingImages.join('、')}`);
      if (tpl) notes.push(`${auto ? '自动' : ''}沿用了模板 ${tplPath} 的样式${auto ? '（不想用模板就传 template: "none"）' : ''}`);
      if (out.note) notes.push(out.note);
      const pageChecked = !r.validation.wordPageBudget || r.validation.wordPageBudget.state === 'passed';
      if (!r.validation.errors && pageChecked) keep(cache.reviewed, pathKey, { at: Date.now() });
      // 没有硬伤：明说已经读回检查过——模型以前会再 read_file 好几遍、或者把同一份文件重新生成一遍
      if (!r.validation.errors && pageChecked && !left.some((x) => x.level === 'error') && r.validation.readback === 'passed') notes.push('文件已经生成并读回检查过，不需要再 read_file 核对或重新生成；直接告诉用户文件在哪、做了什么');
      const result = `${r.path}（${fmtSize(r.blob.size)}）。${notes.join('；')}`;
      if (!r.validation.errors && pageChecked) keep(cache.results, callKey, { text: result, path: r.path, digest: await digestOf(new Uint8Array(await r.blob.arrayBuffer())), at: Date.now() });
      return result;
    }
  };
}

