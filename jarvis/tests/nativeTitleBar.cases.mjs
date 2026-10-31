import assert from 'node:assert/strict';
import {compositeTitleBar,createTitleBarSync} from '../src/ui/nativeTitleBar.js';
export const cases=[
 ['原生标题栏默认与白色工作台一致',()=>{assert.deepEqual(compositeTitleBar('#FFFFFF',''),{color:'#FFFFFF',symbolColor:'#72727D',height:32});}],
 ['陪伴遮罩按实际透明度混色，不再留下白色窗口按钮',()=>{assert.equal(compositeTitleBar('#FFFFFF','rgba(40, 36, 61, 0.4392156863)').color,'#A19FAA');}],
 ['深色遮罩改用浅色原生按钮图标',()=>{const result=compositeTitleBar('rgb(255, 255, 255)','rgba(16, 19, 34, 0.74)');assert.equal(result.color,'#4E505B');assert.equal(result.symbolColor,'#FFFFFF');}],
 ['弹窗打开与关闭会同步颜色，同色不反复调用原生接口',async()=>{
   const seen=[];let backdrop='';const sync=createTitleBarSync({setTitleBar:async value=>seen.push(value),getColors:()=>({base:'#FFFFFF',backdrop})});
   await sync();await sync();backdrop='rgba(40, 36, 61, 0.4392156863)';await sync();backdrop='';await sync();assert.deepEqual(seen.map(x=>x.color),['#FFFFFF','#A19FAA','#FFFFFF']);
 }],
 ['原生标题栏调用失败后允许重试',async()=>{let attempts=0;const sync=createTitleBarSync({setTitleBar:async()=>{if(++attempts===1)throw Error('not ready');},getColors:()=>({base:'#FFFFFF'})});await sync();await sync();assert.equal(attempts,2);}]
];
