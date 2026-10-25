/**
 * 工具按需加载：工具多了（桌面版 + MCP 往往四五十个），每一轮都把全部工具说明发给模型既费钱，又让模型更容易选错。
 *
 *   常驻    常用工具（读写文件、写文档、搜索、运行代码……）每轮都带完整说明
 *   按需    其余工具只在系统提示里列出名字和一句话用途；模型用 tool_search 按关键词或名字加载完整说明后再调用
 *   宽松    模型直接调用了没加载的工具（名字在列表里）也照常执行，参数不对会按校验结果提示它
 *   不变    工具总数不超过 LIMIT 时全部常驻，和以前一样
 *   MCP     用户自己连的 MCP 工具不多时也常驻（特意连上的，多半要用）
 */

export const LIMIT = 24;
/** MCP 工具总数不超过这么多时全部常驻 */
export const MCP_CORE = 12;

/** 做文档的工具：说明长（合计约 7 千字），普通问答、查资料时先不带完整说明 */
export const DOCUMENT_TOOLS = new Set(['write_long_document', 'create_document', 'write_professional_document', 'generate_task_brief', 'edit_office_document', 'edit_spreadsheet']);

/** 常驻工具：系统提示里点名的、几乎每天都用的 */
export const CORE = new Set([
  'write_professional_document', 'generate_task_brief',
  'verify_numbers', 'get_stock_kline', 'get_sports_scores', 'check_search_terms', 'review_task', 'execution_capabilities', 'run_project_tests', 'get_current_time', 'get_weather', 'remember', 'recall', 'core_memory_update', 'save_skill', 'use_skill',
  'web_search', 'fetch_url', 'read_evidence', 'fact_check', 'deep_research', 'kb_search', 'search_conversations', 'list_my_messages', 'read_conversation',
  'generate_image', 'sing_song', 'read_image_text', 'inspect_image', 'schedule_task',
  'update_plan', 'delegate_task', 'need_more_time', 'find_files', 'search_in_files', 'read_task_requirements', 'read_tool_result',
  'list_files', 'read_file', 'write_file', 'edit_file', 'edit_spreadsheet', 'create_document', 'write_long_document', 'edit_office_document', 'check_document',
  'run_javascript', 'run_python', 'preview',
  'computer_capabilities', 'computer_list_dir', 'computer_search', 'computer_read_file', 'computer_write_file', 'computer_edit_file', 'computer_edit_office_document', 'computer_run', 'computer_open'
]);

const firstSentence = (d) => String(d ?? '').split(/[。\n]/)[0].slice(0, 40);

/** 中文按字、英文按词的简单相关度 */
function score(tool, query) {
  const q = String(query ?? '').toLowerCase();
  const hay = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
  if (!q.trim()) return 0;
  let s = 0;
  for (const w of q.split(/[\s,，、/]+/).filter(Boolean)) {
    if (tool.name.toLowerCase() === w) s += 20;
    else if (tool.name.toLowerCase().includes(w)) s += 8;
    if (/[一-鿿]/.test(w)) {
      // 中文：按两个字一组算重合
      for (let i = 0; i < w.length - 1; i++) if (hay.includes(w.slice(i, i + 2))) s += 2;
      if (w.length === 1 && hay.includes(w)) s += 1;
    } else if (hay.includes(w)) s += 3;
  }
  return s;
}

/**
 * @param {Array<{ name: string, description: string }>} tools
 * @param {{ limit?: number }} [o]
 */
export function createToolLoader(tools, { limit = LIMIT, defer = null } = {}) {
  const all = new Map(tools.map((t) => [t.name, t]));
  const deferredMode = tools.length > limit;
  // 用户自己连的 MCP 服务是特意要用的：工具不多（≤ MCP_CORE 个）时也常驻
  const mcp = tools.filter((t) => t.name.startsWith('mcp_'));
  // defer：这一轮多半用不上的常驻工具也先只列名字（普通问答不带做文档的长说明，每步少发几千字）；直接按名字调用照样能用
  const keep = (t) => (CORE.has(t.name) && !defer?.has(t.name)) || (mcp.length <= MCP_CORE && t.name.startsWith('mcp_'));
  const active = new Set(deferredMode ? tools.filter(keep).map((t) => t.name) : tools.map((t) => t.name));
  const deferred = () => tools.filter((t) => !active.has(t.name));

  const searchTool = {
    name: 'tool_search',
    description: '加载更多工具：系统提示“其他可用工具”里列出的工具，先用这个按名字或关键词加载完整说明，然后就能调用。可以一次加载好几个。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要做的事的关键词，如“点击屏幕”“定时任务”“剪贴板”' },
        names: { type: 'array', items: { type: 'string' }, description: '要加载的工具名（知道名字时直接给）' }
      },
      additionalProperties: false
    },
    run: async ({ query = '', names = [] }) => {
      const picked = [];
      for (const n of Array.isArray(names) ? names : []) if (all.has(n) && !picked.includes(n)) picked.push(n);
      if (query) {
        for (const t of tools.map((t) => [t, score(t, query)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t)) {
          if (!picked.includes(t.name)) picked.push(t.name);
        }
      }
      if (!picked.length) return `没有找到和“${query || names.join('、')}”相关的工具。可用的工具名见系统提示里的“其他可用工具”。`;
      for (const n of picked) active.add(n);
      return `已加载 ${picked.length} 个工具，下一步就可以调用：\n${picked.map((n) => `- ${n}：${firstSentence(all.get(n).description)}`).join('\n')}`;
    }
  };

  return {
    deferredMode,
    /** 这一步发给模型的工具 */
    list: () => (deferredMode ? [...tools.filter((t) => active.has(t.name)), searchTool] : tools),
    /** 按名字找工具（包括还没加载的，调用时自动加载） */
    get(name) {
      if (name === 'tool_search' && deferredMode) return searchTool;
      const t = all.get(name);
      if (t && deferredMode) active.add(name);
      return t;
    },
    /** 系统提示里列出没加载的工具（只有名字和一句话） */
    hint() {
      if (!deferredMode) return '';
      const rest = deferred();
      if (!rest.length) return '';
      return `## 其他可用工具（需要时先用 tool_search 加载说明再调用）\n${rest.map((t) => `- ${t.name}：${firstSentence(t.description)}`).join('\n')}`;
    },
    isActive: (name) => active.has(name)
  };
}





