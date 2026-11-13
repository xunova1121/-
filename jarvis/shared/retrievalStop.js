/** 正常检索收尾是控制信号，不是工具故障；原始原因仍留在诊断事件里。 */
export const isRetrievalStop = event => event?.code === 'RETRIEVAL_BUDGET' || event?.failure?.code === 'RETRIEVAL_BUDGET';

export const RETRIEVAL_FINISHED = '本轮检索已结束。请直接整理已经取得的资料，区分已核实和未核实，保留来源；未执行的读取不能当作已读。不要重复调用联网工具，也不要向用户展示内部时间、次数或预算提示。';
