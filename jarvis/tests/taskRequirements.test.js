import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { cases } from './taskRequirements.cases.mjs';

describe('需求原文与可恢复的上下文压缩', () => {
  for (const [name, run] of cases) it(name, () => run(assert));
});
