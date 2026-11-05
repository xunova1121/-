/**
 * 用智能体开的对话：把注册表里的配置变成本轮的角色说明、工具范围和用户选择（智能体广场第1步）。
 *   - 配置只从当前用户的注册表按 id 取，不接受客户端直接传来的配置（防止借配置放大权限）
 *   - 工具只能在本轮原有工具上取交集；白名单为空 = 原样不动
 *   - 表单值按配置逐项校验后写成“用户选择：……”，附加到本轮要求，不改用户原话
 */
import { getAgent } from './agentProfiles.js';
import { profileId } from './agentProfileValidation.js';

/** 只管流程、不授予能力的工具：收窄后也保留，否则模型连“看要求 / 列计划 / 要更多时间”都做不了 */
export const AGENT_FLOW_TOOLS = new Set(['read_task_requirements', 'read_tool_result', 'need_more_time', 'update_plan', 'review_task', 'execution_capabilities', 'tool_search']);

const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** 表单值 → 一句“用户选择：页数 6-10；场景 政企汇报”。不在选项里的、超长的、配置没有的键一律丢掉 */
export function agentFormNote(profile, values = {}) {
  if (!profile?.form?.length || !values || typeof values !== 'object' || Array.isArray(values)) return '';
  const parts = [];
  for (const field of profile.form) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    const value = clean(values[field.key]);
    if (!value) continue;
    if (field.type === 'select' && !field.options.includes(value)) continue;
    if ([...value].length > (field.type === 'textarea' ? 2000 : 200)) continue;
    parts.push(`${field.label} ${value}`);
  }
  return parts.length ? `用户选择：${parts.join('；')}` : '';
}

/** 工具取交集：只会变少，不会变多 */
export function narrowAgentTools(tools = [], profile = null) {
  if (!profile?.tools?.length) return tools;
  const allowed = new Set([...profile.tools, ...AGENT_FLOW_TOOLS]);
  return tools.filter((tool) => allowed.has(tool.name));
}

/** 附加到系统提示的角色说明 */
export function agentPromptNote(profile) {
  if (!profile) return '';
  const lines = [`## 当前智能体：${profile.name}`, profile.prompt].filter(Boolean);
  if (profile.tools?.length) lines.push('本对话只开放这个智能体的工具；用户要做范围外的事时说明可以回到普通对话处理，不要假装做了。');
  return lines.join('\n');
}

/**
 * 按 id 解析本轮智能体。id 不对、找不到都抛 ValidationError（code AGENT_NOT_FOUND），不悄悄当普通对话跑：
 * 用户以为在用“公文写作”，实际却没有限制，结果说不清。
 */
export async function resolveAgentTurn({ agentId = null, form = null } = {}, { lookup = getAgent } = {}) {
  if (agentId === null || agentId === undefined || agentId === '') return null;
  profileId(agentId);
  const profile = await lookup(agentId);
  if (!profile) throw Object.assign(new Error('这个智能体不存在或已被删除，请回到广场重新选择'), { name: 'ValidationError', code: 'AGENT_NOT_FOUND', kind: 'input', status: 404 });
  return { profile, note: agentFormNote(profile, form || {}) };
}

/** 本轮要求：原话 + 用户选择（用于任务契约、页数 / 风格判断等），原话本身不改 */
export const withAgentRequirement = (text, agent) => (agent?.note ? `${text}\n\n（${agent.note}）` : text);

/** 客户端传来的表单值只留“短键 → 文字”，最多 12 项；真正是否有效由 agentFormNote 按配置再判断 */
export function sanitizeAgentForm(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, v] of Object.entries(value).slice(0, 12)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || typeof v !== 'string') continue;
    out[key] = v.slice(0, 2000);
  }
  return Object.keys(out).length ? out : null;
}
