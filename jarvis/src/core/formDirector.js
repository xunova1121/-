/**
 * 造型导演：决定粒子体此刻该是什么样子。用户不需要手动切换。
 *
 *   优先级：警觉（出错）> 正在用的工具 > 这句话的意思 > 工作状态 > 空闲时随机漫游
 *   - 工具：联网 → 地球 / 星系；写代码 → 晶格；写文档 → 文档；记忆 / 知识库 / 历史对话 → 记忆星座；
 *           定时 / 时间 → 时钟；看屏幕 / 操作电脑 → 观察之眼；团队分工 → 团队
 *   - 语义：用户的话里提到“代码 / 网页”“调研 / 搜索”“报告 / PPT”“记得 / 上次”“提醒 / 每天”……
 *     思考阶段就先变成对应的样子
 *   - 状态：思考 → 思考螺旋；语音聆听 → 聆听环；说话 → 光核（有脸，对着你说）
 *   - 空闲 30–60 秒后在光核、星云、聆听环、星系之间随机漫游；有人互动立刻回到光核
 *   - 每个造型至少停留 1.6 秒，避免闪来闪去；同类可选造型随机挑一个，不会每次都一样
 */
const TOOL_FORMS = [
  [/^(deep_research)$/, ['galaxy', 'globe']],
  [/^(web_search|fetch_url)$/, ['globe', 'globe', 'galaxy']],
  [/^(write_file|run_javascript|run_python|preview|read_skill_file|code_edit|code_write|code_run)$/, ['lattice']],
  [/^(create_document)$/, ['pages']],
  [/^(remember|recall|forget|core_memory_update|kb_search|search_conversations|read_conversation|save_skill|use_skill)$/, ['constellation']],
  [/^(schedule_task|list_schedules|update_schedule|cancel_schedule|get_current_time)$/, ['clock']],
  [/^computer_(look|click|type|key|scroll|drag|screenshot)$/, ['eye']],
  [/^(computer_|clipboard_)/, ['lattice', 'eye']],
  [/^(read_file|list_files)$/, ['pages', 'lattice']],
  [/^mcp_/, ['lattice', 'constellation']]
];

const SEMANTIC = [
  [/代码|编程|程序|网页|页面|网站|脚本|html|css|javascript|python|bug|报错|函数/i, ['lattice']],
  [/调研|研究|搜索|搜一下|查一下|新闻|最新|资料|网上|联网/, ['galaxy', 'globe']],
  [/报告|文档|ppt|幻灯|word|周报|总结|写一篇|文章|简历|邮件|合同/i, ['pages']],
  [/记得|记住|上次|之前|回忆|知识库|忘记/, ['constellation']],
  [/提醒|每天|每周|定时|闹钟|几点|日程|明天|时间/, ['clock']],
  [/屏幕|截图|截屏|点击|鼠标|桌面|打开.*软件/, ['eye']],
  [/团队|分工|一起完成/, ['swarm']]
];

export const IDLE_FORMS = ['core', 'nebula', 'rings', 'galaxy'];
const MIN_HOLD = 1600;

export function formForTool(name, rand = Math.random) {
  for (const [re, forms] of TOOL_FORMS) if (re.test(name)) return forms[Math.floor(rand() * forms.length)];
  return 'helix';
}

export function formForText(text, rand = Math.random) {
  for (const [re, forms] of SEMANTIC) if (re.test(String(text || ''))) return forms[Math.floor(rand() * forms.length)];
  return null;
}

/**
 * @param {{ setForm: (name: string) => boolean }} target  舞台（或测试替身）
 * @param {{ now?: () => number, rand?: () => number }} [o]
 */
export function createFormDirector(target, { now = () => performance.now(), rand = Math.random } = {}) {
  let current = 'core';
  let since = 0;
  let pending = null;
  let topic = null; // 这句话的语义造型
  let state = 'idle';
  let tool = null;
  let alertUntil = 0;
  let idleSince = now();
  let nextWander = idleSince + 30000 + rand() * 30000;
  let affection = 0;
  const history = [];

  function want() {
    const t = now();
    if (t < alertUntil) return 'spike';
    if (tool) return tool;
    if (state === 'processing') return topic ?? 'helix';
    if (affection > t) return 'heart'; // 比心只在不干活的时候
    if (state === 'voice') return 'rings';
    if (state === 'speaking' || state === 'listening') return 'core';
    return null; // 空闲：保持当前（漫游由 tick 决定）
  }

  function go(name) {
    if (!name || name === current) return; // 排着的造型保留（例如一闪而过的工具造型稍后仍会展示）
    const t = now();
    // 还没停够：先记下。已经排着一个工具 / 语义造型时，不让“回到光核”把它顶掉（它稍后会自然回到光核）
    if (t - since < MIN_HOLD) { if (!(pending && pending !== 'core' && name === 'core')) pending = name; return; }
    if (target.setForm(name) !== false) { current = name; since = t; history.push(name); if (history.length > 30) history.shift(); }
    pending = null;
  }

  const api = {
    get form() { return current; },
    /** 最近变过的造型（调试 / 测试用） */
    history,
    /** 用户说了一句话：记下语义，思考阶段就变成对应的样子 */
    onUserText(text) {
      topic = formForText(text, rand);
      idleSince = now();
    },
    /** 工作状态：idle / listening（打字、看着用户）/ voice（语音聆听）/ processing / speaking / error */
    setState(next) {
      if (next === 'error') { alertUntil = now() + 2500; go('spike'); return; }
      state = next;
      if (next !== 'processing') tool = null;
      if (next === 'idle') { topic = null; idleSince = now(); nextWander = idleSince + 30000 + rand() * 30000; go('core'); return; }
      go(want());
    },
    onToolStart(name) { tool = formForTool(name, rand); go(tool); },
    onToolEnd() { /* 保持工具造型，直到下一个工具或回答开始，避免来回闪 */ },
    /** 表达风格变化：愉悦 / 亲和时偶尔比个心，警觉时竖起尖刺 */
    onEmotion(e) {
      if (e === '警觉') { alertUntil = now() + 2000; go('spike'); }
      else if ((e === '愉悦' || e === '亲和') && state === 'idle' && rand() < 0.25) { affection = now() + 2600; go('heart'); }
    },
    /** 每帧或每隔一会儿调用：处理被“最短停留”推迟的变形、警觉结束、空闲漫游 */
    tick() {
      const t = now();
      if (pending) { go(pending); return; }
      const w = want();
      if (w && w !== current) { go(w); return; }
      if (!w && state === 'idle') {
        if ((current === 'spike' || current === 'heart') && t >= alertUntil && t >= affection) { go('core'); return; }
        if (t >= nextWander) {
          const choices = IDLE_FORMS.filter((f) => f !== current);
          go(choices[Math.floor(rand() * choices.length)]);
          nextWander = t + 25000 + rand() * 35000;
        }
      }
    },
    /** 用户有动静（移动鼠标、打字）：空闲漫游中的话回到光核看着他 */
    poke() {
      idleSince = now();
      if (state === 'idle' && current !== 'core' && now() >= alertUntil) { go('core'); nextWander = now() + 30000 + rand() * 30000; }
    }
  };
  return api;
}
