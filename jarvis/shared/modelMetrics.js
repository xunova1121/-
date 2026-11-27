import { estimateTokens } from './tokenEstimate.js';
/** 只返回数字，不保留内容；明确区分估算Token、字符与上游实际usage。 */
export function measureModelInput({ system, messages = [], tools = [] }) {
  const systemChars = (Array.isArray(system) ? system : [system]).reduce((total, item) => total + String(item || '').length, 0);
  const messageChars = messages.reduce((total, item) => total + (typeof item.content === 'string' ? item.content.length : JSON.stringify(item.content ?? '').length), 0);
  // 排除run函数及实现细节，仅统计模型能看到的名称、说明和参数schema。
  const toolSchemaChars = JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema ?? tool.parameters }))).length;
  return { systemChars, messageChars, toolSchemaChars, inputTextChars: systemChars + messageChars + toolSchemaChars };
}

/** 与旧字符指标分开提供，保持既有数字接口和评测格式兼容。 */
export function measureModelTokens({ system, messages = [], tools = [] }) {
  const toolMessages = messages.filter(message => message.role === 'tool');
  const otherMessages = messages.filter(message => message.role !== 'tool');
  return {
    estimatedSystemTokens: (Array.isArray(system) ? system : [system]).reduce((sum, part) => sum + estimateTokens(String(part || '')), 0),
    estimatedDialogueTokens: otherMessages.reduce((sum, message) => sum + estimateTokens(message.content ?? ''), 0),
    estimatedToolResultTokens: toolMessages.reduce((sum, message) => sum + estimateTokens(message.content ?? ''), 0),
    estimatedSchemaTokens: estimateTokens(JSON.stringify(tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema ?? tool.parameters }))))
  };
}
