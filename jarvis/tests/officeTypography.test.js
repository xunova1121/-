import { it, expect } from 'vitest';
import { officeTypography } from '../src/agent/officeTypography.js';
import { generate } from '../src/agent/docs.js';
import { measureDocx, relativeTypography, styleRequests, styleReport } from '../src/agent/styleCheck.js';
it('Office明确字号从原话解析，原话覆盖工具参数；默认不增加空样式', () => {
  expect(officeTypography('PPT标题40磅，正文22磅', { body: 16, title: 30 })).toMatchObject({ title: { size: 40 }, body: { size: 22 } });
  expect(officeTypography('Excel正文14磅')).toMatchObject({ body: { size: 14 } });
  expect(officeTypography('')).toEqual({});
  expect(() => officeTypography('', { body: 1000 })).toThrow();
});
it('相对字号按各格式基准换算，别的格式上一稿不污染当前稿', () => {
  const asks = styleRequests('字体大点');
  expect(relativeTypography({}, asks, { format: 'pptx', previous: { format: 'xlsx', body: 11, title: 18 } }).typography).toMatchObject({
    body: { size: 25 },
    title: { size: 40 }
  });
  expect(relativeTypography({}, asks, { format: 'xlsx', previous: { format: 'xlsx', body: 14, title: 20 } }).typography.body.size).toBeGreaterThan(14);
});
it('真实原生PPT文字字号可以读回，不把图表或图片文字冒充已量取', async () => {
  const out = await generate('pptx', {
    title: '字号测试',
    content: '## 业务进展\n\n- 本周完成需求核对。\n- 下周开展接口联调。',
    typography: { body: { size: 22 }, title: { size: 40 } }
  });
  const facts = await measureDocx(out.blob);
  expect(facts).toMatchObject({ format: 'pptx', body: 22, title: 40, rules: null });
  expect(styleReport('字体大点', { format: 'pptx', styleFacts: facts, previousStyle: { format: 'pptx', body: 18, title: 32 } })[0].state).toBe('done');
});
it('真实Excel原生单元格字号读回，公式数据不随字号修改', async () => {
  const out = await generate('xlsx', {
    title: '字号测试',
    content: '| 项目 | 金额 |\n| --- | --- |\n| 研发 | 100 |\n| 测试 | 200 |\n| 合计 | 300 |',
    typography: { body: { size: 14 }, title: { size: 24 } }
  });
  expect(await measureDocx(out.blob)).toMatchObject({ format: 'xlsx', body: 14, title: 24, rules: null });
});
