import { describe, it, expect } from 'vitest';
import { mediaRequirement, mediaReceipt, blockedAfterDenial } from '../src/agent/actionDelivery.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { reviewOutcome } from '../src/agent/reviewOutcome.js';
import { runAgent } from '../src/agent/agent.js';

describe('媒体真实交付与拒绝后的任务边界', () => {
  it('明确制作才要求文件，讨论和歌词不触发服务', () => {
    expect(mediaRequirement('画一张温馨的图片').tool).toBe('generate_image');
    expect(mediaRequirement('请谱曲并演唱').tool).toBe('sing_song');
    for (const text of ['怎么生成图片', '只写歌词', '解释唱歌技能', '帮我写图片提示词', '不要生成图片', '暂不谱曲', '不用制作歌曲']) expect(mediaRequirement(text)).toBeNull();
  });
  it('排队、缺文件、失败都不能算真实完成', () => {
    expect(mediaReceipt('sing_song', true, '正在排队')).toMatchObject({ state: 'pending', files: [] });
    expect(mediaReceipt('sing_song', true, '已经唱好了')).toMatchObject({ state: 'pending' });
    expect(mediaReceipt('sing_song', false, '已保存 音乐/demo.mp3')).toMatchObject({ state: 'failed', files: [] });
    expect(mediaReceipt('sing_song', true, '已经唱好了，保存在工作区 音乐/demo.mp3，对话里可以直接播放')).toMatchObject({ state: 'completed', files: ['音乐/demo.mp3'] });
    expect(mediaReceipt('generate_image', true, '已生成图片，保存在工作区 images/a.png。')).toMatchObject({ state: 'completed', files: ['images/a.png'] });
  });
  it('最后一次失败不能借旧成功冒充完成，已有文字不删除', () => {
    const review = createExecutionReview('请谱曲并演唱');
    review.record({ name: 'sing_song', ok: true, output: '已经唱好了，保存在 音乐/a.mp3' });
    expect(review.report().media.state).toBe('completed');
    review.record({ name: 'sing_song', ok: false, output: '网络超时' });
    expect(review.report().media.state).toBe('failed');
    expect(reviewOutcome(review.report()).outcome).toBe('partial');
    expect(review.guidance()).toContain('已有歌词/文字保留');
  });
  it('安装拒绝不能改做旧文档，新用户目标可以解除', () => {
    const review = createExecutionReview('安装这个技能');
    review.record({ name: 'install_skill', ok: false, code: 'NOT_APPROVED' });
    expect(review.toolBlock('create_document')).toBeTruthy();
    expect(review.toolBlock('read_file')).toBe('');
    review.revise('现在制作一份PPT');
    expect(review.toolBlock('create_document')).toBe('');
    expect(blockedAfterDenial('安装技能并制作PPT', 'install_skill', 'create_document')).toBe('');
  });
  it('主循环口头承诺后会补真实制作，只有媒体工具也能核对', async () => {
    let calls = 0;
    let generated = 0;
    const adapter = { async stream({ onText }) {
      calls++;
      if (calls === 2) return { text: '', toolCalls: [{ id: 'image-1', name: 'generate_image', args: {} }], stop: 'tool_use' };
      const text = calls === 1 ? '我来画。' : '图片已生成。';
      onText(text);
      return { text, toolCalls: [], stop: 'end_turn' };
    } };
    const result = await runAgent({ adapter, model: 'fixture', userText: '画一张温馨的小猫图片', history: [], tools: [{ name: 'generate_image', description: '测试画图', input_schema: { type: 'object', properties: {} }, run: async () => { generated++; return '已生成图片，保存在 images/cat.png。'; } }], context: { dynamic: '' }, emit: () => {}, quiet: true });
    expect(generated).toBe(1);
    expect(calls).toBeLessThanOrEqual(4);
    expect(result.text).toContain('图片已生成');
  });
});
