import { describe, it, expect } from 'vitest';
import { searchBrand } from '../src/ui/transcript.js';

describe('模型自带联网搜索的步骤名', () => {
  it('按当前模型写是谁在搜，不再一律写 Claude', () => {
    expect(searchBrand('gpt-6.1-sol')).toBe('GPT ');
    expect(searchBrand('relay-multi::o3')).toBe('GPT ');
    expect(searchBrand('claude-sonnet-4-5')).toBe('Claude ');
    expect(searchBrand('gemini-2.5-pro')).toBe('Gemini ');
    expect(searchBrand('deepseek-chat')).toBe('模型');
    expect(searchBrand()).toBe('模型');
  });
});
