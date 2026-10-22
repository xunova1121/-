import { deepseekSearchOptions } from '../agent/deepseekSearch.js';
/**
 * 智能体能用的工具：基础工具（文件、联网、文档……）+ 桌面版的电脑操作（鼠标键盘）+ MCP 连接的外部工具。
 * 也管桌面版的全局热键（呼出、紧急停止）和“本次都允许”的确认记录。
 */
import { createTools } from '../agent/tools.js';
import { createDesktopTools } from '../agent/desktopTools.js';
import * as mcp from '../agent/mcpClient.js';
import { generateImage } from '../llm/images.js';
import { generateVideo } from '../llm/videos.js';
import { createDocumentReviewer } from '../llm/documentReviewer.js';
import { createAdapter } from '../llm/config.js';
import { createHelperLlm } from '../llm/helper.js';
import { $, body, DESKTOP, COMPACT, toast } from './env.js';
import { ocrLine, recognizeText } from '../llm/ocr.js';

export function createToolbox(app) {
  /** 本次会话里用户选了“本次都允许”的操作类别 */
  const sessionApprovals = new Set();
  /** 电脑操作（鼠标键盘）进行中：一轮结束或被打断时把未央窗口放回来 */
  let controlActive = false;
  function endControl() {
    if (!controlActive) return;
    controlActive = false;
    DESKTOP?.invoke('controlEnd').catch(() => {});
  }
  if (DESKTOP) {
    body.classList.add('desktop', `os-${DESKTOP.platform}`);
    // 全局快捷键呼出：聚焦输入框
    DESKTOP.onSummon?.(() => {
      $('#prompt').focus();
    });
    // 离开电脑一段时间后回来：主动问好
    DESKTOP.onPresence?.((info) => {
      app.greetOnReturn(info);
    });
    // 紧急停止热键：打断当前任务
    DESKTOP.onStop?.(() => {
      controlActive = false;
      app.interrupt();
      toast('已紧急停止电脑操作');
    });
  }
  let mcpState = { available: false, servers: [] };
  async function refreshMcp() {
    if (!app.gateway?.mcp) {
      mcpState = { available: false, servers: [] };
      return mcpState;
    }
    try {
      mcpState = await mcp.listServers(app.gateway.origin);
    } catch {
      mcpState = { available: false, servers: [] };
    }
    return mcpState;
  }
  async function loadMcpTools() {
    if (!app.gateway?.mcp) return [];
    await refreshMcp();
    return mcp.mcpTools(app.gateway.origin, mcpState.servers);
  }

  /** 智能体可用的全部工具：基础工具 + 桌面版电脑操作 + MCP 工具 */
  async function buildTools({ background = false, turn = null } = {}) {
    // 生成的文件、图片只挂到产生它的那一轮（turn）：中途切到别的对话，也不会跑到别的对话里
    const out = () => turn?.bubble ?? app.liveBubble;
    const onFileChanged = (path) => {
      app.panels.markFresh(path);
      app.panels.refreshFiles();
      if (!background && !/^skills\//.test(path)) {
        out()?.fileLink?.(path, app.openInWorkspace);
        turn?.files.add(path);
      }
    };
    return [
      ...createTools({
        metrics: app.metrics,
        ...deepseekSearchOptions(app.llmConfig),
        tavilyKey: app.llmConfig.tavilyKey,
        falKey: app.llmConfig.falKey,
        bochaKey: app.llmConfig.bochaKey,
        searchRegion: app.llmConfig.searchRegion || 'auto',
        fetchViaGateway: app.fetchViaGateway(),
        llm: app.helperLlm('write'), // 深度调研：用写作模型
        reasonLlm: app.helperLlm('reason'), // 逐项查证：用推理模型摘答案
        documentReviewer: createDocumentReviewer(app.llmConfig, (cfg) => {
          const selected = createAdapter(cfg, { gateway: app.gateway });
          return selected.problem ? null : createHelperLlm(selected.adapter, selected.model);
        }),
        visionLlm: app.visionHelperLlm(), // PPT 生成后看预览图检查排版
        // 文字识别（能力表“文字识别”，智谱 GLM-OCR）；没有就不提供
        ocr: ocrLine(app.llmConfig) ? (file, o) => recognizeText(app.llmConfig, file, { ...o, gateway: app.gateway }) : null,
        onPreview: background
          ? () => {}
          : COMPACT
            ? (path) => {
                app.panels.openFile(path);
                toast(`已生成 ${path}：左上角菜单 → 工作区查看`);
              } // 手机上不自动盖住对话
            : (path) => {
                app.showPanel('workspace');
                app.panels.openFile(path);
              },
        onFileChanged,
        imageGen: (o) => generateImage(app.llmConfig, { ...o, gateway: app.gateway }),
        onImage: (src) => out()?.image?.(src),
        videoGen: (o) => generateVideo(app.llmConfig, { ...o, gateway: app.gateway }),
        onVideo: (src) => out()?.video?.(src),
        onAudio: (src) => out()?.audio?.(src),
        onSchedulesChanged: () => app.schedulesPanel?.refresh(),
        currentSessionId: () => app.session?.id,
        // 桌面版：写 PDF 时直接转成 PDF 文件（网页版和安卓生成可打印的网页）
        toPdf: DESKTOP ? async (html) => Uint8Array.from(atob((await DESKTOP.invoke('printToPdf', { html })).base64), (c) => c.charCodeAt(0)) : null
      }),
      ...(DESKTOP
        ? createDesktopTools(DESKTOP, {
            onFileChanged,
            onControlStart: (r) => {
              controlActive = true;
              if (!background) toast(`正在操作电脑：鼠标甩到屏幕左上角或按 ${r?.stopHotkey ?? 'Ctrl+Alt+Q'} 可紧急停止`);
            }
          })
        : []),
      ...(await loadMcpTools())
    ];
  }

  return {
    sessionApprovals,
    endControl,
    refreshMcp,
    buildTools,
    get controlActive() {
      return controlActive;
    }
  };
}
