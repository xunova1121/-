import {it,expect} from 'vitest';
import {layoutDiagram} from '../src/agent/diagramModel.js';
import {architectureRoutes} from '../src/agent/architectureRouting.js';
import {labelBox,boxesOverlap,routeHitsBox} from '../src/agent/architectureRouteLabels.js';
function model(type){return layoutDiagram({title:'双向业务关系',semanticRouting:true,view:'workflow',design:{theme:'gov-blue'},layers:[{title:'业务应用',role:'application',kind:'cards',nodes:[{id:'a',title:'任务调度',detail:'派发任务',icon:'clipboard-check'},{id:'b',title:'现场处置',detail:'提交反馈',icon:'clipboard-check'}]}],edges:[{from:'a',to:'b',type:'workflow',label:'签收处置'},{from:'b',to:'a',type,label:'现场结果反馈'}]});}
it('同排任务与反向反馈保留各自箭头和标签，反馈绕行不与任务共线重叠',()=>{
 const value=model('feedback');const routes=architectureRoutes(value);
 expect(routes).toHaveLength(2);
 expect(routes[0].points).toHaveLength(2);
 expect(routes[1].points.length).toBeGreaterThan(2);
 expect(routes.map(item=>item.label)).toEqual(['签收处置','现场结果反馈']);
 expect(boxesOverlap(labelBox(routes[0].labelPosition),labelBox(routes[1].labelPosition))).toBe(false);
 for(const route of routes)for(const node of value.nodes)expect(boxesOverlap(labelBox(route.labelPosition),node)).toBe(false);
 for(const route of routes)for(const other of routes.filter(item=>item!==route))expect(other.points.some((point,index)=>index&&routeHitsBox(other.points[index-1],point,labelBox(route.labelPosition)))).toBe(false);
});
it('双向数据线也分开路线，不因同类型而覆盖对方标签',()=>{
 const value=model('dataflow');value.edges[0].type='dataflow';
 const routes=architectureRoutes(value);
 expect(routes.every(item=>item.labelPosition)).toBe(true);
 expect(routes[1].path).not.toBe(routes[0].path);
 expect(boxesOverlap(labelBox(routes[0].labelPosition),labelBox(routes[1].labelPosition))).toBe(false);
});
