/* ================= 江苏渔业智慧平台 · 一张图 =================
   平台级总览：核心指标 + 六防态势 + 九大业务能力 + 平台能力架构。
   所有数字取自 demo 后端的 ModuleWorkspace.data 与 page.tsx，未另造数据。
   右上角「进入工作区」进入 demo；业务卡片可直接进对应模块。 */
var OM = {
  kpi: [
    ["接入渔船","3,268","艘","目标 3,200","blue"],
    ["海上作业","2,146","艘","65.7% 在航","cyan"],
    ["今日预警","38","条","6 条待处置","orange"],
    ["设备在线率","98.7","%","较昨日 +0.3%","green"],
    ["链路平均时延","386","ms","卫星 / 5G 自适应","purple"]
  ],
  defense: [
    ["防大风","风",3,"阵风 9 级","orange"], ["防碰撞","撞",2,"CPA < 0.5nm","red"],
    ["防侧翻","倾",1,"横倾 18.6°","red"],  ["防漏水","水",1,"舱底高水位","orange"],
    ["防火灾","火",0,"烟温正常","green"],  ["防中毒","气",1,"CO 32ppm","orange"]
  ],
  alerts: [
    ["紧急","疑似脱编","苏盐渔 05168","射阳港东南 42 海里","09:17"],
    ["紧急","驾驶舱离岗 7 分钟","苏连渔 01832","燕尾港东北 28 海里","09:03"],
    ["重要","商渔碰撞风险","苏通渔 03277","吕四港外航道","08:41"],
    ["重要","船员配员不符","苏盐渔 07215","滨海港出港口","08:28"],
    ["提示","卫星链路波动","苏连渔 02690","前三岛东 61 海里","07:56"]
  ],
  /* 九大业务能力：指标取自各模块 metrics 首两项 */
  modules: [
    { n:"综合态势", i:"◈", d:"六防监管一张图 · 位置/视频/姿态/环境/告警/执法联动",
      m:[["接入渔船","3,268 艘"],["海上作业","2,146 艘"]],
      f:["雷达 + 双光谱协同","编组“226”校验","电子围栏与禁捕区"] },
    { n:"智能预警", i:"△", d:"六防 AI 预警 · 自动派单 · 闭环处置",
      m:[["今日预警","38 条"],["平均响应","46 秒"]],
      f:["视频行为识别","六防传感器融合","法规规则匹配"] },
    { n:"视频监控", i:"▣", d:"船端 4-8 路 · AI 感知压缩 · 时空水印取证",
      m:[["视频在线","12,704"],["AI 分析通道","8,432"]],
      f:["离岗/救生衣/烟火识别","船端30天·平台90天","截图录像哈希固证"] },
    { n:"港航监管", i:"⌘", d:"进出港报告核验 · 红黄绿码 · 最低配员",
      m:[["今日出港","186 艘"],["电子围栏","36 处"]],
      f:["渔船码 绿3118/黄126/红24","船员证书到期预警","18 港区 AI 抓拍"] },
    { n:"执法办案", i:"▤", d:"线上核查—证据固定—线下处置闭环",
      m:[["在办案件","47 件"],["电子证据","318 份"]],
      f:["时间戳+GPS+视频哈希","电子检查单与签名","跨部门线索移交"] },
    { n:"应急指挥", i:"✣", d:"多方会商 · 力量调度 · 求救响应",
      m:[["应急事件","3 起"],["指令时延","18 秒"]],
      f:["12 席位 3 部门在线","执法船8·编组互助12","台风/海浪/风暴潮"] },
    { n:"数据研判", i:"⌁", d:"风险趋势 · 专题研判 · 数据交换",
      m:[["数据总量","18.6 TB"],["轨迹记录","4.7 亿"]],
      f:["违规高发海域热力","异常停留关联分析","接口 13 类 99.6%"] },
    { n:"设备运维", i:"⚙", d:"船载终端实时运维 · 远程诊断与升级",
      m:[["终端在线","98.7%"],["待处理故障","43 个"]],
      f:["远程升级成功率99.2%","备件 终端32/摄像头86","响应<60分 恢复<4h"] },
    { n:"共享流量池", i:"◉", d:"卫星 / 5G 自适应调度 · 费用管控",
      m:[["本月用量","96.4 TB"],["异常用量","8 艘"]],
      f:["近岸5G 远海卫星","应急任务不限额","闲时断点续传"] }
  ],
  /* 运行概览：page.tsx 下半部分与各模块 summary */
  run: [
    ["当前编组","842"], ["编组渔船","2,387"], ["异常脱编","6"],
    ["配员合规率","96.8%"], ["视频在线","12,704 路"], ["电子围栏","36 处"]
  ],
  /* 平台能力架构：自下而上 */
  arch: [
    { n:"应用层", c:"九大业务应用 · 省市县三级贯通", v:"9 大模块" },
    { n:"数据层", c:"结构化180天 · 视频90天 · 苏渔安/海事/气象/自然资源", v:"18.6 TB" },
    { n:"网络层", c:"卫星 42.7TB · 5G 53.7TB · 共享流量池调度", v:"386 ms" },
    { n:"感知层", c:"船载终端 · 摄像头 · 六防传感器 · 渔港 AI 抓拍", v:"3,268 终端" }
  ],
  foot: [
    ["信创环境","麒麟 OS · 达梦数据库"],
    ["平台可用率","99.98%"],
    ["数据刷新","每 60 秒"],
    ["接口交换","13 类 · 成功率 99.6%"]
  ]
};

function omEsc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function omMarkup(){
  var s='<div class="om-root">';
  /* 顶栏 */
  s+='<div class="om-head">'
    +'<div class="om-logo">苏</div>'
    +'<div class="om-title"><div class="om-h1">江苏渔业智慧平台 · 一张图</div>'
      +'<div class="om-sub">海洋渔船“宽带入海” · 省级监管驾驶舱 · 感知 / 网络 / 数据 / 应用全链路</div></div>'
    +'<div class="om-live"><i></i>全省数据实时接入　<b>2026-08-25 09:26</b></div>'
    +'<button type="button" class="om-enter" data-om="enter">进入工作区 <span>→</span></button>'
  +'</div>';

  /* 核心指标条 */
  s+='<div class="om-kpis">';
  OM.kpi.forEach(function(k){
    s+='<div class="om-kpi '+k[4]+'"><span>'+omEsc(k[0])+'</span>'
      +'<b>'+omEsc(k[1])+'<em>'+omEsc(k[2])+'</em></b>'
      +'<small>'+omEsc(k[3])+'</small></div>';
  });
  s+='</div>';

  s+='<div class="om-body">';

  /* 左栏：六防态势 + 实时告警 */
  s+='<div class="om-left">';
  s+='<div class="om-box"><div class="om-h3">六防态势<span>8 项风险</span></div><div class="om-def">';
  OM.defense.forEach(function(d){
    s+='<div class="om-d '+d[4]+'"><i>'+omEsc(d[1])+'</i>'
      +'<div><b>'+omEsc(d[0])+'</b><small>'+omEsc(d[3])+'</small></div>'
      +'<em>'+(d[2]?d[2]+' 艘':'正常')+'</em></div>';
  });
  s+='</div></div>';
  s+='<div class="om-box om-grow"><div class="om-h3">实时告警<span>6 条待处置</span></div><div class="om-alerts">';
  OM.alerts.forEach(function(a){
    s+='<div class="om-a"><i class="'+(a[0]==='紧急'?'lv1':a[0]==='重要'?'lv2':'lv3')+'"></i>'
      +'<div><b>'+omEsc(a[1])+'</b><small>'+omEsc(a[2])+' · '+omEsc(a[3])+'</small></div>'
      +'<span class="om-t">'+omEsc(a[4])+'</span></div>';
  });
  s+='</div></div></div>';

  /* 中栏：九大业务能力 */
  s+='<div class="om-mid"><div class="om-box om-full">'
    +'<div class="om-h3">九大业务能力<span>点击卡片直接进入对应工作区</span></div>'
    +'<div class="om-mods">';
  OM.modules.forEach(function(m){
    s+='<button type="button" class="om-mod" data-om="mod" data-mod="'+omEsc(m.n)+'">'
      +'<div class="om-mod-h"><i>'+omEsc(m.i)+'</i><b>'+omEsc(m.n)+'</b><u>进入 →</u></div>'
      +'<p>'+omEsc(m.d)+'</p>'
      +'<div class="om-mod-f">'
        + m.f.map(function(x){ return '<span>'+omEsc(x)+'</span>'; }).join('')
      +'</div>'
      +'<div class="om-mod-m">'
        + m.m.map(function(x){ return '<div><span>'+omEsc(x[0])+'</span><b>'+omEsc(x[1])+'</b></div>'; }).join('')
      +'</div></button>';
  });
  s+='</div></div></div>';

  /* 右栏：平台能力架构 */
  s+='<div class="om-right">';
  s+='<div class="om-box"><div class="om-h3">运行概览<span>全省实时</span></div><div class="om-run">';
  OM.run.forEach(function(r){
    s+='<div><span>'+omEsc(r[0])+'</span><b>'+omEsc(r[1])+'</b></div>';
  });
  s+='</div></div>';
  s+='<div class="om-box om-full">'
    +'<div class="om-h3">平台能力架构<span>自下而上贯通</span></div><div class="om-arch">';
  OM.arch.forEach(function(a,i){
    s+='<div class="om-layer" style="--i:'+i+'"><div class="om-layer-h"><b>'+omEsc(a.n)+'</b>'
      +'<em>'+omEsc(a.v)+'</em></div><p>'+omEsc(a.c)+'</p></div>';
    if(i<OM.arch.length-1) s+='<div class="om-flow"><i style="animation-delay:'+(i*0.3).toFixed(1)+'s"></i></div>';
  });
  s+='</div></div></div>';

  s+='</div>';   /* /om-body */

  /* 底栏 */
  s+='<div class="om-foot">';
  OM.foot.forEach(function(f){ s+='<div><span>'+omEsc(f[0])+'</span><b>'+omEsc(f[1])+'</b></div>'; });
  s+='<div class="om-foot-hint">数据来源：苏渔安 · 海事 · 气象 · 自然资源</div>';
  s+='</div></div>';
  return s;
}

/* ---------- 挂载与进出 ---------- */
var omWrap=null, omBack=null;
function omOpen(){
  if(omWrap){ omWrap.classList.remove('om-out'); return; }
  omWrap=document.createElement('div');
  omWrap.className='om-wrap';
  omWrap.innerHTML=omMarkup();
  document.body.appendChild(omWrap);
  omWrap.addEventListener('click',function(e){
    var t=e.target.closest('[data-om]'); if(!t) return;
    if(t.dataset.om==='enter') omEnter(null);
    else if(t.dataset.om==='mod') omEnter(t.dataset.mod);
  });
  document.addEventListener('keydown',omKey);
}
function omEnter(mod){
  if(!omWrap) return;
  omWrap.classList.add('om-out');
  setTimeout(function(){
    if(omWrap){ omWrap.remove(); omWrap=null; }
    document.removeEventListener('keydown',omKey);
    if(mod) omGoModule(mod);
    omBackBtn();
  },320);
}
/* 进入指定模块：复用页面左侧导航，不另起一套路由 */
function omGoModule(name){
  var btn=[].filter.call(document.querySelectorAll('aside nav button'),function(b){
    return b.textContent.indexOf(name)>=0;      /* 含图标与角标，取包含匹配 */
  })[0];
  if(btn) btn.click();
}
function omBackBtn(){
  if(omBack&&document.body.contains(omBack)) return;
  omBack=document.createElement('button');
  omBack.type='button'; omBack.className='om-back';
  omBack.innerHTML='<span>←</span> 平台一张图';
  omBack.addEventListener('click',function(){
    omBack.remove(); omBack=null; omOpen();
  });
  document.body.appendChild(omBack);
}
function omKey(e){ if(e.key==='Enter'||e.key==='Escape') omEnter(null); }

/* 首屏即一张图；等 React 挂上再插，避免被首次渲染顶掉 */
function omBoot(){
  if(document.querySelector('.shell')) omOpen();
  else setTimeout(omBoot,120);
}
omBoot();
