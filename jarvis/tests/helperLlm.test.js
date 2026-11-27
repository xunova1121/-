import { it, expect } from 'vitest';
import { createHelperLlm } from '../src/llm/helper.js';

it('辅助模型把禁用原生搜索及重试限制传到真实适配器入口', async () => {
  let request;
  const helper = createHelperLlm(
    {
      stream: async (args) => {
        request = args;
        return { text: '模型结果' };
      }
    },
    'test-model'
  );
  const controller = new AbortController();
  expect(
    await helper({
      system: '规则',
      prompt: '要求',
      signal: controller.signal,
      allowWebSearch: false,
      maxWebSearches: 0,
      maxTransientRetries: 0,
      maxPartialRetries: 0
    })
  ).toBe('模型结果');
  expect(request.allowWebSearch).toBe(false);
  expect(request.maxWebSearches).toBe(0);
  expect(request.maxTransientRetries).toBe(0);
  expect(request.signal).toBe(controller.signal);
});

it('旧调用不设置搜索限制，流式正文仍可回收', async () => {
  let request;
  const helper = createHelperLlm(
    {
      stream: async (args) => {
        request = args;
        args.onText('片段');
        return {};
      }
    },
    'test-model'
  );
  expect(await helper({ system: '规则', prompt: '要求' })).toBe('片段');
  expect(request.allowWebSearch).toBeUndefined();
});

it('显式需要停止类型时返回有界元数据，普通调用仍是字符串且不泄漏额外字段',async()=>{
 const helper=createHelperLlm({stream:async()=>({text:'{"ok":true}',stop:'max_tokens',headers:{authorization:'FAKE-SECRET'}})},'test');
 expect(await helper({system:'x',prompt:'x',returnDetails:true})).toEqual({text:'{"ok":true}',stop:'max_tokens'});
 expect(typeof await helper({system:'x',prompt:'x'})).toBe('string');
});
