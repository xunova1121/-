/** 同一任务试排稿私存，默认交付一张成品；旧文件不删除、不覆盖。工作区“历史稿”只列以前交付过的完整成品（delivery.previousVersions），试排过程文件不列。 */
import * as ws from './workspace.js';
import { scopedState } from './store.js';
import { wantsIllustratedPoster } from './posterContent.js';
import { recordWorkAttempt } from './workLedger.js';
import { preservePosterSource } from './posterSourceAlias.js';
import { throwControl } from '../core/networkRequest.js';
import { rememberDesignTask, recallDesignTask } from './designTaskMemory.js';
import { verifyDeliveryAccess } from './deliveryAccess.js';

const states = scopedState('files', () => new WeakMap());
const MAX_ATTEMPTS = 3;
const MAX_CORRECTIONS = 4;
const failure = message => Object.assign(new Error(message), { code: 'POSTER_TASK_LIMIT', kind: 'validation' });

/** 无任务作用域的旧扩展/单独导出保持原约定；有作用域的智能体使用统一交付。 */
export function withPosterDelivery(tool, ctx, factory) {
  const core = tool.run;
  return { ...tool, run: async (input = {}, options = {}) => {
    // 草图对比不出正式稿，不进试排计数和历史
    if (!options.executionScope || options.posterInternal || input.sketches !== undefined) return core(input, options);
    const captured = states(), workspaceId = ws.mode() + ':' + ws.folderName();
    if (!captured.has(options.executionScope)) captured.set(options.executionScope, new Map());
    const groups = captured.get(options.executionScope);
    const multiple = /(?:两|三|四|多|[2-9])(?:张|款|套).{0,8}海报|海报.{0,8}(?:两|三|四|多|[2-9])(?:张|款|套)/.test(options.rawRequestText || '');
    const groupKey = multiple ? String(input.path || input.title || '海报').slice(0, 300) : 'single';
    let task = groups.get(groupKey);
    if (!task) {
      if (groups.size >= 12) throw failure('本轮海报数量已达12张，请分批制作');
      task = { id: crypto.randomUUID(), attempts: 0, corrections: 0, calls: 0, rich: false, tail: Promise.resolve(), last: null, signatures: new Map(), sourceAliases: [], versions: [] };
      groups.set(groupKey, task);
    }
    // 排字不是批量出方案；同轮重复/改名不产生另一组公开成果。
    const signature = (tool.name || 'make_poster') + ':' + JSON.stringify({ ...input, path: undefined });
    const job = async () => {
      const assertCurrent = () => {
        throwControl(null, options.signal);
        if (states() !== captured || ws.mode() + ':' + ws.folderName() !== workspaceId) throw failure('工作区已切换，本轮停止交付；请回到原工作区查看历史稿');
      };
      assertCurrent();
      const previous = await recallDesignTask(options.sessionId, options.rawRequestText, options);
      assertCurrent();
      if (previous && task.calls === 0 && groupKey === 'single' && (!input.source_path || input.source_path === previous.sourcePath)) {
        task.id = previous.deliveryId;
        task.calls = previous.historyStep || 0;
        task.rich ||= previous.illustrated === true;
        task.sourceAliases = [...(previous.sourceAliases || [])];
        task.carried = true; // task.last 来自以前的回合（用户要求改稿），被替换时才算一版历史稿
        task.versions = (previous.previousVersions || []).filter(p => typeof p === 'string' && p.startsWith(previous.historyPrefix)).slice(-8);
        task.last = { kind: 'poster', status: previous.quality === 'complete' ? 'complete' : 'partial', files: [], designPath: previous.sourcePath,
          delivery: { id: previous.deliveryId, primaryPath: previous.primaryPath, historyPrefix: previous.historyPrefix,
            title: previous.title, quality: previous.quality, sourceFiles: [previous.sourcePath], attempts: 0, retryAllowed: true } };
      }
      if (!input.source_path && !input.design && (input.changes || input.canvas)) {
        if (previous && (input.canvas && /\.canvas\.json$/i.test(previous.sourcePath) || input.changes && /\.design\.json$/i.test(previous.sourcePath))) input = { ...input, source_path: previous.sourcePath };
        assertCurrent();
      }
      if (task.signatures.has(signature)) return task.signatures.get(signature);
      if (task.attempts >= MAX_ATTEMPTS || task.corrections >= MAX_CORRECTIONS) return JSON.stringify({ ...(task.last || { kind: 'poster', files: [] }), status: 'partial',
        errors: [{ code: 'POSTER_TASK_LIMIT', message: '本次修改未执行，不可称修改完成' }], retryAllowed: false,
        notice: task.corrections >= MAX_CORRECTIONS ? '本任务参数纠正已达4次；尚未完成的修改不能称成功，已有成品仍保留。' : '本任务已完成3次试排，请交付现有成品或说明待完善项；不再重复导出，不自动付费重画。' });
      let started = false;
      const beginPosterAttempt = () => {
        assertCurrent();
        if (!started) { task.attempts++; started = true; }
      };
      // 旧扩展未实现阶段通知时沿用原计数；正式工具在参数/版式检查后、渲染前通知。
      if (!tool.posterLifecycle) beginPosterAttempt();
      const call = ++task.calls, historyPrefix = `.workflows/posters/${task.id}/`;
      const filename = [...String(input.title || '海报').replace(/[\\/:*?"<>|\s\u0000-\u001f]+/g, '')].slice(0, 50).join('') || '海报';
      task.rich ||= Boolean(options.requiresRichVisual || wantsIllustratedPoster(options.rawRequestText || options.requestText));
      const rich = task.rich;
      const silent = { ...ctx, onImage: undefined, onFileChanged: undefined };
      let receipt;
      try {
        const output = await factory(silent).run({ ...input, path: `${historyPrefix}attempt-${call}/${filename}.png` }, {
          ...options, posterInternal: true, posterAttempt: true, requiresRichVisual: rich, beginPosterAttempt, checkpoint: undefined,
          // 设计自审最多两轮：第1、2次试排不达标会要求再排，第3次只提示
          designReviewBlocking: () => task.attempts < MAX_ATTEMPTS
        });
        receipt = JSON.parse(output);
      } catch (error) {
        throwControl(error, options.signal);
        receipt = { kind: 'poster', status: 'partial', files: [], errors: [{ phase: started ? 'render' : 'preflight', code: /^(?:DESIGN|POSTER|CANVAS)_[A-Z_]+$/.test(error.code || '') ? error.code : 'POSTER_INPUT_INVALID',
          message: String(error.message || '试排未通过').slice(0, 220) }] };
        if (Array.isArray(error.issues)) receipt.preflight = { status: 'failed', issueCount: error.issueCount,
          issues: error.issues, adjustments: error.adjustments || [] };
      }
      assertCurrent();
      if (!started && receipt.files?.some(f => f.format === 'png' && f.render === 'passed')) beginPosterAttempt();
      if (!started) task.corrections++;
      try { await preservePosterSource(input, receipt, task, options, assertCurrent); }
      catch (error) {
        throwControl(error, options.signal);
        assertCurrent();
        receipt.status = 'partial';
        (receipt.errors ||= []).push({ code: 'POSTER_SOURCE_ALIAS_FAILED', message: '指定路径的源稿未保存成功；内部源稿保留，不能称全部完成' });
      }
      let png = receipt.files?.find(f => f.format === 'png' && f.render === 'passed' && f.readback === 'passed');
      if (tool.posterLifecycle && png) {
        receipt.deliveryAccess = await verifyDeliveryAccess([png.path], options);
        const actual = receipt.deliveryAccess.files[0];
        if (receipt.deliveryAccess.status !== 'ready' || actual.width !== receipt.width || actual.height !== receipt.height) {
          receipt.status = 'partial';
          (receipt.errors ||= []).push({ code: 'POSTER_DELIVERY_UNAVAILABLE', phase: 'delivery', message: '最终PNG未能按当前账号读回或尺寸不匹配，不能称文件已交付' });
          png = undefined;
        }
      }
      const sources = [...(receipt.files || []).filter(f => f !== png).map(f => f.path), receipt.designPath].filter(Boolean);
      if (rich && !receipt.contentCheck) receipt.contentCheck = { status: 'not_checked', semantic: 'not_checked', basis: '当前路径未完成主题配图及图文融合复核，不能称图文并茂验收通过' };
      if (rich && (receipt.contentCheck.status !== 'passed' || receipt.contentCheck.semantic !== 'passed')) receipt.status = 'partial';
      receipt.delivery = { id: task.id, title: String(receipt.title || input.title || '海报').slice(0, 160), primaryPath: png?.path || null,
        sourceFiles: sources.slice(0, 8), sourceAliases: [...task.sourceAliases], historyPrefix, attempts: task.attempts, corrections: task.corrections,
        retryAllowed: task.attempts < MAX_ATTEMPTS && task.corrections < MAX_CORRECTIONS,
        quality: receipt.status === 'complete' ? 'complete' : 'needs_review' };
      receipt.guidance = '一次处理preflight.issues中的全部问题；若缺空间请重新构图，不删字/改小字/逐项盲试。不要换工具绕过预算，或让用户反复回继续。默认只展示delivery.primaryPath；技术通过不证明事实或审美，未通过项如实说明。';
      // 后续失败不能把已有可交付稿替换为空；仍向模型说明本次失败。
      if (png && (!task.last || receipt.status === 'complete' || task.last.status !== 'complete')) {
        // 历史稿只记“以前回合交付过的完整成品”（用户要求改稿前的那张）；同一轮里的试排、待核验的候选都不算（2026-11-17 用户：做海报为什么产出那么多历史稿）
        const replaced = task.carried && task.last?.status === 'complete' ? task.last.delivery?.primaryPath : null;
        task.carried = false;
        if (replaced && replaced !== png.path && !task.versions.includes(replaced)) task.versions = [...task.versions, replaced].slice(-8);
        receipt.delivery.previousVersions = [...task.versions];
        task.last = structuredClone(receipt);
        const blob = await ws.readBlob(png.path);
        assertCurrent();
        // 先索引后通知界面，避免刷新文件列表时主图还被归为隐藏过程文件。
        await recordWorkAttempt({ tool: tool.name || 'make_poster', args: input, output: JSON.stringify(receipt), ok: true,
          sessionId: options.sessionId, scope: options.executionScope, callId: 'poster-delivery' });
        try { await rememberDesignTask(options.sessionId, receipt, options.rawRequestText || options.requestText, options); }
        catch (error) { throwControl(error, options.signal); receipt.memoryNotice = '作品已保存，但续改索引未保存，不能声称跨重启续接已记录。'; }
        assertCurrent();
        ctx.onFileChanged?.(png.path);
        ctx.onImage?.(URL.createObjectURL(blob), png.path);
      } else if (task.last) {
        receipt.delivery = { ...task.last.delivery, previousVersions: [...task.versions], sourceAliases: [...task.sourceAliases], attempts: task.attempts, corrections: task.corrections,
          retryAllowed: task.attempts < MAX_ATTEMPTS && task.corrections < MAX_CORRECTIONS };
        receipt.previousDelivery = '本次试排未替换上一份成品，当前展示仍为上一稿；不能称本次修改成功';
      }
      await options.checkpoint?.({ type: 'artifact_validation', path: receipt.delivery.primaryPath || `${historyPrefix}attempt-${call}/成品.png`,
        validation: { kind: 'poster', format: 'png', readback: png ? 'passed' : 'failed', render: png ? 'passed' : 'failed', visual: receipt.visual || 'not_checked', business: 'not_checked', errors: receipt.errors?.length || (receipt.status === 'partial' ? 1 : 0) } });
      const result = JSON.stringify(receipt);
      task.signatures.set(signature, result);
      return result;
    };
    const next = task.tail.catch(() => {}).then(job);
    task.tail = next;
    return next;
  } };
}
