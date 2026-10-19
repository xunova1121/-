import {describe,it} from 'vitest';
import {cases} from './nativeTitleBar.cases.mjs';
describe('Windows 原生标题栏与弹窗遮罩',()=>{for(const [name,run]of cases)it(name,run);});
