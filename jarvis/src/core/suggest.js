/**
 * 光核旁的“建议 1 / 2 / 3”：根据刚刚做完的事给出下一步。
 * 规则在本地即时算出（不额外调用大模型）；每条建议是一句可以直接发出的话，或一个打开面板的动作。
 *
 * @typedef {{ title: string, prompt?: string, panel?: string }} Suggestion
 */

/** 回答未完成时记在对话里的标记，以及“继续”按钮发出的话 */
export const INTERRUPTED_MARK = '（本轮回答未完成；具体原因请看错误提示）';
/**
 * 出错的种类：timeout 等太久 / api 模型接口报错 / network 连不上 / 空字符串 = 说不清。
 * 先看出错处打上的标记（状态码、错误名、错误码），只有纯文字的旧错误才按字面猜。
 */
const NET_CODES = /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/;
export function errorKind(error) {
  if (!error) return '';
  if (typeof error === 'object') {
    if (['timeout', 'api', 'network', 'budget'].includes(error.kind)) return error.kind;
    const code = String(error.code || error.cause?.code || '');
    if (code === 'RETRIEVAL_BUDGET') return 'budget';
    if (error.name === 'NetworkError' || code === 'NETWORK_ERROR') return 'network';
    if (error.stalled || error.name === 'TimeoutError' || error.name === 'LookupTimeoutError' || code === 'LOOKUP_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
    if (Number.isInteger(error.status) && error.status >= 400) return 'api';
    if (NET_CODES.test(code) || error.name === 'TypeError' && /fetch|network|load failed/i.test(String(error.message))) return 'network';
  }
  const message = String(error?.message || error || '');
  // 顺序有讲究：“连接超时”算超时；带 api.xxx.com 网址的断线算连不上，不算接口报错
  if (/LOOKUP_TIMEOUT|超时|时间预算|等待 \d+ 秒|没有任何输出|timed? ?out/i.test(message)) return 'timeout';
  if (/模型接口|模型服务|返回 [45]\d\d|reasoning_content/.test(message)) return 'api';
  if (/network|网络|failed to fetch|fetch failed|load failed|连接|socket|econn/i.test(message)) return 'network';
  return '';
}
const KIND_TEXT = { timeout: '等待超时', api: '模型接口出错', network: '连接异常', budget: '本轮检索预算已用完' };
export function interruptionMark(error) {
  return `（本轮回答未完成：${KIND_TEXT[errorKind(error)] || '执行出错'}。已保留可恢复的内容。）`;
}
export const CONTINUE_TEXT = '继续：从刚才中断的地方接着做，已经写好、做好的部分不要重复';

/** 开场（还没对话）时的建议 */
export function openingSuggestions({ desktop = false, hour = new Date().getHours(), hasSkills = false, resume = null } = {}) {
  const base = baseOpening({ desktop, hour, hasSkills });
  // 跨对话：有没做完的事或上次的对话时，第一条建议就是“接着做”
  return resume ? [resume, ...base.slice(0, 2)] : base;
}

function baseOpening({ desktop, hour, hasSkills }) {
  const plan = hour < 11 ? { title: '帮我规划今天的工作', prompt: '帮我把今天要做的事排个优先级，列成清单' }
    : hour < 18 ? { title: '帮我写一份工作周报', prompt: '帮我写一份本周工作周报' }
      : { title: '总结今天，安排明天', prompt: '帮我总结今天做了什么，并列出明天的计划' };
  if (desktop) {
    return [
      { title: '看看桌面上有什么文件', prompt: '列出桌面' },
      plan,
      { title: '写一个实时时钟网页', prompt: '帮我写一个网页' }
    ];
  }
  return [
    plan,
    { title: '写一个实时时钟网页', prompt: '帮我写一个网页' },
    hasSkills ? { title: '看看装了哪些技能', panel: 'skills' } : { title: '给我装一个新技能', panel: 'skills' }
  ];
}

/**
 * 一轮对话结束后的建议
 * @param {{ tools: string[], userText: string, error?: boolean, resumable?: boolean, desktop?: boolean }} o
 * @returns {Suggestion[]}
 */
export function followUpSuggestions({ tools = [], userText = '', error = false, resumable = false, desktop = false }) {
  if (error && resumable) {
    return [
      { title: '继续', prompt: CONTINUE_TEXT },
      { title: '从头再试一次', prompt: userText || '再试一次' },
      { title: '检查模型设置', panel: 'models' }
    ];
  }
  if (error) {
    return [
      { title: '再试一次', prompt: userText || '再试一次' },
      { title: '换个说法问', prompt: `换一种方式完成：${userText}`.slice(0, 120) },
      { title: '检查模型设置', panel: 'models' }
    ];
  }
  const has = (name) => tools.includes(name);
  const any = (re) => tools.some((t) => re.test(t));
  const save = desktop ? { title: '保存到桌面', prompt: '把刚才生成的文件保存到桌面' } : { title: '在工作区里打开', panel: 'workspace' };

  if (has('preview') || (has('write_file') && /网页|页面|html|游戏/i.test(userText))) {
    return [
      { title: '改成暗色科幻风格', prompt: '把这个网页改成暗色科幻风格，加一点发光效果' },
      { title: '再加一个新功能', prompt: '给这个网页再加一个实用的小功能，并说明加了什么' },
      save
    ];
  }
  if (has('create_document')) {
    if (/ppt|幻灯片|演示/i.test(userText)) {
      return [
        { title: '每页加上演讲备注', prompt: '给这个 PPT 每一页写一段演讲备注' },
        { title: '再出一版 Word 讲稿', prompt: '根据这个 PPT 写一份 Word 讲稿' },
        save
      ];
    }
    if (/excel|xlsx|表格/i.test(userText)) {
      return [
        { title: '分析出关键结论', prompt: '分析这份表格，给出三条最重要的结论' },
        { title: '做成图表网页', prompt: '把这份表格的数据做成一个图表网页并预览' },
        save
      ];
    }
    return [
      { title: '改得更正式一些', prompt: '把这份文档的语气改得更正式、更简洁' },
      { title: '做成一页 PPT', prompt: '把这份文档的要点做成一个 PPT' },
      save
    ];
  }
  if (has('kb_search')) {
    return [
      { title: '总结资料的要点', prompt: '根据知识库，总结这份资料的要点' },
      { title: '列出关键数字', prompt: '根据知识库，列出资料里所有关键数字和日期' },
      { title: '据此写一份汇报', prompt: '根据知识库里的资料，写一份汇报 Word' }
    ];
  }
  if (has('remember') || has('recall')) {
    return [
      { title: '你都记得我什么？', prompt: '你都记得关于我的哪些事？' },
      { title: '查看记忆与进化', panel: 'mind' },
      { title: '按我的习惯推荐技能', panel: 'skills' }
    ];
  }
  if (has('run_javascript') || has('run_python')) {
    return [
      { title: '解释这段代码', prompt: '逐行解释一下刚才运行的代码' },
      { title: '改写成 Python', prompt: '把刚才的代码改写成 Python 并运行' },
      { title: '加上测试用例', prompt: '给刚才的代码写几个测试用例并运行' }
    ];
  }
  if (has('computer_list_dir') || has('computer_search')) {
    return [
      { title: '按类型整理这些文件', prompt: '把这些文件按类型分到不同的文件夹里，先告诉我打算怎么分' },
      { title: '找出最大的文件', prompt: '找出这个文件夹里最大的几个文件' },
      { title: '总结其中的文档', prompt: '读一下其中的文档，分别用一句话总结' }
    ];
  }
  if (has('computer_run')) {
    return [
      { title: '解释这个结果', prompt: '解释一下刚才命令的输出是什么意思' },
      { title: '保存结果到桌面', prompt: '把刚才命令的输出保存成文本文件放到桌面' },
      { title: '查看电脑状态', prompt: '看看这台电脑现在的 CPU、内存占用情况' }
    ];
  }
  if (any(/^mcp_/)) {
    return [
      { title: '整理成表格', prompt: '把刚才工具返回的结果整理成表格' },
      { title: '保存结果', prompt: '把刚才的结果写入工作区的一个 Markdown 文件' },
      { title: '管理 MCP 工具', panel: 'skills' }
    ];
  }
  if (has('use_skill')) {
    return [
      { title: '按这个技能再做一份', prompt: '用同一个技能再做一份，换一个主题' },
      { title: '调整这个技能的做法', prompt: '这个技能的做法有哪里可以改进？' },
      { title: '看看其他技能', panel: 'skills' }
    ];
  }
  return [
    { title: '展开讲讲', prompt: '再展开讲讲，举个例子' },
    { title: '整理成要点', prompt: '把刚才的内容整理成几条要点' },
    { title: '做成 Word 文档', prompt: '把刚才的内容整理成一份 Word 文档' }
  ];
}

/**
 * 三条标注的位置（相对舞台左上角，CSS 像素）。宽屏：右上、右下、左侧，从光核向外伸出；
 * 窄屏放不下时，三条排在舞台底部一行，虚线从光核向下散开。
 * @returns {{ mode: 'wide'|'row', boxes: Array<{ x: number, y: number, w: number, side: 'left'|'right'|'top' }> }}
 */
export function calloutLayout({ width, height, orb, boxW = 210, boxH = 46 }) {
  const gap = Math.max(48, orb.r * 1.1);
  const fitsWide = orb.x + orb.r + gap + boxW < width - 12 && orb.x - orb.r - gap - boxW > 12 && height >= 220;
  if (fitsWide) {
    const clampY = (y) => Math.max(56, Math.min(height - boxH - 64, y));
    return {
      mode: 'wide',
      boxes: [
        { x: orb.x + orb.r + gap, y: clampY(orb.y - orb.r - boxH * 0.6), w: boxW, side: 'left' },
        { x: orb.x + orb.r + gap * 1.25, y: clampY(orb.y + orb.r * 0.55), w: boxW, side: 'left' },
        { x: orb.x - orb.r - gap - boxW, y: clampY(orb.y + orb.r * 0.1), w: boxW, side: 'right' }
      ]
    };
  }
  const w = Math.min(boxW, (width - 16 * 2 - 8 * 2) / 3);
  const y = height - 50 - 10;
  const total = w * 3 + 16;
  const x0 = (width - total) / 2;
  return { mode: 'row', boxes: [0, 1, 2].map((i) => ({ x: x0 + i * (w + 8), y, w, side: 'top' })) };
}

