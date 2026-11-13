// 测试用的最小 MCP 服务（stdio）：echo 回显、add 相加、fail 返回错误
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-test', version: '1.0.0' });
server.registerTool('echo', { description: '原样返回消息', inputSchema: { message: z.string().describe('要回显的消息') } },
  async ({ message }) => ({ content: [{ type: 'text', text: `回显：${message}` }] }));
server.registerTool('add', { description: '两数相加', inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
server.registerTool('fail', { description: '总是失败', inputSchema: {} },
  async () => ({ isError: true, content: [{ type: 'text', text: '故意失败' }] }));
await server.connect(new StdioServerTransport());
