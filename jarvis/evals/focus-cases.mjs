import { jointCases } from './joint-cases.mjs';
import { speedQualityCases } from './speed-quality-cases.mjs';

export const focusSuiteVersion = 'focus-delivery-v1';
const from = (id) => structuredClone([...jointCases, ...speedQualityCases].find((item) => item.id === id));
const code = from('joint-28');
/** 独立小批，不替代原30题。四题原样复用，代码续做是另列的新追问题。 */
export const focusCases = [
  from('joint-01'),
  from('speed-quality-02'),
  from('speed-quality-01'),
  from('joint-25'),
  {
    ...code,
    id: 'focus-code-resume',
    sourceCase: code.id,
    category: 'code_resume',
    requires: [...code.requires, 'sandbox'],
    prompt: code.prompt + '本次只在该测试仓库的隔离任务副本验收，不提交、不推送、不合并、不发布；不要触碰其他仓库。',
    followup:
      '沿用刚才同一个工作副本，读回已修改的业务文件，再运行原来的代码检查和测试。不要新建或重新克隆仓库，不要改测试，不要提交、推送或合并；报告同一工作副本编号、两条命令的真实退出码和测试统计。',
    rubric: [
      ...code.rubric,
      '追问沿用同一个工作副本，没有重新克隆或丢失已有修改',
      '没有修改或跳过测试，没有推送或合并',
      '实际重跑原lint和test，报告真实退出码和通过失败数；执行失败如实说明'
    ]
  }
];

export function selectJointCases({ focus = false, supplement = false, only } = {}) {
  if (focus && supplement) throw Object.assign(new Error('重点题集不能与原30题补充模式混合'), { code: 'EVAL_CONFIG' });
  const pool = focus ? focusCases : supplement ? [...jointCases, ...speedQualityCases] : jointCases;
  if (only === undefined || only === null) return pool;
  const ids = only.split(',');
  if (!ids.length || ids.some((id) => !pool.some((item) => item.id === id)))
    throw Object.assign(new Error('指定的评测题号不存在，未提交任务'), { code: 'EVAL_CONFIG' });
  return pool.filter((item) => ids.includes(item.id));
}
