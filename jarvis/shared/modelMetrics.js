/** 只返回字符数，不保留内容。字符估计不是Token，也不是适配器编码后的HTTP字节。 */
export function measureModelInput({ system, messages = [], tools = [] }) {
  const systemChars = (Array.isArray(system) ? system : [system]).reduce((total, item) => total + String(item || '').length, 0);
  const messageChars = messages.reduce((total, item) => total + (typeof item.content === 'string' ? item.content.length : JSON.stringify(item.content ?? '').length), 0);
  // 排除run函数及实现细节，仅统计模型能看到的名称、说明和参数schema。
  const toolSchemaChars = JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))).length;
  return { systemChars, messageChars, toolSchemaChars, inputTextChars: systemChars + messageChars + toolSchemaChars };
}
