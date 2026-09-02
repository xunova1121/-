/* ================= 江苏渔业智慧平台 · 一张图 =================
   整屏 GIS 大地图 + 浮层面板。地图样式对齐参考图：
   夜光陆地肌理、海岸辉光、圆形禁捕区与核心禁捕区、带标注的渔船、
   执法船艇、视频监控与 AIS 基站浮标、流动虚线航线、底部图例、缩放控件。
   右上角「进入工作区 →」进 demo。 */

var OM = {
  kpi: [
    ["接入渔船","3,268","艘","blue"],
    ["海上作业","2,146","艘","cyan"],
    ["今日预警","38","条","orange"],
    ["设备在线率","98.7","%","green"],
    ["链路时延","386","ms","purple"]
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
  /* 运行概况（page.tsx 下半部分与各模块 summary） */
  run: [
    ["当前编组","842"], ["编组渔船","2,387"], ["异常脱编","6"],
    ["配员合规率","96.8%"], ["视频在线","12,704 路"], ["电子围栏","36 处"]
  ],
  /* 平台能力架构：自下而上 */
  arch: [
    { n:"应用层", v:"9 大模块", c:"九大业务应用 · 省市县三级贯通" },
    { n:"数据层", v:"18.6 TB", c:"结构化180天 · 视频90天 · 轨迹 4.7 亿" },
    { n:"网络层", v:"386 ms",  c:"卫星 42.7TB · 5G 53.7TB · 流量池调度" },
    { n:"感知层", v:"3,268 终端", c:"摄像头 12,704 · 六防传感器 · 渔港抓拍" }
  ],
  /* 智能预警（AIWarningWorkspace） */
  ai: {
    engine:"边缘模型 3,225 实例 · 云端研判集群 12 节点",
    metrics:[["今日扫描帧","328,760"],["模型推理次数","8,421,320"],
             ["平均推理时延","82 ms"],["识别准确率","94.8%"]],
    events:[
      ["防碰撞","苏盐渔05168","CPA 降至 0.38nm","紧急"],
      ["驾驶舱值守","苏连渔01832","连续 7 分钟未检测到人员","紧急"],
      ["防侧翻","苏盐渔05168","横倾角持续 18.6°","紧急"],
      ["未穿救生衣","苏通渔03277","甲板作业人员 2 名","重要"],
      ["异常轨迹","苏盐渔07215","疑似违规作业停留","重要"],
      ["防中毒","苏连渔02690","机舱 CO 浓度 32ppm","重要"]
    ]
  },
  /* 九大业务能力（ModuleWorkspace.data，指标取前两项） */
  modules: [
    { n:"综合态势", i:"◈", m:[["接入渔船","3,268 艘"],["海上作业","2,146 艘"]] },
    { n:"智能预警", i:"△", m:[["今日预警","38 条"],["平均响应","46 秒"]] },
    { n:"视频监控", i:"▣", m:[["视频在线","12,704"],["AI 通道","8,432"]] },
    { n:"港航监管", i:"⌘", m:[["今日出港","186 艘"],["电子围栏","36 处"]] },
    { n:"执法办案", i:"▤", m:[["在办案件","47 件"],["电子证据","318 份"]] },
    { n:"应急指挥", i:"✣", m:[["应急事件","3 起"],["指令时延","18 秒"]] },
    { n:"数据研判", i:"⌁", m:[["数据总量","18.6 TB"],["轨迹记录","4.7 亿"]] },
    { n:"设备运维", i:"⚙", m:[["终端在线","98.7%"],["待处理故障","43 个"]] },
    { n:"共享流量池", i:"◉", m:[["本月用量","96.4 TB"],["异常用量","8 艘"]] }
  ],
  /* 重点功能：实景图取自页面内嵌照片，见 gen-shots.py */
  shots: [
    { k:"watch",   t:"驾驶舱值守识别", d:"连续离岗 7 分钟自动告警" },
    { k:"collide", t:"商渔防碰撞预警", d:"航迹融合 · CPA < 0.5nm" },
    { k:"enforce", t:"海上执法处置",   d:"就近调度 · 指令时延 18 秒" },
    { k:"board",   t:"登临检查取证",   d:"电子检查单 · 船端签名" }
  ]
};

/* ---------- 地图要素（经纬度） ---------- */
var OMAP = {
  view: { latTop:35.25, latSpan:4.45, anchorLon:121.45, stretch:1.22 },
  /* 圆形禁捕区：中心 + 半径(km) */
  circles: [
    { ll:[122.55,34.55], r:40, n:"禁捕区" },
    { ll:[122.70,33.18], r:40, n:"禁捕区" }
  ],
  /* 核心禁捕区：近岸多边形 */
  core: { n:"核心禁捕区",
    p:[[121.28,33.92],[121.72,33.98],[121.92,33.70],[121.74,33.40],[121.32,33.36],[121.10,33.64]] },
  /* 渔船：船名 / 航速 / 航向 */
  boats: [
    { id:"苏启渔01234", ll:[121.62,34.86], kn:12.5, cog:135 },
    { id:"苏启渔05678", ll:[123.35,34.20], kn:9.3,  cog:218 },
    { id:"苏启渔08888", ll:[122.02,33.78], kn:8.7,  cog:302 },
    { id:"苏启渔09999", ll:[123.30,33.05], kn:11.2, cog:145 },
    { id:"苏启渔07777", ll:[123.12,32.16], kn:10.1, cog:75  }
  ],
  /* 执法船艇 */
  patrol: [
    { id:"中国渔政32568", ll:[121.95,34.42] },
    { id:"中国渔政32601", ll:[122.70,32.62] }
  ],
  /* 浮标：视频监控 / AIS 基站 */
  buoys: [
    { ll:[121.38,34.62], t:"cam" }, { ll:[122.28,34.72], t:"ais" },
    { ll:[121.52,33.98], t:"ais" }, { ll:[122.95,33.62], t:"cam" },
    { ll:[121.70,33.10], t:"cam" }, { ll:[122.42,32.86], t:"ais" },
    { ll:[122.06,32.42], t:"cam" }, { ll:[122.98,31.98], t:"ais" },
    { ll:[121.30,32.66], t:"ais" }
  ],
  /* 航线：折点串，绘成流动虚线 */
  routes: [
    [[121.62,34.86],[121.95,34.55],[122.20,34.20],[122.05,33.86]],
    [[123.35,34.20],[123.00,34.00],[122.80,33.70],[122.98,33.40],[123.28,33.12]],
    [[123.30,33.05],[122.92,32.84],[122.58,32.60],[122.30,32.30]],
    [[123.12,32.16],[122.80,32.40],[122.52,32.72],[122.60,33.02]],
    [[122.02,33.78],[122.38,33.62],[122.72,33.40]]
  ]
};

function omEsc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
/* 公里 → 像素（按纬度方向，避免横向压缩带来的失真） */
function omKm(k){ return k/110.9*proj.ky; }

/* ---------- 地图绘制 ---------- */
function omMapSvg(w,h){
  var keep={latTop:VIEW.latTop,latSpan:VIEW.latSpan,anchorLon:VIEW.anchorLon,stretch:VIEW.stretch};
  VIEW.latTop=OMAP.view.latTop; VIEW.latSpan=OMAP.view.latSpan;
  VIEW.anchorLon=OMAP.view.anchorLon; VIEW.stretch=OMAP.view.stretch;
  proj=buildProj(w,h);
  placed=[]; reserved=[];
  /* 左右浮层压住的区域不放地名 */
  var PANEL_L=310, PANEL_R=290;
  function underPanel(x){ return x<PANEL_L || x>w-PANEL_R; }
  var s='<svg class="om-map-svg" viewBox="0 0 '+w+' '+h+'">'+defs()+omDefs();

  /* 底图：海面 → 海岸辉光 → 陆地 → 城市灯光 → 水网 → 湖泊 → 夜光肌理 */
  var land=smooth(GEO.coast,true);
  s+='<rect class="rg-sea-deep" x="0" y="0" width="'+w+'" height="'+h+'"/>';
  s+='<path class="rg-halo" d="'+land+'" stroke-width="16" opacity=".06"/>';
  s+='<path class="rg-halo" d="'+land+'" stroke-width="7" opacity=".13"/>';
  s+='<path class="rg-land" d="'+land+'"/>';
  GEO.glows.forEach(function(g){
    var p=P([g[0],g[1]]);
    s+='<circle class="rg-citylight" cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="'+omKm(g[2]*1.9).toFixed(1)+'"/>';
  });
  if(GEO.yangtze) s+='<path class="rg-yangtze" d="'+smooth(GEO.yangtze,true)+'"/>';
  GEO.islands.forEach(function(is){ s+='<path class="rg-island" d="'+smooth(is,true)+'"/>'; });
  GEO.rivers.concat(GEO.omRivers||[]).forEach(function(r){
    s+='<path class="rg-river" style="stroke-width:'+r.w+'" d="'+smooth(r.p,false)+'"/>';
  });
  GEO.lakes.forEach(function(l){ s+='<path class="rg-lake" d="'+smooth(l,true)+'"/>'; });
  /* 夜光肌理：整屏大图才铺，小图上是噪点 */
  var lakePx=GEO.lakes.map(function(l){ return l.map(P); });
  function inLake(x,y){
    for(var q=0;q<lakePx.length;q++){
      var pts=lakePx[q], c=false;
      for(var a=0,bq=pts.length-1;a<pts.length;bq=a++){
        var u=pts[a], v=pts[bq];
        if((u[1]>y)!==(v[1]>y) && x < (v[0]-u[0])*(y-u[1])/(v[1]-u[1])+u[0]) c=!c;
      }
      if(c) return true;
    }
    return false;
  }
  var dots='';
  var N=Math.max(600,Math.min(4200,Math.round(w*h/320)));
  for(var i=0;i<N;i++){
    var dx=rnd(i+1)*w, dy=rnd(i+97.3)*h;
    if(!inLand(dx,dy)||inLake(dx,dy)) continue;
    dots+='<circle cx="'+dx.toFixed(1)+'" cy="'+dy.toFixed(1)+'" r="'
      +(0.45+rnd(i+13.7)*1.5).toFixed(2)+'" opacity="'+(0.16+rnd(i+31.1)*0.62).toFixed(2)+'"/>';
  }
  s+='<g class="om-settle">'+dots+'</g>';
  s+='<path class="om-shelf" d="'+land+'"/>';

  /* 地名 */
  GEO.labels.forEach(function(l){
    if(l.c!=='rg-prov') return;
    var p=P(l.ll);
    if(p[0]<40||p[0]>w-40||p[1]<40||p[1]>h-40||underPanel(p[0])) return;
    s+='<text class="om-prov" text-anchor="middle" x="'+p[0].toFixed(0)+'" y="'+p[1].toFixed(0)+'">'+omEsc(l.t)+'</text>';
  });
  GEO.cities.forEach(function(c){
    var p=P(c.ll);
    if(p[0]<20||p[0]>w-20||p[1]<20||p[1]>h-20||underPanel(p[0])) return;
    s+='<circle class="om-city-dot" cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="2.6"/>'
      +'<text class="om-city" text-anchor="middle" x="'+p[0].toFixed(0)+'" y="'+(p[1]-9).toFixed(0)+'">'+omEsc(c.n)+'</text>';
  });
  s+='<text class="om-sea" text-anchor="middle" x="'+(proj.x(123.6)).toFixed(0)+'" y="'+(proj.y(34.9)).toFixed(0)+'">黄　海</text>';

  /* 禁捕区 */
  OMAP.circles.forEach(function(z){
    var p=P(z.ll), r=omKm(z.r);
    s+='<circle class="om-zone" cx="'+p[0].toFixed(0)+'" cy="'+p[1].toFixed(0)+'" r="'+r.toFixed(0)+'"/>'
      +'<text class="om-zone-t" text-anchor="middle" x="'+p[0].toFixed(0)+'" y="'+(p[1]+5).toFixed(0)+'">'+omEsc(z.n)+'</text>';
  });
  var cp=P(OMAP.core.p[0]), cx=0, cy=0;
  OMAP.core.p.forEach(function(q){ var e=P(q); cx+=e[0]; cy+=e[1]; });
  cx/=OMAP.core.p.length; cy/=OMAP.core.p.length;
  s+='<path class="om-zone om-core" d="'+poly(OMAP.core.p,true)+'"/>'
    +'<text class="om-zone-t om-core-t" text-anchor="middle" x="'+cx.toFixed(0)+'" y="'+(cy+5).toFixed(0)+'">'
    +omEsc(OMAP.core.n)+'</text>';

  /* 航线 */
  OMAP.routes.forEach(function(r,i){
    var d=smooth(r,false);
    s+='<path class="om-route-b" d="'+d+'"/>'
      +'<path class="om-route" style="animation-delay:'+(-i*0.4).toFixed(1)+'s" d="'+d+'"/>';
    /* 航线上的方向箭标 */
    for(var k=1;k<r.length;k++){
      var a=P(r[k-1]), b=P(r[k]);
      var mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2;
      var ang=Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI;
      s+='<path class="om-arrow" transform="translate('+mx.toFixed(1)+','+my.toFixed(1)+') rotate('+ang.toFixed(0)+')"'
        +' d="M-4 -3.4 L5 0 L-4 3.4 L-2 0 Z"/>';
    }
  });

  /* 浮标：视频监控 / AIS 基站 */
  OMAP.buoys.forEach(function(bo){
    var p=P(bo.ll);
    s+='<g class="om-buoy '+bo.t+'" transform="translate('+p[0].toFixed(1)+','+p[1].toFixed(1)+')">'
      +'<use href="#omBuoy"/></g>';
  });

  /* 执法船艇 */
  OMAP.patrol.forEach(function(v){
    var p=P(v.ll);
    s+='<g class="om-patrol" transform="translate('+p[0].toFixed(1)+','+p[1].toFixed(1)+')">'
      +'<use href="#omPatrol"/></g>';
  });

  /* 渔船 + 标注 */
  OMAP.boats.forEach(function(bt){
    var p=P(bt.ll);
    s+='<g class="om-boat" transform="translate('+p[0].toFixed(1)+','+p[1].toFixed(1)+')">'
      +'<circle class="om-boat-halo" r="15"/><use href="#omBoat"/></g>';
    var right = p[0] < w*0.75, lx = right ? 16 : -16, an = right ? 'start' : 'end';
    s+='<g class="om-lab" transform="translate('+p[0].toFixed(1)+','+p[1].toFixed(1)+')">'
      +'<line class="om-lab-l" x1="'+(right?10:-10)+'" y1="-6" x2="'+(lx-(right?2:-2))+'" y2="-18"/>'
      +'<text class="om-lab-n" text-anchor="'+an+'" x="'+lx+'" y="-22">'+omEsc(bt.id)+'</text>'
      +'<text class="om-lab-v" text-anchor="'+an+'" x="'+lx+'" y="-10">'+bt.kn.toFixed(1)+'kn</text>'
      +'<text class="om-lab-v" text-anchor="'+an+'" x="'+lx+'" y="1">航向 '
      +('00'+bt.cog).slice(-3)+'°</text></g>';
  });

  s+='</svg>';
  VIEW.latTop=keep.latTop; VIEW.latSpan=keep.latSpan;
  VIEW.anchorLon=keep.anchorLon; VIEW.stretch=keep.stretch;
  return s;
}
function omDefs(){
  return '<defs>'
    +'<linearGradient id="omLand" x1="0.1" y1="0" x2="1" y2="1">'
      +'<stop offset="0" stop-color="#1e5878"/><stop offset=".5" stop-color="#14415e"/>'
      +'<stop offset="1" stop-color="#0c2c44"/></linearGradient>'
    +'<linearGradient id="omSea" x1="0" y1="0" x2="0.6" y2="1">'
      +'<stop offset="0" stop-color="#04203a"/><stop offset="1" stop-color="#01070e"/></linearGradient>'
    +'<pattern id="omHatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
      +'<line x1="0" y1="0" x2="0" y2="7" stroke="#4fe4fa" stroke-width="1.2" stroke-opacity=".34"/></pattern>'
    +'<symbol id="omBoat" viewBox="-12 -9 24 18" width="24" height="18" x="-12" y="-9">'
      +'<path d="M-9 3 L9 3 L6.5 7 L-6.5 7 Z" fill="#eafcff"/>'
      +'<path d="M-6 -1 H5 L7 2.4 H-8 Z" fill="#9fe8ff"/>'
      +'<path d="M-2 -6 H3 L4 -1 H-3 Z" fill="#eafcff"/>'
      +'<path d="M0 -6 V-8.5" stroke="#eafcff" stroke-width="1"/></symbol>'
    +'<symbol id="omPatrol" viewBox="-13 -10 26 20" width="26" height="20" x="-13" y="-10">'
      +'<path d="M-10 3 L10 3 L7 8 L-7 8 Z" fill="#7ff0ff"/>'
      +'<path d="M-7 -2 H6 L8.5 2 H-9 Z" fill="#cbf4ff"/>'
      +'<path d="M-3 -7 H4 L5 -2 H-4 Z" fill="#ffffff"/>'
      +'<circle cx="6" cy="-4" r="1.5" fill="#ff5f6b"/>'
      +'<path d="M0 -7 V-9.5" stroke="#cbf4ff" stroke-width="1"/></symbol>'
    +'<symbol id="omBuoy" viewBox="-8 -10 16 20" width="16" height="20" x="-8" y="-10">'
      +'<path d="M-5.5 5 H5.5 L4 8 H-4 Z" fill="currentColor" opacity=".85"/>'
      +'<path d="M-3.5 -1 H3.5 L4.6 4.4 H-4.6 Z" fill="currentColor"/>'
      +'<circle cx="0" cy="-4.5" r="2.4" fill="currentColor"/>'
      +'<path d="M0 -7 V-9" stroke="currentColor" stroke-width="1.1"/></symbol>'
    +'</defs>';
}

/* ---------- 页面结构 ---------- */
function omMarkup(){
  var s='<div class="om-root">';

  s+='<div class="om-head">'
    +'<div class="om-logo">苏</div>'
    +'<div class="om-title"><div class="om-h1">江苏渔业智慧平台 · 一张图</div>'
      +'<div class="om-sub">海洋渔船“宽带入海” · 省级监管驾驶舱</div></div>'
    +'<div class="om-live"><i></i>全省数据实时接入　<b>2026-08-25 09:26</b></div>'
    +'<button type="button" class="om-enter" data-om="enter">进入工作区 <span>→</span></button>'
  +'</div>';

  /* 核心指标 */
  s+='<div class="om-kpis">';
  OM.kpi.forEach(function(k){
    s+='<div class="om-kpi '+k[3]+'"><span>'+omEsc(k[0])+'</span>'
      +'<b>'+omEsc(k[1])+'<em>'+omEsc(k[2])+'</em></b></div>';
  });
  s+='</div>';

  s+='<div class="om-body">';

  /* 左：六防态势 + 智能预警 */
  s+='<div class="om-col om-l">';
  s+='<div class="om-card"><div class="om-h3">六防态势<span>8 项风险</span></div><div class="om-def">';
  OM.defense.forEach(function(d){
    s+='<div class="om-d '+d[4]+'"><i>'+omEsc(d[1])+'</i>'
      +'<div><b>'+omEsc(d[0])+'</b><small>'+omEsc(d[3])+'</small></div>'
      +'<em>'+(d[2]?d[2]+' 艘':'正常')+'</em></div>';
  });
  s+='</div></div>';
  s+='<div class="om-card om-grow"><div class="om-h3">智能预警<span>AI 监管引擎运行中</span></div>'
    +'<div class="om-ai-m">';
  OM.ai.metrics.forEach(function(m){
    s+='<div><span>'+omEsc(m[0])+'</span><b>'+omEsc(m[1])+'</b></div>';
  });
  s+='</div><div class="om-ai-e">';
  OM.ai.events.forEach(function(e){
    s+='<div class="om-ae '+(e[3]==='紧急'?'lv1':'lv2')+'"><i></i>'
      +'<div><b>'+omEsc(e[0])+'</b><small>'+omEsc(e[1])+' · '+omEsc(e[2])+'</small></div>'
      +'<em>'+omEsc(e[3])+'</em></div>';
  });
  s+='</div></div></div>';

  /* 中：地图 + 重点功能 */
  s+='<div class="om-col om-c">';
  s+='<div class="om-card om-mapcard"><div class="om-h3">全省海洋渔船六防监管一张图'
    +'<span>位置 · 视频 · 姿态 · 环境 · 告警 · 执法联动</span></div>'
    +'<div class="om-map"></div></div>';
  s+='<div class="om-card om-shotcard"><div class="om-h3">重点功能<span>实景演示</span></div>'
    +'<div class="om-shots">';
  OM.shots.forEach(function(sh){
    s+='<div class="om-shot"><div class="om-shot-img">'
      +'<img alt="'+omEsc(sh.t)+'" src="data:image/jpeg;base64,'+SHOT_B64[sh.k]+'"/>'
      +'<span class="om-shot-t">'+omEsc(sh.t)+'</span></div>'
      +'<small>'+omEsc(sh.d)+'</small></div>';
  });
  s+='</div></div></div>';

  /* 右：运行概况 + 平台能力 + 实时告警 */
  s+='<div class="om-col om-r">';
  s+='<div class="om-card"><div class="om-h3">运行概况<span>全省实时</span></div><div class="om-run">';
  OM.run.forEach(function(r){
    s+='<div><span>'+omEsc(r[0])+'</span><b>'+omEsc(r[1])+'</b></div>';
  });
  s+='</div></div>';
  s+='<div class="om-card"><div class="om-h3">平台能力架构<span>自下而上贯通</span></div><div class="om-arch">';
  OM.arch.forEach(function(a,i){
    s+='<div class="om-layer"><div class="om-layer-h"><b>'+omEsc(a.n)+'</b><em>'+omEsc(a.v)+'</em></div>'
      +'<p>'+omEsc(a.c)+'</p></div>';
    if(i<OM.arch.length-1) s+='<div class="om-flow"><i style="animation-delay:'+(i*0.3).toFixed(1)+'s"></i></div>';
  });
  s+='</div></div>';
  s+='<div class="om-card om-grow"><div class="om-h3">实时告警<span>6 条待处置</span></div><div class="om-alerts">';
  OM.alerts.forEach(function(a){
    s+='<div class="om-a"><i class="'+(a[0]==='紧急'?'lv1':a[0]==='重要'?'lv2':'lv3')+'"></i>'
      +'<div><b>'+omEsc(a[1])+'</b><small>'+omEsc(a[2])+' · '+omEsc(a[3])+'</small></div>'
      +'<span class="om-t">'+omEsc(a[4])+'</span></div>';
  });
  s+='</div></div></div>';

  s+='</div>';   /* /om-body */

  /* 九大业务能力 */
  s+='<div class="om-card om-modbar"><div class="om-h3">九大业务能力'
    +'<span>点击卡片直接进入对应工作区</span></div><div class="om-mods">';
  OM.modules.forEach(function(m){
    s+='<button type="button" class="om-mod" data-om="mod" data-mod="'+omEsc(m.n)+'">'
      +'<div class="om-mod-h"><i>'+omEsc(m.i)+'</i><b>'+omEsc(m.n)+'</b></div>'
      +'<div class="om-mod-m">'
      + m.m.map(function(x){ return '<div><b>'+omEsc(x[1])+'</b><span>'+omEsc(x[0])+'</span></div>'; }).join('')
      +'</div><u>进入 →</u></button>';
  });
  s+='</div></div>';

  s+='</div>';
  return s;
}

/* 图例与缩放控件：两种底图下都叠在地图上 */
function omMapOverlay(){
  return '<div class="om-legend">'
    +'<span><u class="lg-patrol"></u>执法船艇</span>'
    +'<span><u class="lg-boat"></u>渔船</span>'
    +'<span><u class="lg-route"></u>航线</span>'
    +'<span><u class="lg-zone"></u>禁捕区</span>'
    +'<span><u class="lg-core"></u>核心禁捕区</span>'
    +'<span><u class="lg-cam"></u>视频监控</span>'
    +'<span><u class="lg-ais"></u>AIS基站</span>'
  +'</div>'
  +'<div class="om-zoom"><button type="button" aria-label="定位">◎</button>'
    +'<button type="button" aria-label="放大">＋</button>'
    +'<button type="button" aria-label="缩小">－</button></div>';
}

/* ---------- 挂载与进出 ---------- */
var omWrap=null, omBack=null, omRO=null;
function omDrawMap(){
  var box=omWrap&&omWrap.querySelector('.om-map');
  if(!box||typeof buildProj!=='function') return;
  var w=Math.max(400,Math.round(box.clientWidth)), h=Math.max(240,Math.round(box.clientHeight));
  /* 放了外部底图就直接用（assets/map.b64），否则回落到矢量图 */
  if(typeof MAP_IMG_B64==='string'&&MAP_IMG_B64){
    box.innerHTML='<img class="om-map-photo" alt="江苏近海监管一张图" '
      +'src="data:image/jpeg;base64,'+MAP_IMG_B64+'"/>'+omMapOverlay();
  } else {
    box.innerHTML=omMapSvg(w,h)+omMapOverlay();
  }
}
function omOpen(){
  if(omWrap){ omWrap.classList.remove('om-out'); return; }
  omWrap=document.createElement('div');
  omWrap.className='om-wrap';
  omWrap.innerHTML=omMarkup();
  document.body.appendChild(omWrap);
  omDrawMap();
  omWrap.addEventListener('click',function(e){
    var t=e.target.closest('[data-om]'); if(!t) return;
    if(t.dataset.om==='enter') omEnter();
    else if(t.dataset.om==='mod') omEnter(t.dataset.mod);
  });
  document.addEventListener('keydown',omKey);
  if(omRO) omRO.disconnect();
  omRO=new ResizeObserver(function(){
    clearTimeout(omWrap._t); omWrap._t=setTimeout(omDrawMap,180);
  });
  omRO.observe(omWrap);
}
function omEnter(mod){
  if(!omWrap) return;
  omWrap.classList.add('om-out');
  setTimeout(function(){
    if(omRO){ omRO.disconnect(); omRO=null; }
    if(omWrap){ omWrap.remove(); omWrap=null; }
    document.removeEventListener('keydown',omKey);
    if(mod) omGoModule(mod);
    omBackBtn();
  },300);
}
function omBackBtn(){
  if(omBack&&document.body.contains(omBack)) return;
  omBack=document.createElement('button');
  omBack.type='button'; omBack.className='om-back';
  omBack.innerHTML='<span>←</span> 平台一张图';
  omBack.addEventListener('click',function(){ omBack.remove(); omBack=null; omOpen(); });
  document.body.appendChild(omBack);
}
/* 进入指定模块：复用页面左侧导航，不另起路由 */
function omGoModule(name){
  var btn=[].filter.call(document.querySelectorAll('aside nav button'),function(b){
    return b.textContent.indexOf(name)>=0;
  })[0];
  if(btn) btn.click();
}
function omKey(e){ if(e.key==='Enter'||e.key==='Escape') omEnter(); }
function omBoot(){
  if(document.querySelector('.shell')) omOpen();
  else setTimeout(omBoot,120);
}
omBoot();
