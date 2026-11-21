/** 流程图引擎各种 kind 的中文样例（测试与样图共用） */
export const FLOW_KIND_SAMPLES = {
  tree: { title: '年度目标分解', kind: 'tree', nodes: [{ id: 'g', text: '营收增长30%' }, { id: 'a', text: '新开12家店' }, { id: 'b', text: '老店提升客单价' }, { id: 'a1', text: '华东8家' }, { id: 'a2', text: '华南4家' }, { id: 'b1', text: '套餐升级' }, { id: 'b2', text: '会员复购' }],
    edges: [{ from: 'g', to: 'a' }, { from: 'g', to: 'b' }, { from: 'a', to: 'a1' }, { from: 'a', to: 'a2' }, { from: 'b', to: 'b1' }, { from: 'b', to: 'b2' }] },
  org: { title: '公司组织架构', kind: 'org', nodes: [{ id: 'ceo', text: '总经理', focus: true }, { id: 'ops', text: '运营中心' }, { id: 'fin', text: '财务部' }, { id: 'tech', text: '技术部' }, { id: 's1', text: '门店运营' }, { id: 's2', text: '供应链' }, { id: 't1', text: '研发组' }, { id: 't2', text: '数据组' }],
    edges: [{ from: 'ceo', to: 'ops' }, { from: 'ceo', to: 'fin' }, { from: 'ceo', to: 'tech' }, { from: 'ops', to: 's1' }, { from: 'ops', to: 's2' }, { from: 'tech', to: 't1' }, { from: 'tech', to: 't2' }] },
  state: { title: '订单状态', kind: 'state', nodes: [{ id: 's', text: '开始', type: 'start' }, { id: 'p', text: '待支付' }, { id: 'paid', text: '已支付' }, { id: 'ship', text: '已发货' }, { id: 'done', text: '已完成', type: 'end' }, { id: 'cancel', text: '已取消', type: 'end' }],
    edges: [{ from: 's', to: 'p', label: '下单' }, { from: 'p', to: 'paid', label: '付款成功' }, { from: 'p', to: 'cancel', label: '超时30分钟' }, { from: 'paid', to: 'ship', label: '仓库出库' }, { from: 'ship', to: 'done', label: '确认收货' }] },
  steps: { title: '新员工入职五步', kind: 'steps', nodes: [{ id: 'a', text: '签合同' }, { id: 'b', text: '领设备开账号' }, { id: 'c', text: '岗前培训' }, { id: 'd', text: '跟岗学习' }, { id: 'e', text: '转正考核' }] },
  loop: { title: '会员增长飞轮', kind: 'loop', center: '会员增长', nodes: [{ id: 'a', text: '优惠吸引新客' }, { id: 'b', text: '消费得积分' }, { id: 'c', text: '积分换权益' }, { id: 'd', text: '满意后分享' }, { id: 'e', text: '带来新会员' }] }
};
