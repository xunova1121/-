import { describe, it } from 'vitest';
import { cases } from './renderHealth.cases.mjs';
describe('手机渲染稳定性与有界历史', () => { for (const [name, run] of cases) it(name, run); });
