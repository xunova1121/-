import { describe, it, expect } from 'vitest';
import { EmotionTagStripper, stripEmotionTags, EMOTIONS } from '../shared/emotionTag.js';
describe('情绪简写不泄漏到对话正文', () => {
 it.each(EMOTIONS)('逐字输出 <%s> 时仍提取提示', emotion => {
  const parser = new EmotionTagStripper(); let text = '', hint = null;
  for (const ch of '<' + emotion + '>我先查一下。') { const r = parser.push(ch); text += r.text; hint ||= r.hint; }
  text += parser.flush().text;
  expect(text).toBe('我先查一下。'); expect(hint).toBe(emotion);
 });
 it('旧对话和流式绘制去掉开头简写', () => {
  expect(stripEmotionTags('  <专注>我先查一下。')).toBe('我先查一下。');
  expect(stripEmotionTags('<emotion>专注</emotion>正文')).toBe('正文');
 });
 it.each(['<div>正文</div>', '价格 < 10', '\`<专注>\`', '示例：<专注>', '<未知>正文'])('不删除普通内容 %s', input => {
  const parser = new EmotionTagStripper(); let text = '';
  for (const ch of input) text += parser.push(ch).text;
  expect(text + parser.flush().text).toBe(input); expect(stripEmotionTags(input)).toBe(input);
 });
});

describe('各种写法的表情标签都不出现在回答开头', () => {
  const forms = ['<emotion>专注</emotion>好的', '<专注>好的', '【专注】好的', '[专注] 好的', '（专注）好的', '<emotion>focused</emotion>好的',
    '<emotion>concentrated</emotion>好的', '<emotion>专注</emotion>\n<emotion>专注</emotion>好的', '(emotion: 专注) 好的', 'emotion:专注\n好的',
    '<emotion=专注>好的', '<emotion 专注>好的', '＜emotion＞专注＜/emotion＞好的', '<Emotion>专注</Emotion>好的', '<emotion>\n专注\n</emotion>\n好的'];
  it.each(forms)('流式逐字、逐 3 字、一次性：%s', (input) => {
    for (const size of [1, 3, 100]) {
      const s = new EmotionTagStripper(); let out = '';
      for (let i = 0; i < input.length; i += size) out += s.push(input.slice(i, i + size)).text;
      out += s.flush().text;
      expect(stripEmotionTags(out)).toBe('好的');
      expect(stripEmotionTags(input)).toBe('好的'); // 旧对话里存下的也去掉
    }
  });
  it('每段开头单独的情绪标签也去掉，正文里的普通括号不动', () => {
    expect(stripEmotionTags('好的。\n\n<专注>下一段')).toBe('好的。\n\n下一段');
    expect(stripEmotionTags('【注意】先备份')).toBe('【注意】先备份');
    expect(stripEmotionTags('[1] 第一条')).toBe('[1] 第一条');
    expect(stripEmotionTags('Excel 表格已生成')).toBe('Excel 表格已生成');
  });
  it('不像标签的开头立刻放行，不拖慢首字', () => {
    for (const first of ['好', 'E', '[1', '(注']) {
      const s = new EmotionTagStripper();
      const r = s.push(first === 'E' ? 'Excel 已生成' : first === '[1' ? '[1] 第一条' : first === '(注' ? '(注) 说明' : '好的');
      expect(r.text.length).toBeGreaterThan(0);
    }
  });
});
