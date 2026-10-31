/**
 * 网关用的智能体：共享实现（shared/agents.js）+ Node 侧的本机指标与环境变量。
 */
import { ClaudeAgent as BaseClaudeAgent, MockAgent as BaseMockAgent, sanitizeHistory } from '../shared/agents.js';
import { collectMetrics } from './metrics.mjs';

export { sanitizeHistory };

export class ClaudeAgent extends BaseClaudeAgent {
  constructor(opts = {}) {
    super({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.JARVIS_MODEL || 'claude-opus-5-5',
      metrics: collectMetrics,
      ...opts
    });
  }
}

export class MockAgent extends BaseMockAgent {
  constructor(opts = {}) {
    super({ metrics: collectMetrics, ...opts });
  }
}
