/** 每轮只切换一次，最多四次升级后的主请求；仍受原任务时间/步骤预算，不追加预算。 */
export const UPGRADE_CALLS = 4;
export function createCapabilityUpgrade({ routes = [], intent, signal, emit }) {
  let used = false, pending = null, blocked = false, visual = false, workObserved = false;
  const blockers = new Set();
  return {
    observe(results) {
      for (const result of results) {
        if (result.outImages?.length) visual = true;
        if (result.c.name === 'request_capable_model') continue;
        if (result.failure) {
          const error = result.failure;
          const cannotUpgrade = ['network', 'timeout', 'api'].includes(error.kind) || ['AbortError', 'TimeoutError'].includes(error.name) || error.status >= 400 || /^(?:NOT_APPROVED|TASK_SCOPE|RETRIEVAL|LOOKUP|NO_MARKET_DATA|EACCES|ENOENT|ENOTFOUND|ECONN)/.test(error.code || '');
          if (cannotUpgrade) blockers.add(result.c.name);
          else blockers.delete(result.c.name);
        } else if (result.ok) blockers.delete(result.c.name);
        if (/^(?:write_file|edit_file|code_|create_document|write_long_document|write_professional_document)/.test(result.c.name)) workObserved = true;
      }
      blocked = blockers.size > 0;
      if (blocked || visual) pending = null;
    },
    take() { const next = pending; pending = null; return next; },
    tool: routes.length ? {
      name: 'request_capable_model',
      description: '当前任务确实需要更强的编程/推理能力时，切到用户已配置的能力模型继续；一轮最多切一次、升级后最多4次请求，不加总预算。网络、鉴权、缺环境、未授权和空搜索结果不能靠换模型解决。简单聊天无需使用。',
      input_schema: { type: 'object', properties: {
        task: { type: 'string', enum: routes.map(route => route.task) },
        reason: { type: 'string', enum: ['task_complexity', 'verification_failed'] }
      }, required: ['task', 'reason'], additionalProperties: false },
      run: async ({ task, reason }) => {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (used) return '本轮已使用过能力切换；不能反复切换或追加预算。';
        if (visual) return '本轮已读取图片，继续使用现有看图线路，不切到未验证看图能力的模型。';
        if (blocked) return '最近失败属于接口、连接、权限或环境问题；先解决真实原因，不升级模型。';
        if (intent?.category === 'chat' && !workObserved) return '当前是普通对话，没有需要升级的工作证据；保持当前模型。';
        const next = routes.find(route => route.task === task);
        if (!next || !['task_complexity', 'verification_failed'].includes(reason)) return '没有可用的已配置能力线路。';
        used = true;
        pending = next;
        emit?.({ type: 'diagnostic', phase: 'capability_upgrade', model: next.model, task, reason, maxCalls: UPGRADE_CALLS });
        return `已申请切换到配置的 ${next.model}，本批工具没有接口或权限故障时才生效，以实际模型记录为准。保留本轮要求和工具回执，不重启任务，不重做已成功操作。升级后的主模型请求最多${UPGRADE_CALLS}次。`;
      }
    } : null
  };
}
