/**
 * 多助手分工（团队模式）：复杂任务交给一个小团队，而不是一个助手从头干到尾。
 *
 *   规划员  把任务拆成 2-6 步，每步指定一个角色
 *   执行    每个角色只拿到和自己职责相关的工具（工具少，选错的机会就少），带着前面步骤的结果干活
 *   审核员  对照原始需求检查成果；不合格就把问题交回对应角色返工一次
 *   汇总    把各步成果整理成给用户的最终回答
 *
 * 参考 CrewAI / MetaGPT 的角色分工与 AutoGen 的“执行—审核”循环，但保持简单：顺序执行、最多返工一次。
 * 没有接入大模型（内置演示）时：按“然后 / 再 / 最后”等连接词拆步，跳过审核，直接拼接各步结果。
 */
import { runAgent } from './agent.js';
import { parseJson } from './research.js';

export const ROLES = {
  researcher: { name: '研究员', duty: '查资料：联网搜索、深度调研、读网页和知识库，给出有出处的事实与数据，不负责写最终成品', tools: /^(web_search|deep_research|fetch_url|kb_search|recall|read_file|list_files|mcp_)/ },
  coder: { name: '工程师', duty: '写代码、做网页和小工具，写完必须运行或打开预览验证', tools: /^(write_file|read_file|list_files|run_javascript|run_python|preview|use_skill|read_skill_file|computer_|mcp_)/ },
  writer: { name: '撰稿人', duty: '写文档、报告、PPT、邮件：结论先行、结构清晰，用前面步骤给出的事实，不编造', tools: /^(create_document|write_file|read_file|list_files|kb_search|recall|preview|use_skill|read_skill_file)/ },
  analyst: { name: '分析师', duty: '数据分析：读表格、计算、统计、出图表，所有数字都要来自实际计算', tools: /^(run_python|run_javascript|read_file|list_files|write_file|create_document|preview)/ },
  operator: { name: '操作员', duty: '操作电脑：整理文件、运行命令、打开应用、截屏', tools: /^(computer_|clipboard_|mcp_|read_file|write_file|list_files)/ },
  generalist: { name: '助理', duty: '处理不属于其他角色的事情', tools: /./ }
};
const ALWAYS = /^(get_current_time|remember|core_memory_update|get_local_metrics)$/;
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

export const toolsFor = (role, tools) => tools.filter((t) => (ROLES[role] ?? ROLES.generalist).tools.test(t.name) || ALWAYS.test(t.name));

/** 自动模式下要不要组团：明说了要分工，或者一句话里有多个先后步骤 */
export function shouldTeam(text, mode = 'auto') {
  const t = String(text || '');
  if (/^\/团队\s/.test(t)) return true;
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (/(团队|分工|多个助手)(来|帮|完成|协作)/.test(t)) return true;
  const links = (t.match(/然后|接着|之后再|再把|再用|并且|最后|；|\n\s*\d+[.、)]/g) ?? []).length;
  return t.length >= 30 && links >= 2;
}

export const stripTeamPrefix = (t) => String(t).replace(/^\/团队\s+/, '');

function guessRole(text) {
  if (/调研|搜索|查一下|查找|资料|新闻|最新/.test(text)) return 'researcher';
  if (/表格|数据|统计|分析|图表|excel|csv/i.test(text)) return 'analyst';
  if (/网页|页面|代码|程序|脚本|html|游戏|小工具/i.test(text)) return 'coder';
  if (/文档|报告|ppt|word|pdf|邮件|总结|周报|文章/i.test(text)) return 'writer';
  if (/桌面|文件夹|运行命令|打开|截屏|截图/.test(text)) return 'operator';
  return 'generalist';
}

/** 没有大模型时的拆步：按连接词切开 */
export function ruleBasedPlan(task) {
  const parts = stripTeamPrefix(task)
    .split(/然后|接着|之后再|最后|并且|；|;|\n\s*\d+[.、)]\s*|\n/)
    .map((s) => s.replace(/^[，,。、\s再]+|[，,。\s]+$/g, '').trim())
    .filter((s) => s.length >= 2);
  const steps = (parts.length ? parts : [task]).slice(0, 6);
  return steps.map((s, i) => ({ id: i + 1, role: guessRole(s), title: clip(s, 24), detail: s }));
}

/**
 * @param {object} o  与 runAgent 相同的参数，另加：
 * @param {((p: { system, prompt, signal? }) => Promise<string>) | null} o.llm  规划 / 审核用；null 时用规则
 * @param {Function} [o.run]  执行单步（测试可替换），默认 runAgent
 * @param {(role: string) => ({ adapter, model } | null)} [o.pickModel]  按角色换模型
 * emit 额外事件：
 *   { type: 'team_plan', steps: [{ id, role, roleName, title, detail }] }
 *   { type: 'team_step', index, status: 'running'|'done'|'fail'|'redo', note? }
 *   { type: 'team_review', pass, issues: string[], skipped? }
 */
export async function runTeam({ adapter, model, history = [], userText, images = [], tools, emit, signal, approve, llm = null, run = runAgent, maxFix = 1, sessionId = null, pickModel = null, summary: earlier = null }) {
  const task = stripTeamPrefix(userText);
  const roleList = Object.entries(ROLES).map(([id, r]) => `${id}（${r.name}）：${r.duty}`).join('\n');
  emit({ type: 'state', value: 'processing' });

  // ---------- 1. 规划
  let steps = null;
  if (llm) {
    try {
      const j = parseJson(await llm({
        signal,
        system: '你是团队的规划员，把用户的任务拆成按顺序执行的步骤，分配给合适的角色。只输出 JSON。',
        prompt: `可用角色：\n${roleList}\n\n最近的对话：\n${history.slice(-4).map((m) => `${m.role === 'user' ? '用户' : '未央'}：${clip(m.content, 200)}`).join('\n') || '（无）'}\n\n任务：${task}\n\n输出 JSON：{"steps":[{"role":"角色 id","title":"这一步做什么（不超过 16 字）","detail":"给执行者的具体要求：要产出什么、存到哪里、注意什么"}]}。2-6 步；能一步完成的不要硬拆；最后一步的产出就是用户要的成品。`
      }));
      if (Array.isArray(j?.steps) && j.steps.length) {
        steps = j.steps.slice(0, 6).map((s, i) => ({ id: i + 1, role: ROLES[s.role] ? s.role : 'generalist', title: clip(s.title || s.detail || `步骤 ${i + 1}`, 24), detail: String(s.detail || s.title || task) }));
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }
  steps ??= ruleBasedPlan(task);
  steps.forEach((s) => { s.roleName = ROLES[s.role].name; });
  emit({ type: 'team_plan', steps: steps.map((s) => ({ ...s })) });

  // ---------- 2. 逐步执行
  const results = [];
  let toolCalls = 0;
  const forward = (e) => { if (e.type !== 'text' && e.type !== 'sources' && !(e.type === 'state' && e.value === 'done')) emit(e); };
  const doStep = async (s, index, extra = '') => {
    emit({ type: 'team_step', index, status: 'running' });
    const prior = results.filter(Boolean).map((r) => `【第 ${r.id} 步 · ${r.roleName}：${r.title}】\n${clip(r.text, 1500)}`).join('\n\n');
    // 模型分工：工程师用编程模型、撰稿人用写作模型……（没配置时都用同一个模型）
    const m = pickModel?.(s.role) ?? { adapter, model };
    const r = await run({
      adapter: m.adapter, model: m.model, history, signal, approve, sessionId, summary: earlier, // 长对话的前情提要
      images: index === 0 ? images : [],
      tools: toolsFor(s.role, tools),
      userText: `${s.detail}\n\n——\n【团队分工】你是团队里的「${s.roleName}」（职责：${ROLES[s.role].duty}），负责整个任务的第 ${index + 1}/${steps.length} 步。\n用户的原始需求：${task}\n${prior ? `前面步骤的成果：\n${prior}\n` : ''}${extra}只完成你这一步，完成后用几句话说明产出了什么（文件路径、关键数据、结论）。`,
      emit: forward
    });
    toolCalls += r.toolCalls ?? 0;
    return { id: s.id, role: s.role, roleName: s.roleName, title: s.title, text: r.text || '（完成）' };
  };
  for (const [i, s] of steps.entries()) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    try {
      results[i] = await doStep(s, i);
      emit({ type: 'team_step', index: i, status: 'done', note: results[i].text });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      results[i] = { id: s.id, role: s.role, roleName: s.roleName, title: s.title, text: `失败：${e.message}` };
      emit({ type: 'team_step', index: i, status: 'fail', note: e.message });
    }
  }

  // ---------- 3. 审核（最多返工 maxFix 次）
  const summary = () => results.map((r) => `【第 ${r.id} 步 · ${r.roleName}：${r.title}】\n${clip(r.text, 2000)}`).join('\n\n');
  if (llm) {
    for (let round = 0; round <= maxFix; round++) {
      emit({ type: 'state', value: 'processing' });
      let review = null;
      try {
        review = parseJson(await llm({
          signal,
          system: '你是团队的审核员，严格对照用户的原始需求检查成果：有没有漏做、做错、编造、没验证。只输出 JSON。',
          prompt: `用户需求：${task}\n\n各步成果：\n${summary()}\n\n输出 JSON：{"pass":true/false,"issues":["具体问题，没有则为空"],"fix_step":需要返工的步骤编号（从 1 开始；pass 为 true 时为 0）}`
        }));
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
      if (!review) { emit({ type: 'team_review', pass: true, issues: [], skipped: true }); break; }
      const issues = (review.issues ?? []).map(String).filter(Boolean);
      const pass = review.pass !== false || !issues.length;
      emit({ type: 'team_review', pass, issues, final: pass || round === maxFix });
      if (pass || round === maxFix) break;
      const idx = Math.min(steps.length, Math.max(1, Number(review.fix_step) || steps.length)) - 1;
      emit({ type: 'team_step', index: idx, status: 'redo', note: issues.join('；') });
      try {
        results[idx] = await doStep(steps[idx], idx, `审核员指出的问题（这次要改好）：\n${issues.map((x) => `- ${x}`).join('\n')}\n`);
        emit({ type: 'team_step', index: idx, status: 'done', note: results[idx].text });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        emit({ type: 'team_step', index: idx, status: 'fail', note: e.message });
      }
    }
  } else {
    emit({ type: 'team_review', pass: true, issues: [], skipped: true });
  }

  // ---------- 4. 汇总
  emit({ type: 'state', value: 'listening' });
  let text = '';
  if (llm) {
    let streamed = '';
    try {
      const r = await adapter.stream({
        model, signal, tools: [],
        system: ['你是“未央”，刚带领一个小团队完成了用户的任务。用中文直接给用户最终答复：先给结论或成品位置（文件路径），再简要说明每一步做了什么、需要用户注意或确认的地方。不要编造各步成果里没有的内容。不要输出 <emotion> 标签。', ''],
        messages: [{ role: 'user', content: `用户需求：${task}\n\n团队各步成果：\n${summary()}` }],
        onText: (d) => { streamed += d; emit({ type: 'text', delta: d }); }
      });
      text = r?.text || streamed;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      text = '';
    }
  }
  if (!text) {
    text = `团队完成了 ${steps.length} 步：\n\n${results.map((r) => `**${r.id}. ${r.roleName} · ${r.title}**\n${r.text}`).join('\n\n')}`;
    emit({ type: 'text', delta: text });
  }
  emit({ type: 'state', value: 'done' });
  return { text, toolCalls, steps: steps.length, team: results };
}
