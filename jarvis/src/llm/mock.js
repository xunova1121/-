/**
 * 内置离线演示模型：没有任何密钥也能体验完整的“智能体”流程 —— 它会像真模型一样
 * 调用工具（写网页、生成 Word / PPT / Excel、记住偏好、查知识库、运行代码），
 * 只是“思考”部分是按关键词写好的规则。接入真实大模型后自然会聪明得多。
 */
const sleep = (ms, signal) => new Promise((r, j) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

let seq = 0;
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const call = (name, args) => ({ id: `mock_${++seq}`, name, args });

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return { text: messages[i].content, index: i };
  return { text: '', index: -1 };
}

const DEMO_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>粒子时钟</title>
<style>html,body{margin:0;height:100%;background:#050b14;color:#cfe8ff;font-family:system-ui;display:grid;place-items:center}
#t{font:600 64px ui-monospace,monospace;letter-spacing:.08em;text-shadow:0 0 18px #38bdf8}
p{opacity:.6}</style></head>
<body><div><div id="t"></div><p>由贾维斯在工作区里编写并运行</p></div>
<script>const t=document.getElementById('t');setInterval(()=>t.textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false}),250);</script>
</body></html>`;

/** 根据最后一条用户消息与已有的工具结果决定下一步 */
export function plan(messages, tools = []) {
  const { text: q, index } = lastUserText(messages);
  const after = messages.slice(index + 1);
  const results = after.filter((m) => m.role === 'tool');
  const used = new Set(results.map((r) => r.name));
  const lastResult = results.at(-1);

  // —— 已经有工具结果：总结并结束
  if (results.length) {
    const failed = results.find((r) => r.isError);
    if (failed) return { emotion: '安抚', text: `执行时遇到问题：${failed.content.slice(0, 120)}。我们换个方式再试一次？` };
    const mcpUsed = [...used].find((n) => n.startsWith('mcp_'));
    if (mcpUsed) return { emotion: '专注', text: `MCP 工具返回：${lastResult.content.slice(0, 400)}` };
    if (lastResult.images?.length) return { emotion: '专注', text: `${lastResult.content}\n\n截图已经交给我了；离线演示模型看不懂图片，接入支持识图的模型后我就能分析屏幕内容。` };
    const pc = [...used].find((n) => n.startsWith('computer_') || n.startsWith('clipboard_'));
    if (pc) return { emotion: '专注', text: `完成了。结果：\n\n${lastResult.content.slice(0, 500)}` };
    if (used.has('use_skill')) {
      if (/^没有名为|已被用户停用/.test(lastResult.content)) return { emotion: '平静', text: lastResult.content };
      const name = lastResult.content.match(/^# 技能：(.+)$/m)?.[1] ?? '';
      const steps = [...lastResult.content.matchAll(/^#{2,3}\s+(.+)$/gm)].map((x) => `- ${x[1]}`).slice(0, 6).join('\n');
      return { emotion: '专注', text: `已加载技能「${name}」。按这个技能的做法，要点是：\n${steps || '（见技能说明）'}\n\n离线演示模型只能展示流程；在“模型”里接入大模型后，我会按这个技能完整执行。` };
    }
    if (used.has('write_file') && !used.has('preview') && /网页|页面|网站|游戏|html/i.test(q)) {
      return { calls: [call('preview', { path: 'demo/clock.html' })] };
    }
    if (used.has('preview')) return { emotion: '愉悦', text: '写好了：工作区里的 demo/clock.html 是一个实时时钟页面，右侧已经打开预览。想改样式或加功能，直接告诉我。' };
    if (used.has('create_document')) return { emotion: '愉悦', text: `文档已生成：${lastResult.content}。可以在右侧工作区里下载，或连接本地文件夹后直接保存到电脑。` };
    if (used.has('remember')) return { emotion: '亲和', text: '好的，我记住了。以后的回答会参考这一点。你可以在“记忆与进化”里随时查看或删除。' };
    if (used.has('kb_search')) {
      return /没有找到/.test(lastResult.content)
        ? { emotion: '平静', text: '知识库里暂时没有相关内容。把相关的 Word、PDF 或 PPT 拖进来，我就能根据它们回答。' }
        : { emotion: '专注', text: `根据知识库里的资料：\n\n${lastResult.content.slice(0, 400)}` };
    }
    if (used.has('run_javascript')) return { emotion: '专注', text: `运行完成，结果如下：\n\n\`\`\`\n${lastResult.content.slice(0, 600)}\n\`\`\`` };
    if (used.has('read_file')) return { emotion: '专注', text: `文件内容摘要（前 300 字）：\n\n${lastResult.content.slice(0, 300)}` };
    if (used.has('list_files')) return { emotion: '平静', text: `工作区里的文件：\n\n${lastResult.content.slice(0, 500)}` };
    if (used.has('get_current_time')) {
      const t = safeJson(lastResult.content);
      return { emotion: '平静', text: t ? `现在是 ${t.local}（${t.timeZone}）。` : lastResult.content };
    }
    if (used.has('get_local_metrics')) {
      const m = safeJson(lastResult.content);
      if (!m) return { emotion: '平静', text: lastResult.content };
      const cpu = m.cpu?.percent, mem = m.memory?.percent;
      const high = (cpu ?? 0) > 80 || (mem ?? 0) > 85;
      const parts = [
        cpu != null && `${m.source === 'browser' ? '页面主线程繁忙度' : 'CPU 占用'}约 ${Math.round(cpu)}%`,
        m.source === 'browser' ? (m.memory?.usedMB != null && `页面内存 ${m.memory.usedMB} MB`) : (mem != null && `内存占用 ${Math.round(mem)}%`),
        `网络${m.network?.online ? '在线' : '离线'}`
      ].filter(Boolean);
      return { emotion: high ? '警觉' : '平静', text: `${parts.join('，')}。${high ? '注意，负载偏高，建议关掉不用的程序。' : '整体运行平稳。'}` };
    }
    return { emotion: '平静', text: '完成了。' };
  }

  // —— 还没调用工具：按意图选择工具
  const imgs = messages[index]?.images ?? [];
  if (imgs.length) {
    return { emotion: '专注', text: `收到 ${imgs.length} 张图片。离线演示模型看不懂图片内容；在“模型”里接入支持识图的模型（如 Claude、GPT、Gemini、通义千问 VL）后，我就能描述图片、识别文字、分析截图里的界面和报错。` };
  }
  // —— MCP：“用 MCP 的 echo 工具……”
  if (/mcp/i.test(q)) {
    const mcpTools = tools.filter((t) => t.name.startsWith('mcp_'));
    if (!mcpTools.length) return { emotion: '平静', text: '现在还没有连接任何 MCP 服务。可以在“技能与工具”面板里添加。' };
    const t = mcpTools.find((x) => q.toLowerCase().includes(x.name.split('__').pop().toLowerCase())) ?? mcpTools[0];
    const props = t.input_schema?.properties ?? {};
    const nums = (q.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const args = {};
    for (const [k, v] of Object.entries(props)) {
      if (v.type === 'number' || v.type === 'integer') args[k] = nums.shift() ?? 0;
      else if (v.type === 'string') args[k] = q.replace(/^.*(工具|mcp)[：:，,\s]*/i, '') || q;
    }
    return { emotion: '专注', calls: [call(t.name, args)] };
  }
  // —— 桌面版：操作电脑
  if (tools.some((t) => t.name === 'computer_run')) {
    const dir = q.match(/(列出|看看|查看)(桌面|文档|下载)/);
    if (dir) return { emotion: '专注', calls: [call('computer_list_dir', { path: dir[2] })] };
    if (/截屏|截图/.test(q)) return { emotion: '专注', calls: [call('computer_screenshot', {})] };
    const cmd = q.match(/运行命令[：:\s]*(.+)/);
    if (cmd) return { emotion: '专注', calls: [call('computer_run', { command: cmd[1].trim() })] };
    const open = q.match(/^打开\s*(.+)/);
    if (open) return { emotion: '专注', calls: [call('computer_open', { target: open[1].trim() })] };
    const save = q.match(/写.*文件.*?([\w\u4e00-\u9fa5/\\.~-]+\.(txt|md))/);
    if (save) return { emotion: '专注', calls: [call('computer_write_file', { path: save[1], content: '由贾维斯写入的测试文件' })] };
  }
  const skill = q.match(/请使用技能「([^」]+)」/);
  if (skill) return { emotion: '专注', calls: [call('use_skill', { name: skill[1] })] };
  const m = q.match(/记住[：:,，\s]*(.+)/) || q.match(/^(我(?:喜欢|讨厌|叫|是|的|习惯|住在|在).+)/);
  if (m) return { emotion: '亲和', calls: [call('remember', { content: m[1].trim(), category: /喜欢|讨厌|习惯/.test(m[1]) ? 'preference' : 'profile' })] };
  if (/(写|做|开发|生成|编写).{0,8}(网页|页面|网站|游戏|小程序|html)/i.test(q)) {
    return { emotion: '专注', text: '好的，我来写一个页面并在工作区运行预览。', calls: [call('write_file', { path: 'demo/clock.html', content: DEMO_PAGE })] };
  }
  const doc = q.match(/(word|docx|文档|报告|ppt|pptx|幻灯片|演示文稿|excel|xlsx|表格|pdf)/i);
  if (doc && /(生成|写|做|创建|导出|整理)/.test(q)) {
    const k = doc[1].toLowerCase();
    const format = /ppt|幻灯片|演示/.test(k) ? 'pptx' : /excel|xlsx|表格/.test(k) ? 'xlsx' : k === 'pdf' ? 'pdf' : 'docx';
    const content = format === 'xlsx'
      ? '## 计划\n任务,负责人,截止日期,进度\n需求梳理,张三,2026-11-01,100\n原型设计,李四,2026-11-10,60\n开发实现,王五,2026-11-30,20'
      : format === 'pptx'
        ? '# 项目背景\n- 现状与问题\n- 目标用户\n# 解决方案\n- 核心功能\n- 技术路线\n# 计划与里程碑\n- 11 月：原型\n- 12 月：上线'
        : '# 项目周报\n\n## 本周进展\n- 完成需求梳理\n- 原型评审通过\n\n## 下周计划\n| 任务 | 负责人 |\n| --- | --- |\n| 开发实现 | 王五 |\n| 测试 | 赵六 |';
    return { emotion: '专注', text: '马上生成。', calls: [call('create_document', { format, path: `文档/示例.${format === 'pdf' ? 'pdf' : format}`, title: '示例文档', content })] };
  }
  if (/(知识库|资料|文档里|根据.*(文件|材料))/.test(q)) return { emotion: '专注', calls: [call('kb_search', { query: q })] };
  if (/(运行|执行|计算|算一下).*(代码|js|javascript|程序)|^\s*(计算|算一下)/i.test(q)) {
    return { emotion: '专注', calls: [call('run_javascript', { code: 'const xs = Array.from({ length: 10 }, (_, i) => i + 1);\nconsole.log("1..10 的平方：", xs.map((x) => x * x).join(", "));\nreturn xs.reduce((a, b) => a + b, 0);' })] };
  }
  if (/(有哪些|列出|看看).*(文件)|工作区/.test(q)) return { calls: [call('list_files', {})] };
  const read = q.match(/(读|打开|总结|分析)[一下]*\s*[「“"]?([^\s「」“”"]+\.(docx|pdf|pptx|xlsx|csv|txt|md|html))/i);
  if (read) return { emotion: '专注', calls: [call('read_file', { path: read[2] })] };
  if (/cpu|内存|电脑|系统|状态|负载/i.test(q)) return { calls: [call('get_local_metrics', {})] };
  if (/几点|时间|日期|星期|今天/.test(q)) return { calls: [call('get_current_time', {})] };
  if (/难过|烦|累|焦虑|压力|担心|糟糕/.test(q)) return { emotion: '安抚', text: '没关系，慢慢来。我理解这种感觉，先深呼吸一下。你愿意的话，可以说说具体发生了什么，我们一起理一理。' };
  if (/成功|通过|完成|好消息|升职|录取/.test(q)) return { emotion: '愉悦', text: '太好了，恭喜你！这份努力很值得。要不要我帮你把下一步计划列一下？' };
  return {
    emotion: '亲和',
    text: '你好，我是贾维斯。现在是离线演示模式，你可以试试：\n- “帮我写一个网页”\n- “生成一份 Word 周报” / “做一个 PPT” / “做一个 Excel 表格”\n- “记住我喜欢简洁的回答”\n- “根据知识库回答……”（先把文档拖进来）\n- “运行一段代码”\n\n在左侧“模型”里填上任意一家大模型的密钥，我就能真正理解并完成各种任务。'
  };
}

export function createMockAdapter({ charDelayMs = 12 } = {}) {
  return {
    kind: 'mock',
    async stream({ messages, tools, signal, onText }) {
      await sleep(250, signal);
      const p = plan(messages, tools);
      let text = '';
      const body = (p.emotion ? `<emotion>${p.emotion}</emotion>` : '') + (p.text ?? '');
      // 标签整体发出；正文每次 3 个字，模拟流式输出
      for (const piece of body.match(/<emotion>[^<]*<\/emotion>|[\s\S]{1,3}/g) ?? []) {
        text += piece;
        onText?.(piece);
        if (charDelayMs && !piece.startsWith('<emotion>')) await sleep(charDelayMs * 2, signal);
      }
      return { text, toolCalls: p.calls ?? [], raw: null, stop: p.calls?.length ? 'tool_use' : 'end_turn' };
    }
  };
}
