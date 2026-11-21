import { describe, it, expect } from 'vitest';
import { visualSceneRequest, visualSceneReceipt, visualSceneAnswerIssues, VISUAL_SCENE_GUIDANCE } from '../src/agent/visualSceneRouting.js';
import { textPosterRequest, POSTER_GUIDANCE } from '../src/agent/posterRouting.js';
import { mediaRequirement, mediaReceipt } from '../src/agent/actionDelivery.js';
import { taskContract } from '../src/agent/taskContract.js';
import { taskToolCore } from '../src/agent/taskToolProfile.js';
import { CORE, createToolLoader } from '../src/agent/toolLoader.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { reviewOutcome } from '../src/agent/reviewOutcome.js';
import { runAgent } from '../src/agent/agent.js';
import { AGENT_SKILLS } from '../src/agent/agentSkills.js';
import { MORE_BUILTIN_SKILLS } from '../src/agent/skillCatalog.js';

const files = ['png', 'svg', 'html'].map(format => ({ format, path: `视觉/气象.${format}`, readback: 'passed', structure: 'passed', render: format === 'png' ? 'passed' : 'not_checked' }));
const receipt = (overrides = {}) => JSON.stringify({ kind: 'visual_demo', status: 'complete', width: 3840, height: 2160, files, designPath: '视觉/气象.visual.json', textRendering: 'program', fontCheck: 'passed', visual: 'not_checked', interaction: 'not_checked', dataMode: 'demo', notes: [], errors: [], ...overrides });
const tool = (name, run = async () => '') => ({ name, description: name, input_schema: { type: 'object', properties: {} }, run });

describe('同稿高清海报与交互Demo路由', () => {
  it.each([
    '做一张高清气象数据大屏，附交互Demo', '生成复杂数据大屏', '设计气象驾驶舱', '制作天气仪表盘', '制作气象数据大屏海报，只要PNG',
    '做海报，同时给同设计交互Demo', '制作海报，提供可点击的网页演示', '给已有海报补一个Demo',
    '用视觉/气象.visual.json补一个离线HTML演示', '修改视觉/气象.visual.json的主标题', '给海报/活动.poster.json补Demo，不重新生成底图',
    '无需重新生成底图，给已有海报补交互Demo'
  ])('专用视觉任务可直接进入工具：%s', text => {
    expect(visualSceneRequest(text)).toBe(true);
    expect(mediaRequirement(text)).toMatchObject({ kind: 'visual_demo', tool: 'create_visual_demo' });
    expect(textPosterRequest(text)).toBe(false);
    expect(taskToolCore({ category: 'code' }, text).has('create_visual_demo')).toBe(true);
    expect(taskContract(text).coding).toBe(false);
  });

  it.each([
    '制作中文活动海报，标题准确', '生成图片，用代码写上黑体字', '生成一张无字风景图片',
    '开发一个普通网页应用，提供代码', '开发一个程序，给图片写上黑体字', '只给数据大屏的源码',
    '画一张系统架构图', '制作海报，不要交互Demo，只要PNG', '怎么制作气象驾驶舱',
    '帮我写数据大屏提示词', '不要生成气象大屏', '不用制作海报交互Demo', '修改海报/活动.poster.json标题，不要Demo', '不要修改视觉/气象.visual.json'
  ])('原有海报/网页/架构及拒绝制作保持边界：%s', text => {
    expect(visualSceneRequest(text)).toBe(false);
    expect(mediaRequirement(text)?.kind).not.toBe('visual_demo');
  });

  it('纯海报仍make_poster，普通网页开发保留代码合约', () => {
    expect(mediaRequirement('制作中文活动海报')).toMatchObject({ kind: 'poster', tool: 'make_poster' });
    expect(taskContract('开发一个网页应用，提供代码').coding).toBe(true);
    expect(mediaRequirement('画一张系统架构图').tool).toBe('create_diagram');
    expect(taskContract('制作海报并给交互网页Demo').criteria.join('；')).toContain('.poster.json');
    expect(taskContract('制作海报并给交互网页Demo').criteria.join('；')).not.toContain('实际执行环境');
  });

  it('长schema按任务加载，少量工具也可发现而不默认全露', async () => {
    expect(CORE.has('create_visual_demo')).toBe(false);
    const tools = ['read_file', 'create_visual_demo', 'make_poster', 'generate_image', 'run_python', 'create_diagram'].map(name => tool(name));
    const ordinary = createToolLoader(tools, { core: taskToolCore({}, '今天几点') });
    expect(ordinary.isActive('create_visual_demo')).toBe(false);
    expect(ordinary.hint()).toContain('create_visual_demo');
    expect(ordinary.list().some(item => item.name === 'read_file')).toBe(true);
    await ordinary.get('tool_search').run({ names: ['create_visual_demo'] });
    expect(ordinary.isActive('create_visual_demo')).toBe(true);
    const scoped = taskToolCore({}, '做一张气象数据大屏', { images: [{}] });
    expect(scoped.has('create_visual_demo')).toBe(true);
    expect(scoped.has('make_poster')).toBe(false);
    const many = createToolLoader([...tools, ...Array.from({ length: 25 }, (_, i) => tool(`other_${i}`))], { core: scoped });
    expect(many.isActive('create_visual_demo')).toBe(true);
    expect(many.isActive('run_python')).toBe(false);
    expect(many.isActive('create_diagram')).toBe(false);
    expect(many.get('create_diagram').name).toBe('create_diagram');
  });

  it('专业技能明确同源Demo和真实检查边界', () => {
    for (const text of [AGENT_SKILLS['poster-designer'], MORE_BUILTIN_SKILLS.find(item => item.title === '生成图片').text]) {
      expect(text).toContain('create_visual_demo');
      expect(text).toContain('make_poster');
      expect(text).toContain('.poster.json');
      expect(text).toContain('4K');
      expect(text).toContain('实时');
    }
  });

  it('最小三格式真实读回和PNG渲染/字体通过才完整，ZIP可选', () => {
    expect(visualSceneReceipt(true, receipt())).toMatchObject({ state: 'completed', files: files.map(file => file.path), designPath: '视觉/气象.visual.json', visual: 'not_checked', interaction: 'not_checked', dataMode: 'demo' });
    expect(visualSceneReceipt(true, receipt({ files: [...files, { format: 'zip', path: '视觉/气象.zip', readback: 'passed', structure: 'passed', render: 'not_checked' }] })).state).toBe('completed');
    expect(mediaReceipt('create_visual_demo', true, receipt()).state).toBe('completed');
    expect(visualSceneReceipt(true, '已生成 视觉/气象.png 视觉/气象.svg 视觉/气象.html')).toMatchObject({ state: 'pending', files: [] });
    for (const overrides of [
      { kind: 'poster' }, { status: 'generated' }, { status: 'partial' }, { width: 0 }, { height: 0 }, { textRendering: 'model' },
      { fontCheck: 'generated' }, { fontCheck: 'not_checked' }, { designPath: '视觉/气象.poster.json' }, { designPath: null }, { dataMode: 'live' },
      { errors: [{ code: 'VISUAL_HTML' }] }, { files: files.slice(0, 2) }, { files: files.slice(1) },
      { files: files.map(file => file.format === 'png' ? { ...file, render: 'generated' } : file) },
      { files: files.map(file => file.format === 'html' ? { ...file, readback: 'not_checked' } : file) },
      { files: files.map(file => file.format === 'svg' ? { ...file, structure: 'failed' } : file) },
      { files: files.map(file => file.format === 'html' ? { ...file, path: '视觉/气象.png' } : file) }
    ]) expect(visualSceneReceipt(true, receipt(overrides)).state, JSON.stringify(overrides)).not.toBe('completed');
    expect(visualSceneReceipt(false, receipt())).toMatchObject({ state: 'failed', files: [] });
    expect(visualSceneReceipt(true, receipt({ visual: 'generated', interaction: 'generated' }))).toMatchObject({ visual: 'not_checked', interaction: 'not_checked' });
  });

  it('底图或旧海报回执不能替代Demo，最近失败不借用上次成功', () => {
    const review = createExecutionReview('制作一张海报并给交互Demo');
    review.record({ name: 'generate_image', ok: true, output: '已生成图片，保存在 images/bg.png。' });
    review.record({ name: 'make_poster', ok: true, output: JSON.stringify({ kind: 'poster', status: 'complete' }) });
    expect(review.report().media.state).toBe('not_started');
    review.record({ name: 'create_visual_demo', ok: true, output: receipt() });
    expect(review.report().media.state).toBe('completed');
    review.artifact({ path: '视觉/气象.svg', validation: { kind: 'visual_demo', format: 'svg', readback: 'passed', structure: 'passed', visual: 'not_checked' } });
    expect(review.guidance()).not.toContain('架构图');
    review.record({ name: 'create_visual_demo', ok: true, output: receipt({ status: 'partial', files: files.slice(0, 2), errors: [{ code: 'VISUAL_HTML' }] }) });
    expect(review.report().media).toMatchObject({ state: 'partial', files: ['视觉/气象.png', '视觉/气象.svg'] });
    expect(reviewOutcome(review.report()).outcome).toBe('partial');
    expect(review.guidance()).toContain('失败不自动重画');
    expect(review.completeDelivery([{ text: '交付文件', status: 'todo' }], '视觉/气象.png')).toBeNull();
    review.revise('修改海报标题');
    expect(review.report().media.state).toBe('not_started');
  });

  it('另要Word说明时仍独立核对文档回执，不要求视觉工具输出Office', () => {
    const review = createExecutionReview('制作气象数据大屏，并另外制作Word说明文档');
    review.record({ name: 'create_visual_demo', ok: true, output: receipt() });
    expect(review.report().pendingFormats).toEqual(['docx']);
    review.artifact({ path: '视觉/说明.docx', validation: { format: 'docx', readback: 'passed', structure: 'passed', errors: 0 } });
    expect(review.report().pendingFormats).toEqual([]);
  });

  it('生成不冒充视觉/交互验收、实时数据或底图原生4K', () => {
    const review = createExecutionReview('制作数据大屏，附交互Demo');
    review.record({ name: 'create_visual_demo', ok: true, output: receipt() });
    expect(review.guardsAnswer()).toBe(true);
    expect(review.checkAnswer('已通过视觉验收。交互测试通过。已接入真实实时数据。底图是原生4K。保证没有错字。')).toHaveLength(5);
    expect(review.checkAnswer('PNG、SVG和HTML已生成。视觉尚未验收，交互尚未验收。使用示例数据，未接入实时数据。输出3840×2160，不代表底图原生4K。')).toEqual([]);
    expect(visualSceneAnswerIssues('已接入实时数据。', visualSceneReceipt(true, receipt({ dataMode: 'provided' })))).toHaveLength(1);
    expect(visualSceneAnswerIssues('已通过视觉验收。交互测试通过。', visualSceneReceipt(true, receipt({ visual: 'passed', interaction: 'passed' })))).toEqual([]);
  });

  it('真实主循环调用专用工具，固定模型替身不冒充实际视觉验收', async () => {
    let calls = 0;
    let executions = 0;
    const adapter = { async stream({ system, tools, onText }) {
      calls++;
      expect(JSON.stringify(system)).toContain(VISUAL_SCENE_GUIDANCE);
      expect(JSON.stringify(system)).not.toContain(POSTER_GUIDANCE);
      expect(tools.map(item => item.name)).toContain('create_visual_demo');
      if (calls === 1) return { text: '', toolCalls: [{ id: 'visual', name: 'create_visual_demo', args: { source_path: '海报/活动.poster.json' } }], stop: 'tool_use' };
      const text = '已生成视觉/气象.png、视觉/气象.svg和视觉/气象.html。视觉与交互尚未验收，使用示例数据。';
      onText(text);
      return { text, toolCalls: [], stop: 'end_turn' };
    } };
    const result = await runAgent({ adapter, model: 'fixture', userText: '给海报/活动.poster.json补交互Demo', history: [], tools: [tool('create_visual_demo', async args => { executions++; expect(args.source_path).toBe('海报/活动.poster.json'); return receipt(); })], context: { dynamic: '' }, emit: () => {}, quiet: true });
    expect(executions).toBe(1);
    expect(calls).toBeLessThanOrEqual(3);
    expect(result.text).toContain('视觉/气象.html');
    expect(result.text).not.toContain('部分完成');
  });
});
