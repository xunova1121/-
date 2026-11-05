/** 保存操作绑定开始编辑时的账号与连接；晚到结果不能写入另一账号的界面缓存。 */
import * as registry from '../agent/agentProfiles.js';
import { validateProfile } from '../agent/agentProfileValidation.js';
import { userStorageSuffix } from '../core/userStorage.js';
import * as scheduler from '../agent/scheduler.js';

export function createAgentProfileActions(app, { api = registry, scope = userStorageSuffix } = {}) {
  const capture = () => ({ server: app.server, identity: scope() });
  const check = (token) => {
    if (!token || token.server !== app.server || token.identity !== scope()) {
      throw new Error('账号或连接已切换，请重新打开智能体编辑页。');
    }
  };
  return {
    capture,
    async save(original, fields, token) {
      check(token);
      const base = original || {
        id: `my-${crypto.randomUUID()}`,
        icon: 'spark',
        category: 'mine',
        tools: [],
        form: [],
        output: 'text',
        source: 'user'
      };
      const value = validateProfile({
        ...base,
        name: fields.name,
        intro: fields.intro,
        prompt: fields.prompt,
        starters: [fields.starter0, fields.starter1, fields.starter2],
        // 工作流步骤：空的就不带（旧配置照常可读）
        ...(fields.steps?.length ? { steps: fields.steps } : original?.steps ? { steps: [] } : {})
      });
      // 定时运行：先确认看得懂时间，再保存配置，免得存了配置却没建成定时
      const when = String(fields.when || '').trim();
      const timing = when ? scheduler.parseWhen(when) : null;
      if (when && !timing) throw new Error(`看不懂“${when}”这个时间，可以写“每天8点”“每周五17点”“每30分钟”`);
      const saved = original ? await api.updateAgent(original.id, value) : await api.createAgent(value);
      check(token);
      if (timing) {
        const job = { title: saved.name, prompt: `按「${saved.name}」的工作要求完成本次任务`, agentId: saved.id };
        await (app.server ? app.server.addSchedule({ ...job, when }) : scheduler.upsert({ ...job, ...timing }));
        check(token);
      }
      return saved;
    },
    async remove(original, token) {
      check(token);
      await api.removeAgent(original.id);
      check(token);
    }
  };
}
