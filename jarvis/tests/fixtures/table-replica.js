/** 按用户照片结构手工标注的合成验收表；非真实模型识别回执，不含用户手写姓名。 */
export function attendanceReplica() {
  const columns=[52,128,112,70,...Array(31).fill(30),52,52];
  const rows=[46,36,36,19,19,...Array(22).fill(28),42,42];
  const cells=[];
  const add=(r,c,text,rs=1,cs=1,extra={})=>cells.push({r,c,rs,cs,text,role:'printed',font:22,...extra});
  add(1,1,'项目组人员考勤表',1,37,{font:32,border:'none'});
  add(2,1,'考勤地点：项目组办公室',1,25,{align:'left'});
  add(2,26,'考勤月份：2025年12月',1,12,{align:'right'});
  add(3,1,'项目名称：表格还原验收用模拟工程——综合管理平台标段',1,37,{align:'left'});
  ['序号','姓名','职务','时间',...Array.from({length:31},(_,i)=>String(i+1))].forEach((text,i)=>add(4,i+1,text,2));
  add(4,36,'合计',1,2); add(5,36,'出勤',1,1,{font:18}); add(5,37,'请假',1,1,{font:18});
  for(let i=0;i<11;i++) {
    const r=6+i*2;
    add(r,1,String(i+1),2); add(r,2,i<2?'测试人员'+(i+1):'',2,1,{role:'name'}); add(r,3,'',2);
    add(r,4,'上午'); add(r+1,4,'下午'); add(r,36,'',2); add(r,37,'',2);
    if(i<2) {add(r,5,'√',1,1,{role:'mark'});add(r+1,5,'×',1,1,{role:'mark'});}
  }
  add(28,1,'承建单位项目负责人：',1,14,{align:'left'});
  add(28,15,'监理单位确认：',1,11,{align:'left'});
  add(28,26,'备注：',1,12,{align:'left'});
  add(29,1,'注：“√”出勤　“×”缺勤　“△”请假　“—”外出',1,37,{border:'none',align:'left'});
  return {title:'项目组人员考勤表',columns,rows,grid:{r:2,c:1,rs:27,cs:37},cells,corners:[[0.02,0.02],[0.98,0.02],[0.98,0.98],[0.02,0.98]],uncertain:[]};
}
export const FRAME_REQUEST='那个图片生成一样的excel表格，里面的名字和对勾留空，只留框架';
