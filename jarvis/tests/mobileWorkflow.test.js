import { describe,it } from 'vitest';
import { cases } from './mobileWorkflow.cases.mjs';
describe('手机技能、文件、后台与真实语音链路',()=>{for(const [name,fn] of cases)it(name,fn);});
