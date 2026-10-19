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
