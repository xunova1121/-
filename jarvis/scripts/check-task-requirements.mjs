// 核心回归不依赖 npm 包，网络受限时也能运行；同一组用例同时纳入 Vitest 全量回归。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases } from '../tests/taskRequirements.cases.mjs';
for (const [name, run] of cases) test(name, () => run(assert));
