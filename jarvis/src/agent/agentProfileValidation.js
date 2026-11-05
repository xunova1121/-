import { CORE } from './toolLoader.js';

export const AGENT_CATEGORIES = Object.freeze(['office', 'gongwen', 'image', 'research', 'life', 'mine']);
// 复用常驻工具目录；文档模板工具虽按需加载，也是已实现的工具。
export const PROFILE_TOOL_NAMES = Object.freeze([...CORE, 'get_document_template']);
const knownTools = new Set(PROFILE_TOOL_NAMES);
const outputs = new Set(['text', 'docx', 'pptx', 'xlsx', 'image']);
const sources = new Set(['builtin', 'user', 'github']);
const fields = ['id', 'name', 'icon', 'category', 'intro', 'starters', 'prompt', 'tools', 'form', 'output', 'source', 'steps'];
/** 工作流每一步完成后的确定性检查（见 workflowRun.js）；none 表示不检查 */
export const WORKFLOW_CHECKS = Object.freeze(['none', 'gongwen', 'numbers']);
export const MAX_WORKFLOW_STEPS = 8;
export const MAX_PROFILE_BYTES = 32 * 1024;
export const profileError = (field, detail, status = 400) => Object.assign(new Error(`${field}：${detail}`), {
  name: 'ValidationError', code: 'INVALID_AGENT_PROFILE', kind: 'input', status, field
});

function object(value, field, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw profileError(field, '须为配置对象');
  // 未知键不回显，避免把误粘进字段名的凭据带进错误日志。
  if (Object.keys(value).some(key => !keys.includes(key))) throw profileError(field, '包含未支持的字段；不能附带密钥、身份或连接设置');
}

function text(value, field, max, { empty = false } = {}) {
  if (typeof value !== 'string') throw profileError(field, '须为文字');
  const result = value.trim();
  if ((!empty && !result) || [...result].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) throw profileError(field, `须为${empty ? '0' : '1'}～${max}字的有效文字`);
  return result;
}

export function profileId(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) throw profileError('id', '须为小写字母开头的字母、数字和短横线，最长64字符');
  return value;
}

function array(value, field, max) {
  if (!Array.isArray(value) || value.length > max) throw profileError(field, `须为数组且最多${max}项`);
  // 稀疏数组没有可展示的值，不让map跳过其校验。
  if (Object.keys(value).length !== value.length || Object.keys(value).some((key, i) => key !== String(i))) throw profileError(field, '不能有空项或额外属性');
  return value;
}

function unique(values, field) {
  if (new Set(values).size !== values.length) throw profileError(field, '不能重复');
  return values;
}

function formField(value, index) {
  const field = `form[${index}]`;
  object(value, field, ['key', 'label', 'type', 'options', 'default', 'required']);
  if (typeof value.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(value.key)) throw profileError(`${field}.key`, '须为小写字母开头的字母、数字或下划线，最长40字符');
  const label = text(value.label, `${field}.label`, 40);
  if (!['select', 'text', 'textarea'].includes(value.type)) throw profileError(`${field}.type`, '须为select、text或textarea');
  const result = { key: value.key, label, type: value.type };
  if (value.required !== undefined) {
    if (typeof value.required !== 'boolean') throw profileError(`${field}.required`, '须为布尔值');
    result.required = value.required;
  }
  if (value.type === 'select') {
    result.options = unique(array(value.options, `${field}.options`, 24).map((v, i) => text(v, `${field}.options[${i}]`, 80)), `${field}.options`);
    if (!result.options.length) throw profileError(`${field}.options`, '至少提供一个选项');
  } else if (value.options !== undefined) throw profileError(`${field}.options`, '仅select字段可提供选项');
  if (value.default !== undefined) {
    result.default = text(value.default, `${field}.default`, value.type === 'textarea' ? 2000 : 200, { empty: value.type !== 'select' });
    if (result.options && !result.options.includes(result.default)) throw profileError(`${field}.default`, '须为已声明的选项');
  }
  return result;
}

/** 只返回配置白名单字段；唯一性由调用方提供现存id，持久化在同一锁内再核对。 */
export function validateProfile(value, { existingIds = [], toolNames = knownTools } = {}) {
  object(value, 'profile', fields);
  const id = profileId(value.id);
  if (new Set(existingIds).has(id)) throw profileError('id', '已存在，请换一个编号', 409);
  const result = { id, name: text(value.name, 'name', 40), icon: text(value.icon, 'icon', 40) };
  if (!/^[a-z][a-z0-9-]*$/.test(result.icon)) throw profileError('icon', '须为图标名，不能是网址、SVG代码或文件路径');
  if (!AGENT_CATEGORIES.includes(value.category)) throw profileError('category', '分类无效');
  result.category = value.category;
  result.intro = text(value.intro, 'intro', 200);
  result.starters = unique(array(value.starters, 'starters', 3).map((v, i) => text(v, `starters[${i}]`, 200)), 'starters');
  if (result.starters.length !== 3) throw profileError('starters', '须提供3条推荐问题');
  result.prompt = text(value.prompt, 'prompt', 600, { empty: true });
  const names = new Set(toolNames);
  result.tools = unique(array(value.tools, 'tools', 128).map((v, i) => {
    if (typeof v !== 'string' || !names.has(v)) throw profileError(`tools[${i}]`, '工具名不在可用目录中');
    return v;
  }), 'tools');
  result.form = array(value.form, 'form', 12).map(formField);
  unique(result.form.map(v => v.key), 'form.key');
  if (!outputs.has(value.output)) throw profileError('output', '产出类型无效');
  if (!sources.has(value.source)) throw profileError('source', '来源类型无效');
  result.output = value.output;
  result.source = value.source;
  // 工作流步骤（可选，旧配置没有这个字段照常可读）：每步写做什么、交给哪个智能体、做完怎么检查
  if (value.steps !== undefined) {
    result.steps = array(value.steps, 'steps', MAX_WORKFLOW_STEPS).map((step, i) => {
      const field = `steps[${i}]`;
      object(step, field, ['title', 'task', 'agentId', 'check']);
      const out = { title: text(step.title, `${field}.title`, 40), task: text(step.task, `${field}.task`, 600) };
      if (step.agentId !== undefined && step.agentId !== '') {
        out.agentId = profileId(step.agentId);
        if (out.agentId === id) throw profileError(`${field}.agentId`, '不能把步骤交给工作流自己');
      }
      const check = step.check ?? 'none';
      if (!WORKFLOW_CHECKS.includes(check)) throw profileError(`${field}.check`, '检查方式无效');
      if (check !== 'none') out.check = check;
      return out;
    });
    if (!result.steps.length) delete result.steps;
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_PROFILE_BYTES) throw profileError('profile', '单份配置不能超过32KiB');
  return result;
}

export function profileFilter({ category, query = '' } = {}) {
  if (category !== undefined && category !== '' && !AGENT_CATEGORIES.includes(category)) throw profileError('category', '分类无效');
  return { category, query: text(query, 'query', 100, { empty: true }).toLocaleLowerCase() };
}
