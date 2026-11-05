/** 保存操作绑定开始编辑时的账号与连接；晚到结果不能写入另一账号的界面缓存。 */
import * as registry from '../agent/agentProfiles.js';
import { validateProfile } from '../agent/agentProfileValidation.js';
import { userStorageSuffix } from '../core/userStorage.js';

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
        starters: [fields.starter0, fields.starter1, fields.starter2]
      });
      const saved = original ? await api.updateAgent(original.id, value) : await api.createAgent(value);
      check(token);
      return saved;
    },
    async remove(original, token) {
      check(token);
      await api.removeAgent(original.id);
      check(token);
    }
  };
}
