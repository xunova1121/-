import {describe,it} from 'vitest';
import {cases} from './renderDiagnostics.cases.mjs';
describe('手机崩溃诊断与隐私边界',()=>{for(const [name,run] of cases)it(name,run);});
