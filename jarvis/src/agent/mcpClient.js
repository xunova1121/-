/**
 * 浏览器端的 MCP：通过本机网关（完整版 / 桌面版）管理 MCP 服务，并把它们的工具包装成智能体工具。
 * 网关要求同源 + 自定义请求头 x-jarvis-client，其他网站无法调用。
 */
const H = { 'x-jarvis-client': '1', 'content-type': 'application/json' };

async function req(origin, path, init = {}) {
  const r = await fetch(`${origin}${path}`, { ...init, headers: { ...H, ...init.headers } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `网关返回 ${r.status}`);
  return j;
}

export const listServers = (origin) => req(origin, '/api/mcp');
export const saveServer = (origin, s) => req(origin, `/api/mcp/servers/${encodeURIComponent(s.id)}`, { method: 'PUT', body: JSON.stringify(s) });
export const removeServer = (origin, id) => req(origin, `/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const restartServer = (origin, id) => req(origin, `/api/mcp/servers/${encodeURIComponent(id)}/restart`, { method: 'POST' });
export const callTool = (origin, server, tool, args) => req(origin, '/api/mcp/call', { method: 'POST', body: JSON.stringify({ server, tool, arguments: args }) });

/** 工具名只能用 ASCII 字母数字、下划线、连字符，最长 64 */
const ascii = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
function hash(s) {
  let h = 5381;
  for (const ch of String(s)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(36).slice(0, 5);
}
export function toolName(serverId, tool) {
  const sv = ascii(serverId).slice(0, 16) || `s${hash(serverId)}`;
  const name = `mcp_${sv}__${ascii(tool)}`;
  return name.length <= 64 ? name : `${name.slice(0, 58)}_${hash(name)}`;
}

/** 规范化 MCP 的输入 JSON Schema（去掉 $schema，确保是对象） */
export function normalizeSchema(schema) {
  const s = schema && typeof schema === 'object' ? { ...schema } : {};
  delete s.$schema;
  if (s.type !== 'object') return { type: 'object', properties: {} };
  s.properties ??= {};
  return s;
}

/**
 * @param {string} origin 网关地址
 * @param {Array} servers listServers() 返回的 servers
 * @returns 智能体工具数组
 */
export function mcpTools(origin, servers) {
  const out = [];
  const seen = new Set();
  for (const s of servers) {
    if (s.status !== 'ready') continue;
    for (const t of s.tools) {
      let name = toolName(s.id, t.name);
      while (seen.has(name)) name = `${name.slice(0, 60)}_${out.length}`;
      seen.add(name);
      out.push({
        name,
        description: `[MCP · ${s.name}] ${t.title ? `${t.title}：` : ''}${(t.description || '').slice(0, 900)}`,
        input_schema: normalizeSchema(t.inputSchema),
        mcp: { server: s.id, serverName: s.name, tool: t.name },
        // 未设为“自动允许”的服务，每次调用前询问
        approval: s.autoApprove ? null : (args) => ({
          key: `mcp:${s.id}`,
          title: `使用 MCP 工具「${s.name} · ${t.title || t.name}」`,
          detail: JSON.stringify(args ?? {}, null, 2).slice(0, 1200)
        }),
        run: async (args) => {
          const r = await callTool(origin, s.id, t.name, args);
          if (r.isError) throw new Error(r.text);
          return r.text;
        }
      });
    }
  }
  return out;
}
