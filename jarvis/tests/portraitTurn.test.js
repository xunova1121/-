import { it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { sizedRasterPng } from './fixtures/visualRasterImages.js';

it('图片智能体接收“把妈妈P瘦”直接编辑原片，不要求海报文案，也不联网或反复检查', async () => {
  globalThis.indexedDB = new IDBFactory();
  try {
    const { runAgent } = await import('../src/agent/agent.js');
    const { createImageTaskTool } = await import('../src/agent/imageTasks.js');
    const { BUILTIN_AGENTS } = await import('../src/agent/agentProfiles.js');
    const ws = await import('../src/agent/workspace.js');
    const blob = new Blob([sizedRasterPng(512, 768)], { type: 'image/png' });
    await ws.write('上传/原片.png', blob);
    const imageEdit = vi.fn(async options => { options.beforeRequest?.(); return { blob, model: 'gpt-image-2' }; });
    const visionLlm = vi.fn(async () => JSON.stringify({ appearancePreserved: true, naturalSkin: true, naturalProportions: true, backgroundPreserved: true, noArtifacts: true, requestedChangeVisible: true, issues: [] }));
    const webSearch = vi.fn(); let requests = 0;
    const result = await runAgent({
      model: 'fixture', quiet: true, userText: '把妈妈P瘦，美化好看，原片在上传/原片.png', history: [], context: { dynamic: '' }, maxSteps: 6, maxTotalSteps: 6,
      agent: { profile: BUILTIN_AGENTS.find(profile => profile.id === 'poster-designer'), note: '用户选择：图片处理 人像显瘦' },
      tools: [createImageTaskTool({ imageEdit, visionLlm }), { name: 'web_search', description: 'fixture', input_schema: { type: 'object', properties: {} }, run: webSearch }],
      adapter: { async stream({ tools, messages, onText }) {
        if (++requests === 1) {
          expect(tools.find(tool => tool.name === 'process_image').input_schema.properties.task.enum).toContain('portrait_slim');
          return { text: '', toolCalls: [{ id: 'retouch', name: 'process_image', args: { task: 'portrait_slim', path: '上传/原片.png', instructions: '自然美化，保留长相' } }], stop: 'tool_use' };
        }
        const receipt = messages.findLast(message => message.role === 'tool' && message.name === 'process_image');
        expect(receipt.content).toContain('人像修图候选已保存');
        onText('修图候选已保存，原片保留，请对照确认效果。');
        return { text: '修图候选已保存，原片保留，请对照确认效果。', toolCalls: [], stop: 'end_turn' };
      } }, emit: () => {}
    });
    expect(imageEdit).toHaveBeenCalledOnce(); expect(visionLlm).toHaveBeenCalledOnce();
    expect(webSearch).not.toHaveBeenCalled(); expect(requests).toBeLessThanOrEqual(3);
    expect(result.text).toContain('修图候选'); expect(result.text).not.toMatch(/标题|海报文案|不能.*美颜|不支持.*瘦身/);
  } finally { delete globalThis.indexedDB; }
});
