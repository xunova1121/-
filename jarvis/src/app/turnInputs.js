/** 一轮输入整理及模型线路选择；图片缓存仍只保留最近两条消息，不落盘。 */
import { MOBILE } from '../config.js';
import { followsImage } from '../core/imageFollowup.js';
import { createAdapter } from '../llm/config.js';
import { classifyTask, routeFor, TASKS, effortFor, computerTaskKind } from '../llm/router.js';
import { shouldTeam } from '../agent/team.js';
import * as skillPacks from '../agent/skillPacks.js';
import * as compress from '../agent/compress.js';
import { createPCModelAdapter } from '../core/pcModelClient.js';
import { isAuto } from '../ui/modelPicker.js';
import { $, DESKTOP, COMPACT } from './env.js';

export function createTurnInputs(app) {
  const recentImages = new Map(); // 消息时间 → 最近两条带图消息，仅内存。
  /** 整理这一轮的输入：取走附件、显示并记下这句话、挑出要带给模型的历史和图片 */
  function takeInput(text, echo) {
    // 持续聊天也保持有界；先重画已完成的历史，再追加本轮，避免重复消息。
    if (MOBILE && (app.historyViewEnd !== null || $('#transcript').querySelectorAll('.msg').length >= app.visibleHistory().limit)) app.replayTranscript();
    const files = app.attachments.splice(0);
    app.renderAttachments();
    const userText = files.length ? `${text}\n\n[已上传到工作区：${files.map((f) => f.path).join('、')}]` : text;
    const imgs = files.filter((f) => f.image).map((f) => f.image);
    const thumbs = files.filter((f) => f.image).map((f) => ({ src: f.image.thumb, path: f.path }));
    if (echo) app.transcript.add('user', userText, Date.now(), { thumbs }); // echo=false：这句话之前已经显示并记下了
    app.director.onUserText(text);
    app.hud.newTurn();
    app.hud.think(`◂ 收到：${text.slice(0, 30)}`);
    // 之前发过的图片（最近两条带图的消息）继续带给模型：追问“第二张图里……”时模型还看得到
    // 只在这句话提到图片时才带（不然后面每句闲聊都会被当成看图任务、多花流量）
    const refersToImage = !imgs.length && followsImage(text, app.history, recentImages);
    // 长对话：已压缩进摘要的消息不再原样发送，其余（至少最近 20 条）原样发送，见 compress.js
    const recent = compress.unsummarized(app.history, app.session.summary);
    const withImages = new Set(
      refersToImage
        ? recent
            .filter((m) => m.role === 'user' && recentImages.has(m.ts))
            .slice(-2)
            .map((m) => m.ts)
        : []
    );
    const llmHistory = recent.map(({ role, content, ts }) => ({ role, content, ...(withImages.has(ts) && { images: recentImages.get(ts) }) }));
    if (echo) app.rememberTurn('user', userText, thumbs.length ? { thumbs } : {});
    if (imgs.length) {
      recentImages.set(
        app.history.at(-1).ts,
        imgs.map(({ mime, data }) => ({ mime, data }))
      );
      while (recentImages.size > 2) recentImages.delete(recentImages.keys().next().value);
    }
    return { files, userText, imgs, withImages, llmHistory };
  }

  /** 这一轮用哪个模型：按这句话的类型分工；服务器模式下动这台电脑的事留在本机做 */
  function chooseModel(text, turn, st, { imgs, withImages }) {
    // 模型分工：按这句话的类型换模型；日常对话让推理模型少想一点（首字更快）
    const computerKind = DESKTOP
      ? computerTaskKind(text, {
          history: app.history,
          serverRepositories: Boolean(app.server),
          codeTaskKnown: Boolean(app.session?.taskCheckpoint?.codeTaskId)
        })
      : null;
    const task =
      computerKind === 'gui'
        ? 'vision'
        : shouldTeam(text, app.settings.teamMode === 'auto' && !app.helperLlm() ? 'off' : app.settings.teamMode)
          ? 'reason'
          : classifyTask(text, { images: imgs.length + withImages.size });
    const route = routeFor(app.llmConfig, task);
    const remotePC = Boolean(app.server && computerKind);
    const local = createAdapter(route.cfg, { gateway: app.gateway });
    const model = remotePC ? '服务器模型' : local.model;
    st.usedModel = model;
    const adapter = remotePC
      ? createPCModelAdapter(app.server, {
          task,
          onModel: (m) => {
            st.usedModel = m;
          }
        })
      : local.adapter;
    const problem = remotePC ? null : local.problem;
    if (COMPACT && isAuto(app.llmConfig) && model && !app.server) $('#model-chip-text').textContent = `自动 · ${model}`;
    // 日常闲聊少想一点（首字更快）；要查证、分析、算结果的不省
    const effort = effortFor(task, text, app.llmConfig);
    if (route.routed && !remotePC) app.hud.think(`◇ 模型分工：${TASKS[task].name} → ${route.model}`);
    // 服务器模式下电脑版：要动这台电脑的事（桌面、文件夹、打开软件……）留在本机做，其余交给服务器
    const here = Boolean(app.server && DESKTOP && computerKind);
    turn.remote = Boolean(app.server && !here);
    if (here) app.hud.think('◇ 服务器模型推理，电脑工具在本机执行');
    return { computerKind, task, route, remotePC, model, adapter, problem, effort, here };
  }

  /** “/技能名 内容” → 明确要求模型使用该技能（界面上仍显示用户原话） */
  async function expandSlash(text) {
    if (!text.startsWith('/')) return text;
    const names = (await skillPacks.enabled().catch(() => [])).map((p) => p.name);
    const m = skillPacks.matchSlash(text, names);
    return m ? `请使用技能「${m.name}」完成：${m.rest || '（用户没有补充内容，先说明这个技能能做什么并询问需要的材料）'}` : text;
  }

  return { recentImages, takeTurnInput: takeInput, chooseTurnModel: chooseModel, expandSlash };
}
