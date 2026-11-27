import { it, expect } from 'vitest';
import { createToolLoader } from '../src/agent/toolLoader.js';
import { DOCUMENT_TASK_CORE } from '../src/agent/documentToolProfile.js';
import { createTools } from '../src/agent/tools.js';
import { conciseTool } from '../src/agent/toolDescriptions.js';
it('文档不常驻持仓/音乐/架构工具，仍可按需发现和执行', async () => {
  const tools = createTools({});
  const normal = createToolLoader(tools), focused = createToolLoader(tools, { core: DOCUMENT_TASK_CORE });
  const size = loader => JSON.stringify(loader.list().map(conciseTool)).length;
  expect(size(focused)).toBeLessThan(size(normal) * 0.7);
  expect(focused.isActive('create_document')).toBe(true);
  expect(focused.isActive('holding_profit')).toBe(false);
  expect(focused.hint()).toContain('holding_profit');
  await focused.get('tool_search').run({ names: ['holding_profit'] });
  expect(focused.isActive('holding_profit')).toBe(true);
  expect(focused.get('holding_profit')).toBe(tools.find(t => t.name === 'holding_profit'));
});
