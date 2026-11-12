import { describe, it, expect } from 'vitest';
import { textPosterRequest, posterReceipt, posterAnswerIssues, POSTER_GUIDANCE } from '../src/agent/posterRouting.js';
import { mediaRequirement } from '../src/agent/actionDelivery.js';
import { taskContract } from '../src/agent/taskContract.js';
import { taskToolCore } from '../src/agent/taskToolProfile.js';
import { createToolLoader } from '../src/agent/toolLoader.js';
import { createTools } from '../src/agent/tools.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { reviewOutcome } from '../src/agent/reviewOutcome.js';
import { runAgent } from '../src/agent/agent.js';
import { AGENT_SKILLS } from '../src/agent/agentSkills.js';
import { MORE_BUILTIN_SKILLS } from '../src/agent/skillCatalog.js';

const files = ['png', 'svg', 'pptx'].map(format => ({ format, path: `海报/活动.${format}`, readback: 'passed', structure: 'passed', render: format === 'png' ? 'passed' : 'not_checked' }));
const receipt = (overrides = {}) => JSON.stringify({ kind: 'poster', status: 'complete', width: 1080, height: 1920, files, textRendering: 'program', visual: 'not_checked', fontCheck: 'passed', notes: [], errors: [], ...overrides });

describe('中文海报通用路由与真实交付', () => {
  it.each(['做一张活动海报，标题“春日见面会”，时间10月1日', '设计公众号封面，标题要准确', '把原图做成海报，只修改标题', '来张中秋海报', '生成海报，底图不要任何文字，然后加标题', '做一张海报，提供PPTX', '画一张春季活动宣传图，写上“春日集市”', '生成一张图片，用代码写上黑体字秋季养生汤', '制作一张配图，上面写上“欢迎光临”', '给这张图片加上中文标题'])('普通入口识别精确排字制作：%s', text => {
    expect(textPosterRequest(text)).toBe(true);
    expect(mediaRequirement(text)).toMatchObject({ kind: 'poster', tool: 'make_poster' });
  });

  it.each(['怎么制作海报', '帮我写海报提示词', '不要制作海报', '生成无字海报底图', '做海报，只要底图', '生成海报，不要任何文字', '画一张可爱的小猫', '制作一份Word海报告示', '制作Word文档封面', '做一份PPT，封面写主题', '画架构图，精确文字连线', '生成海报，用图像模型直接画字', '介绍图片识字，怎样给图片加上文字', '生成一张无字插画图片', '画一张风景配图', '做一份PPT，配图上写上标题', '画系统架构图，图上写上各层标题'])('保留其它图片、文档和明确例外：%s', text => {
    expect(textPosterRequest(text)).toBe(false);
    expect(mediaRequirement(text)?.kind).not.toBe('poster');
  });

  it('海报首轮直接展示排字与图片工具，原架构工具仍可按名发现', () => {
    const tools = createTools({});
    const loader = createToolLoader(tools, { core: taskToolCore({ category: 'generic' }, '做一张活动海报') });
    for (const name of ['generate_image', 'make_poster', 'inspect_image', 'read_file']) expect(loader.isActive(name), name).toBe(true);
    for (const name of ['run_python', 'render_diagram', 'create_diagram']) expect(loader.isActive(name), name).toBe(false);
    expect(loader.get('render_diagram')).toBe(tools.find(tool => tool.name === 'render_diagram'));
    expect(taskToolCore({}, '画系统架构图').has('create_diagram')).toBe(true);
    expect(taskContract('做一张活动海报').criteria.join('；')).toMatch(/PNG.*SVG.*PPTX/);
    expect(AGENT_SKILLS['poster-designer']).toContain('最终 PNG');
    const skill = MORE_BUILTIN_SKILLS.find(item => item.title === '生成图片').text;
    expect(skill).toContain('make_poster');
    expect(skill).not.toContain('用户满意后再说明怎么截图保存');
  });

  it('用代码写上黑体字是程序排字，不触发代码开发工具；真正交代码仍走原路', () => {
    const request = '生成一张图片，用代码写上黑体字秋季养生汤';
    const core = taskToolCore({ category: 'code' }, request);
    expect(core.has('make_poster')).toBe(true);
    expect(core.has('run_python')).toBe(false);
    expect(core.has('code_write')).toBe(false);
    expect(taskContract(request).coding).toBe(false);
    expect(taskContract(request).criteria.join('；')).not.toContain('实际执行环境');
    const code = '开发一个程序，给图片写上黑体字';
    expect(textPosterRequest(code)).toBe(false);
    expect(taskContract(code).coding).toBe(true);
    expect(taskToolCore({ category: 'code' }, code).has('code_write')).toBe(true);
  });

  it('只有三格式真实读回且最终PNG渲染成功，才计生成完成', () => {
    expect(posterReceipt(true, receipt())).toMatchObject({ state: 'completed', files: files.map(file => file.path), visual: 'not_checked' });
    expect(posterReceipt(true, '海报已保存 海报/活动.pptx')).toMatchObject({ state: 'pending', files: [] });
    for (const overrides of [{ files: files.slice(1) }, { width: 0 }, { textRendering: 'model' }, { status: 'partial' }, { errors: [{ code: 'POSTER_PNG' }] }, { files: files.map(file => file.format === 'png' ? { ...file, render: 'not_checked' } : file) }, { files: files.map(file => file.format === 'svg' ? { ...file, readback: 'not_checked' } : file) }, { files: files.map(file => file.format === 'svg' ? { ...file, path: '海报/活动.png' } : file) }]) {
      expect(posterReceipt(true, receipt(overrides)).state, JSON.stringify(overrides)).not.toBe('completed');
    }
    expect(posterReceipt(false, receipt())).toMatchObject({ state: 'failed', files: [] });
    expect(posterReceipt(true, receipt({ fontCheck: 'not_checked' })).state).not.toBe('completed');
    expect(posterReceipt(true, receipt({ designPath: '海报/活动.poster.json' })).designPath).toBe('海报/活动.poster.json');
    expect(posterReceipt(true, receipt({ designPath: '过长'.repeat(300) + '.poster.json' })).designPath).toBeUndefined();
  });

  it('无字底图成功不能代替海报；局部失败保留可用源文件且不能借旧成功完成', () => {
    const review = createExecutionReview('做一张活动海报，并交可编辑PPTX');
    review.record({ name: 'generate_image', ok: true, output: '已生成图片，保存在 images/bg.png。' });
    expect(review.report().media.state).toBe('not_started');
    review.record({ name: 'make_poster', ok: true, output: receipt() });
    expect(review.report().media.state).toBe('completed');
    expect(review.report().pendingFormats).toEqual([]);
    review.record({ name: 'make_poster', ok: true, output: receipt({ status: 'partial', files: files.slice(1), errors: [{ code: 'POSTER_PNG' }] }) });
    expect(review.report().media).toMatchObject({ state: 'partial', files: ['海报/活动.svg', '海报/活动.pptx'] });
    expect(reviewOutcome(review.report()).outcome).toBe('partial');
    expect(review.guidance()).toMatch(/保留已生成底图和源文件/);
    expect(review.completeDelivery([{ text: '交付文件', status: 'todo' }], '海报/活动.pptx')).toBeNull();
    review.revise('修改海报标题为“春日活动”');
    expect(review.report().media.state).toBe('not_started');
    expect(review.report().pendingFormats).toContain('pptx');
  });

  it('海报SVG不走架构业务核验；生成成功不能宣称视觉通过或绝对无错字', () => {
    const review = createExecutionReview('做一张活动海报');
    review.artifact({ path: '海报/活动.svg', validation: { kind: 'poster', format: 'svg', readback: 'passed', structure: 'passed', visual: 'not_checked' } });
    review.record({ name: 'make_poster', ok: true, output: receipt() });
    expect(review.guidance()).not.toContain('架构图');
    expect(review.guardsAnswer()).toBe(true);
    expect(review.checkAnswer('已通过视觉验收，保证没有错字。')).toHaveLength(2);
    expect(review.checkAnswer('已生成PNG、SVG和PPTX；视觉尚未验收，不保证绝对无错字。')).toEqual([]);
    expect(posterAnswerIssues('已通过视觉验收。', posterReceipt(true, receipt({ visual: 'passed' })))).toEqual([]);
    const diagram = createExecutionReview('画一张架构图');
    diagram.artifact({ path: '图/架构.svg', validation: { format: 'svg', readback: 'passed', visual: 'not_checked' } });
    expect(diagram.guidance()).toContain('架构图按实际回执交付');
  });

  it.each(['做一张春日活动海报，同时给可编辑PPTX', '生成一张图片，用代码写上黑体字春日活动'])('真实主循环依次底图和排字，模型替身不冒充视觉实测：%s', async userText => {
    let calls = 0;
    const invoked = [];
    const selected = [];
    const adapter = { async stream({ system, tools, onText }) {
      calls++;
      expect(JSON.stringify(system)).toContain(POSTER_GUIDANCE);
      selected.push(tools.map(tool => tool.name));
      if (calls === 1) return { text: '', toolCalls: [{ id: 'bg', name: 'generate_image', args: { prompt: '春日活动无字底图，不要任何文字' } }], stop: 'tool_use' };
      if (calls === 2) return { text: '', toolCalls: [{ id: 'poster', name: 'make_poster', args: { title: '春日活动', background_path: 'images/bg.png' } }], stop: 'tool_use' };
      const text = '已生成海报/活动.png、海报/活动.svg、海报/活动.pptx。视觉尚未验收。';
      onText(text);
      return { text, toolCalls: [], stop: 'end_turn' };
    } };
    const tool = (name, run) => ({ name, description: name, input_schema: { type: 'object', properties: {} }, run });
    const tools = [tool('generate_image', async () => { invoked.push('generate_image'); return '已生成图片，保存在 images/bg.png。'; }), tool('make_poster', async args => { invoked.push('make_poster'); expect(args.background_path).toBe('images/bg.png'); return receipt(); }), ...['run_python', 'render_diagram', ...Array.from({ length: 25 }, (_, i) => `other_${i}`)].map(name => tool(name, async () => { throw new Error('不应绕路'); }))];
    const result = await runAgent({ adapter, model: 'fixture', userText, history: [], tools, context: { dynamic: '' }, emit: () => {}, quiet: true });
    expect(invoked).toEqual(['generate_image', 'make_poster']);
    expect(selected[0]).toContain('make_poster');
    expect(selected[0]).not.toContain('run_python');
    expect(selected[0]).not.toContain('render_diagram');
    expect(result.text).toContain('海报/活动.png');
    expect(result.text).not.toContain('部分完成');
  });
});
