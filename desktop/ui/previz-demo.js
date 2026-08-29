import { previzPanel } from './previz-canvas.js';
import { normalizeStage, addKeyframe } from './previz-stage.js';

const stage = normalizeStage({
  cam:{name:'主摄影机',x:0,y:-5.5,height:1.65,lens:50,aperture:2.8},
  backdrop:{name:'旧城街口'},
  subjects:[
    {name:'林默',x:-1.1,y:.1,height:1.78,facing:170,pose:'fight',action:'缓慢拔刀',assetRef:'林默'},
    {name:'黑衣追兵',x:1.15,y:1.25,height:1.82,facing:205,pose:'walk',action:'向前逼近',assetRef:'黑衣追兵'}
  ],
  marks:[{name:'木箱',x:-2.5,y:1.7,height:.85,width:1.1,assetRef:'木箱'},{name:'路灯',x:2.7,y:.3,height:2.8,width:.35,assetRef:'路灯'}],
  lights:[
    {name:'冷色主光',lightType:'spot',x:-3,y:-.8,height:4,intensity:2.6,color:'#79b8ff'},
    {name:'暖色轮廓光',lightType:'point',x:2.8,y:2.2,height:2.6,intensity:1.8,color:'#ffad62'}
  ]
});
addKeyframe(stage,0);
stage.subjects[0].x=-.3; stage.subjects[0].y=.9; stage.cam.y=-4.4; stage.lights[0].intensity=3.2; addKeyframe(stage,60);
stage.subjects[0].x=.35; stage.subjects[0].y=1.25; stage.cam.x=.6; stage.cam.lens=65; addKeyframe(stage,120);
const assets=[
  {kind:'character',ref:'林默',name:'林默',variantId:'default'},{kind:'character',ref:'黑衣追兵',name:'黑衣追兵',variantId:'default'},
  {kind:'scene',ref:'旧城街口',name:'旧城街口',variantId:'default'},
  {kind:'prop',ref:'木箱',name:'木箱',variantId:'default'},{kind:'prop',ref:'路灯',name:'路灯',variantId:'default'}
];
document.querySelector('#demo').append(previzPanel(stage,{size:760,duration:5,scene:'旧城街口',assets}).node);
