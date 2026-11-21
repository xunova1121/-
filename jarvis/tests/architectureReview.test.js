import { it, expect, vi } from 'vitest';
import { inspectArchitecture, reviewArchitecture } from '../src/agent/architectureReview.js';
const entity = (id, kind) => ({ id, title: id, kind, inputs: ['事件'], outputs: ['事件'] });
const plan = () => ({
  entities: [entity('app', 'application'), entity('cap', 'capability'), entity('data', 'data'), entity('system', 'system')],
  relations: [],
  requirements: [{ text: '原始需求' }]
});
it('包含环、双重归属、支撑反向与数据/业务混层必须指出，业务闭环不当包含环', () => {
  const value = plan();
  value.relations = [
    { from: 'system', to: 'app', type: 'contains' },
    { from: 'data', to: 'app', type: 'contains' },
    { from: 'app', to: 'cap', type: 'supports' },
    { from: 'app', to: 'data', type: 'workflow' },
    { from: 'app', to: 'system', type: 'contains' }
  ];
  const result = inspectArchitecture(value);
  expect(result.structure).toBe('failed');
  for (const kind of ['ownership', 'dependency', 'classification']) expect(result.issues.some((item) => item.kind === kind)).toBe(true);
  const next = plan();
  next.relations = [
    { from: 'app', to: 'cap', type: 'dataflow' },
    { from: 'cap', to: 'app', type: 'feedback' }
  ];
  expect(inspectArchitecture(next).structure).toBe('passed');
});
it('数据流两端必须有一致的输入输出；缺需求或原文截断不能通过', () => {
  const value = plan();
  value.entities[0].outputs = ['不同的数据'];
  value.relations = [{ from: 'app', to: 'data', type: 'dataflow' }];
  expect(inspectArchitecture(value).issues[0].kind).toBe('flow');
  value.relations = [];
  value.requirements = [];
  expect(inspectArchitecture(value).structure).toBe('failed');
  value.requirements = [{}];
  value.sources = [{ truncated: true, matched: true }];
  expect(inspectArchitecture(value).structure).toBe('failed');
});
it('没有审查模型不冒充语义通过，确定性失败不浪费模型请求', async () => {
  expect((await reviewArchitecture({}, plan())).semantic).toBe('not_checked');
  const value = plan();
  value.requirements = [];
  const llm = vi.fn();
  expect((await reviewArchitecture({ llm }, value)).structure).toBe('failed');
  expect(llm).not.toHaveBeenCalled();
});
it('请求前扣预算，只一次调用；有效意见保留具体对象，非独立模型不声称独立核实', async () => {
  const consume = vi.fn();
  const llm = vi.fn(async (request) => {
    expect(consume).toHaveBeenCalledTimes(1);
    expect(request.maxRetries).toBe(0);
    expect(request.nativeSearch).toBe(false);
    return JSON.stringify({ passed: false, issues: [{ target: 'entity:data', kind: 'classification', detail: '应区分数据资源与数据库软件' }] });
  });
  const result = await reviewArchitecture({ llm }, plan(), { retrieval: { consume } });
  expect(result.semantic).toBe('failed');
  expect(result.issues[0].target).toBe('entity:data');
  expect(llm).toHaveBeenCalledTimes(1);
});
it('无效JSON、空白或非法对象意见不能算通过；停止/预算上抛', async () => {
  for (const answer of ['{}', 'not json', JSON.stringify({ passed: true, issues: [{ target: 'entity:fake', kind: 'flow', detail: '伪对象' }] })])
    expect((await reviewArchitecture({ llm: async () => answer }, plan())).semantic).toBe('not_checked');
  for (const error of [Object.assign(new Error('stop'), { name: 'AbortError' }), Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' })])
    await expect(
      reviewArchitecture(
        {
          llm: async () => {
            throw error;
          }
        },
        plan()
      )
    ).rejects.toBe(error);
});
it('文字声称通过但仍有问题必须失败；空问题失败也不能冒充通过', async () => {
  for (const value of [
    { passed: false, issues: [] },
    { passed: true, issues: [{ target: 'plan', kind: 'ownership', detail: '归属未知' }] }
  ])
    expect((await reviewArchitecture({ llm: async () => JSON.stringify(value) }, plan())).semantic).toBe('failed');
});
it('真实规划入口把语义意见存到带底稿摘要的文件，回执不回传原文', async () => {
  const { createArchitecturePlanTool } = await import('../src/agent/architectureTool.js');
  const workspace = await import('../src/agent/workspace.js');
  const input = {
    title: '虚构闭环',
    entities: [
      { id: 'a', title: '预警', kind: 'application', responsibility: '处理预警', inputs: ['事件'], outputs: ['结果'], source: 'user', excerpt: '建设预警' }
    ],
    relations: [],
    requirements: [{ text: '建设预警', entities: ['a'], source: 'user', excerpt: '建设预警' }]
  };
  const reply = JSON.parse(
    await createArchitecturePlanTool({ llm: async () => JSON.stringify({ passed: true, issues: [] }) }).run(input, { rawRequestText: '建设预警' })
  );
  expect(reply.semantic).toBe('passed');
  const record = JSON.parse(await workspace.readText(reply.reviewPath));
  expect(record.planHash).toMatch(/^(sha256|checksum):/);
  expect(reply).not.toHaveProperty('entities');
  expect(await workspace.readText(reply.relationTablePath)).toContain('业务语义：passed');
});
