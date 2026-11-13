import { describe, it } from 'vitest';
import { cases } from './mascotVoice.cases.mjs';
describe('小精灵、拍照与温柔童声', () => {
  for (const [name, run] of cases) it(name, run);
});
