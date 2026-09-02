/* ================= 江苏渔业智慧平台 · 态势一张图 =================
   指挥大屏版式：顶栏导航 + 左预警栏 + 中部 GIS + 右指标栏 + 底部九大能力。
   图表配色经 dataviz 校验器在本页深色底（#0a2337）上验证：
     预警构成 紧急/重要/提示 #d43a66 / #c98500 / #2f8fd4
       明度带 PASS · 色盲分离 ΔE 12.4 · 常视觉 ΔE 20.0 · 对比度 ≥3:1 全通过
     流量构成 卫星/5G  #3987e5 / #199e70（分类槽 1、3，all-pairs 通过）
   状态色一律「色 + 图标/文字」双编码，不靠颜色单独表意。 */

var VIZ = {
  urgent:"#d43a66", major:"#c98500", info:"#2f8fd4",
  sat:"#3987e5", g5:"#199e70",
  line:"#3fb8d8",
  ok:"#0ca30c", warn:"#c98500", bad:"#d43a66"
};

var OM = {
  nav:["态势一张图","智能预警","执法监管","数据研判","设备运维"],
  /* 运行概况磁贴 */
  tiles:[
    ["接入渔船","3,268","艘","▲"], ["海上作业","2,146","艘","⚓"],
    ["设备在线","98.7","%","◈"],  ["链路时延","386","ms","⇅"]
  ],
  /* 预警信息（page.tsx alerts，补上坐标与区域） */
  alerts:[
    { lv:"紧急", t:"疑似脱编",       ll:'34°47′12″N 120°45′31″E', area:"射阳港东南 42 海里", ship:"苏盐渔 05168", st:"未处置", tm:"09:17" },
    { lv:"紧急", t:"驾驶舱离岗 7 分钟", ll:'34°32′18″N 121°03′46″E', area:"燕尾港东北 28 海里", ship:"苏连渔 01832", st:"处置中", tm:"09:03" },
    { lv:"重要", t:"商渔碰撞风险",   ll:'34°59′23″N 120°50′12″E', area:"吕四港外航道",     ship:"苏通渔 03277", st:"已提醒", tm:"08:41" },
    { lv:"重要", t:"船员配员不符",   ll:'34°28′41″N 121°29′58″E', area:"滨海港出港口",     ship:"苏盐渔 07215", st:"待核验", tm:"08:28" },
    { lv:"提示", t:"卫星链路波动",   ll:'34°19′06″N 120°30′05″E', area:"前三岛东 61 海里", ship:"苏连渔 02690", st:"已恢复", tm:"07:56" }
  ],
  /* 预警构成：今日 38 条，紧急 8 与「六防预警 8」对齐 */
  alertMix:[ ["紧急",8,"urgent"], ["重要",17,"major"], ["提示",13,"info"] ],
  alertChips:[ ["全部",38], ["未处置",6], ["已处置",32] ],
  /* 今日预警趋势：逐两小时，合计 38 */
  trend:[0,1,1,2,3,2,4,5,6,4,5,3,2],
  /* 核心指标达成（均为 demo 内真实口径） */
  gauges:[
    ["设备在线率",98.7], ["预警闭环率",94.7], ["识别准确率",94.8], ["配员合规率",96.8]
  ],
  /* 六防态势 */
  defense:[
    ["防大风","风",3,"阵风 9 级","warn"], ["防碰撞","撞",2,"CPA<0.5nm","bad"],
    ["防侧翻","倾",1,"横倾 18.6°","bad"], ["防漏水","水",1,"舱底高水位","warn"],
    ["防火灾","火",0,"烟温正常","ok"],   ["防中毒","气",1,"CO 32ppm","warn"]
  ],
  /* 平台能力架构 */
  arch:[
    { n:"应用层", v:"9 大模块",   c:"九大业务应用 · 省市县三级贯通" },
    { n:"数据层", v:"18.6 TB",   c:"结构化180天 · 视频90天 · 轨迹 4.7 亿" },
    { n:"网络层", v:"386 ms",    c:"卫星 42.7TB · 5G 53.7TB · 流量池调度" },
    { n:"感知层", v:"3,268 终端", c:"摄像头 12,704 · 六防传感器 · 渔港抓拍" }
  ],
  /* 共享流量池构成（96.4TB = 卫星 42.7 + 5G 53.7） */
  pool:{ total:"96.4", unit:"TB", items:[["卫星链路",42.7,"sat"],["5G 链路",53.7,"g5"]] },
  /* 九大业务能力 */
  modules:[
    { n:"综合态势", i:"◈", m:["3,268 艘","接入渔船"] },
    { n:"智能预警", i:"△", m:["38 条","今日预警"] },
    { n:"视频监控", i:"▣", m:["12,704","视频在线"] },
    { n:"港航监管", i:"⌘", m:["186 艘","今日出港"] },
    { n:"执法办案", i:"▤", m:["47 件","在办案件"] },
    { n:"应急指挥", i:"✣", m:["3 起","应急事件"] },
    { n:"数据研判", i:"⌁", m:["18.6 TB","数据总量"] },
    { n:"设备运维", i:"⚙", m:["98.7%","终端在线"] },
    { n:"共享流量池", i:"◉", m:["96.4 TB","本月用量"] }
  ],
  shots:[
    { k:"watch",   t:"驾驶舱值守识别" }, { k:"collide", t:"商渔防碰撞预警" },
    { k:"enforce", t:"海上执法处置" },   { k:"board",   t:"登临检查取证" }
  ]
};

function omEsc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function omKm(k){ return k/110.9*proj.ky; }

/* ---------- 图表基元 ---------- */
/* 极坐标取点，0° 在 12 点方向，顺时针 */
function pol(cx,cy,r,deg){
  var a=(deg-90)*Math.PI/180;
  return [cx+r*Math.cos(a), cy+r*Math.sin(a)];
}
/* 圆环扇段（甜甜圈用）。相邻扇段间留 2px 表面色缝，符合 marks 规范 */
function arc(cx,cy,rOut,rIn,a0,a1){
  var p1=pol(cx,cy,rOut,a0), p2=pol(cx,cy,rOut,a1),
      p3=pol(cx,cy,rIn,a1),  p4=pol(cx,cy,rIn,a0),
      big=(a1-a0)>180?1:0;
  return 'M'+p1[0].toFixed(2)+' '+p1[1].toFixed(2)
    +'A'+rOut+' '+rOut+' 0 '+big+' 1 '+p2[0].toFixed(2)+' '+p2[1].toFixed(2)
    +'L'+p3[0].toFixed(2)+' '+p3[1].toFixed(2)
    +'A'+rIn+' '+rIn+' 0 '+big+' 0 '+p4[0].toFixed(2)+' '+p4[1].toFixed(2)+'Z';
}
/* 甜甜圈：中心放主数字（hero figure），图例在外，颜色不单独表意 */
function donut(items,total,unit,size){
  var R=size/2, rOut=R-2, rIn=R-13, gap=2.4, acc=0, s='';
  var sum=items.reduce(function(a,b){ return a+b[1]; },0);
  s+='<svg class="om-donut" viewBox="0 0 '+size+' '+size+'" width="'+size+'" height="'+size+'">';
  s+='<circle cx="'+R+'" cy="'+R+'" r="'+((rOut+rIn)/2).toFixed(1)+'" fill="none" '
    +'stroke="#12354a" stroke-width="'+(rOut-rIn)+'"/>';
  items.forEach(function(it){
    var a0=acc/sum*360, a1=(acc+it[1])/sum*360;
    acc+=it[1];
    if(a1-a0>gap) a1-=gap;
    s+='<path d="'+arc(R,R,rOut,rIn,a0,a1)+'" fill="'+VIZ[it[2]]+'"/>';
  });
  s+='<text class="om-donut-v" x="'+R+'" y="'+(R-1)+'" text-anchor="middle">'+omEsc(total)+'</text>';
  s+='<text class="om-donut-u" x="'+R+'" y="'+(R+13)+'" text-anchor="middle">'+omEsc(unit)+'</text>';
  return s+'</svg>';
}
/* 环形仪表：单值达成率，度数即量值 */
function gauge(label,pct,size){
  var R=size/2, r=R-4, C=2*Math.PI*r;
  return '<div class="om-gauge"><svg viewBox="0 0 '+size+' '+size+'" width="'+size+'" height="'+size+'">'
    +'<circle cx="'+R+'" cy="'+R+'" r="'+r+'" fill="none" stroke="#12354a" stroke-width="5"/>'
    +'<circle cx="'+R+'" cy="'+R+'" r="'+r+'" fill="none" stroke="'+VIZ.line+'" stroke-width="5"'
      +' stroke-linecap="round" stroke-dasharray="'+(C*pct/100).toFixed(1)+' '+C.toFixed(1)+'"'
      +' transform="rotate(-90 '+R+' '+R+')"/>'
    +'<text class="om-gauge-v" x="'+R+'" y="'+(R+4)+'" text-anchor="middle">'+pct+'</text>'
    +'</svg><b>'+omEsc(label)+'</b></div>';
}
/* 面积折线：单序列，无需图例，只在峰值直接标注 */
function areaChart(vals,w,h){
  var pad={l:26,r:8,t:10,b:16}, iw=w-pad.l-pad.r, ih=h-pad.t-pad.b;
  var max=Math.max.apply(null,vals), step=iw/(vals.length-1);
  var pts=vals.map(function(v,i){ return [pad.l+i*step, pad.t+ih-(v/max)*ih]; });
  var d=pts.map(function(p,i){ return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1); }).join('');
  var area=d+'L'+pts[pts.length-1][0].toFixed(1)+' '+(pad.t+ih)+'L'+pad.l+' '+(pad.t+ih)+'Z';
  var pi=vals.indexOf(max), pp=pts[pi];
  var s='<svg class="om-line" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" width="100%" height="'+h+'">'
    +'<defs><linearGradient id="omAreaGrad" x1="0" y1="0" x2="0" y2="1">'
    +'<stop offset="0" stop-color="#3fb8d8" stop-opacity=".42"/>'
    +'<stop offset="1" stop-color="#3fb8d8" stop-opacity="0"/></linearGradient></defs>';
  [0,0.5,1].forEach(function(f){
    var y=pad.t+ih*f;
    s+='<line class="om-grid" x1="'+pad.l+'" y1="'+y.toFixed(1)+'" x2="'+(w-pad.r)+'" y2="'+y.toFixed(1)+'"/>';
    s+='<text class="om-tick" x="'+(pad.l-5)+'" y="'+(y+3).toFixed(1)+'" text-anchor="end">'
      +Math.round(max*(1-f))+'</text>';
  });
  s+='<path class="om-area" d="'+area+'"/><path class="om-lined" d="'+d+'"/>';
  s+='<circle class="om-peak" cx="'+pp[0].toFixed(1)+'" cy="'+pp[1].toFixed(1)+'" r="3.2"/>';
  s+='<text class="om-peaklab" x="'+pp[0].toFixed(1)+'" y="'+(pp[1]-7).toFixed(1)+'" text-anchor="middle">'+max+'</text>';
  ['00:00','12:00','24:00'].forEach(function(t,i){
    s+='<text class="om-tick" x="'+(pad.l+iw*i/2).toFixed(1)+'" y="'+(h-3)+'" text-anchor="'
      +(i===0?'start':i===2?'end':'middle')+'">'+t+'</text>';
  });
  return s+'</svg>';
}


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
function omPanel(title,extra,body,cls){
  return '<div class="om-p'+(cls?' '+cls:'')+'"><div class="om-p-h"><b>'+omEsc(title)+'</b>'
    +(extra?'<span>'+omEsc(extra)+'</span>':'')+'</div><div class="om-p-b">'+body+'</div></div>';
}
function omMarkup(){
  var s='<div class="om-root">';

  /* 顶栏 */
  s+='<div class="om-head"><div class="om-brand"><i>苏</i><b>江苏渔业智慧平台</b></div>'
    +'<div class="om-nav">'
    + OM.nav.map(function(n,i){ return '<button type="button" class="'+(i?'':'on')+'">'+omEsc(n)+'</button>'; }).join('')
    +'</div>'
    +'<div class="om-meta"><span class="om-wx">☁ 多云 18~24℃</span><span>江苏省 · 沿海</span>'
      +'<span class="om-clock"><b id="om-time">09:26:14</b><small>2026-08-25</small></span></div>'
    +'<button type="button" class="om-enter" data-om="enter">进入工作区 <span>→</span></button></div>';

  s+='<div class="om-body">';

  /* 左：预警信息 + 预警构成 + 六防 */
  s+='<div class="om-col om-l">';
  var chips = OM.alertChips.map(function(c,i){
    return '<span class="om-chip'+(i?'':' on')+'">'+omEsc(c[0])+' <b>'+c[1]+'</b></span>';
  }).join('');
  var list='<div class="om-chips">'+chips+'</div><div class="om-al">';
  OM.alerts.forEach(function(a){
    var lv = a.lv==='紧急'?'urgent':a.lv==='重要'?'major':'info';
    list+='<div class="om-alert '+lv+'">'
      +'<div class="om-alert-h"><i>'+(a.lv==='提示'?'ℹ':'!')+'</i><b>'+omEsc(a.t)+'</b>'
        +'<em>'+omEsc(a.lv==='紧急'?'高风险':a.lv==='重要'?'中风险':'低风险')+'</em>'
        +'<time>'+omEsc(a.tm)+'</time></div>'
      +'<div class="om-alert-r"><u>⌖</u>'+omEsc(a.ll)+'</div>'
      +'<div class="om-alert-r"><u>◎</u>区域：'+omEsc(a.area)+'</div>'
      +'<div class="om-alert-r"><u>⛵</u>船名：'+omEsc(a.ship)
        +'<s class="'+(a.st==='未处置'?'no':'yes')+'">'+omEsc(a.st)+'</s></div>'
      +'</div>';
  });
  list+='</div>';
  s+=omPanel('预警信息','今日 38 条',list,'om-grow');

  var mix='<div class="om-mix">'+donut(OM.alertMix,'38','总预警',108)+'<div class="om-mix-l">'
    + OM.alertMix.map(function(m){
        return '<div><i style="background:'+VIZ[m[2]]+'"></i><span>'+omEsc(m[0])+'</span><b>'+m[1]+'</b></div>';
      }).join('')
    +'</div></div>';
  s+=omPanel('预警统计（今日）','按风险等级',mix);

  var def='<div class="om-def">'+OM.defense.map(function(d){
    return '<div class="om-d '+d[4]+'"><i>'+omEsc(d[1])+'</i><b>'+omEsc(d[0])+'</b>'
      +'<em>'+(d[2]?d[2]+' 艘':'正常')+'</em><small>'+omEsc(d[3])+'</small></div>';
  }).join('')+'</div>';
  s+=omPanel('六防态势','8 项风险',def);
  s+='</div>';

  /* 中：地图 */
  s+='<div class="om-col om-c">'
    +'<div class="om-p om-mapp"><div class="om-p-h"><b>全省海洋渔船六防监管一张图</b>'
      +'<span>位置 · 视频 · 姿态 · 环境 · 告警 · 执法联动</span></div>'
      +'<div class="om-map"></div></div>'
    +'<div class="om-p om-shotp"><div class="om-p-h"><b>重点功能</b><span>实景演示</span></div>'
      +'<div class="om-shots">'
      + OM.shots.map(function(sh){
          return '<div class="om-shot"><img alt="'+omEsc(sh.t)+'" src="data:image/jpeg;base64,'+SHOT_B64[sh.k]+'"/>'
            +'<span>'+omEsc(sh.t)+'</span></div>';
        }).join('')
      +'</div></div></div>';

  /* 右：运行概况 + 趋势 + 达成率 + 架构 + 流量池 */
  s+='<div class="om-col om-r">';
  s+=omPanel('运行概况','全省实时','<div class="om-tiles">'
    + OM.tiles.map(function(t){
        return '<div class="om-tile"><i>'+omEsc(t[3])+'</i><b>'+omEsc(t[1])+'<em>'+omEsc(t[2])+'</em></b>'
          +'<span>'+omEsc(t[0])+'</span></div>';
      }).join('') +'</div>');
  s+=omPanel('今日预警趋势','条 · 每 2 小时', areaChart(OM.trend,300,104));
  s+=omPanel('核心指标达成','%','<div class="om-gauges">'
    + OM.gauges.map(function(g){ return gauge(g[0],g[1],50); }).join('') +'</div>');
  s+=omPanel('平台能力架构','自下而上贯通','<div class="om-arch">'
    + OM.arch.map(function(a,i){
        return '<div class="om-layer"><div class="om-layer-h"><b>'+omEsc(a.n)+'</b><em>'+omEsc(a.v)+'</em></div>'
          +'<p>'+omEsc(a.c)+'</p></div>'
          + (i<OM.arch.length-1?'<div class="om-flow"><i style="animation-delay:'+(i*0.3).toFixed(1)+'s"></i></div>':'');
      }).join('') +'</div>');
  var pool='<div class="om-mix">'+donut(OM.pool.items,OM.pool.total,OM.pool.unit+' 本月',100)
    +'<div class="om-mix-l">'
    + OM.pool.items.map(function(p){
        var pct=(p[1]/(OM.pool.items[0][1]+OM.pool.items[1][1])*100).toFixed(1);
        return '<div><i style="background:'+VIZ[p[2]]+'"></i><span>'+omEsc(p[0])+'</span>'
          +'<b>'+p[1]+' TB</b><s>'+pct+'%</s></div>';
      }).join('')
    +'</div></div>';
  s+=omPanel('共享流量池构成','卫星 / 5G',pool);
  s+='</div>';

  s+='</div>';   /* /om-body */

  /* 底：九大业务能力 */
  s+='<div class="om-modbar"><b>九大业务能力</b><div class="om-mods">'
    + OM.modules.map(function(m){
        return '<button type="button" class="om-mod" data-om="mod" data-mod="'+omEsc(m.n)+'">'
          +'<i>'+omEsc(m.i)+'</i><div><b>'+omEsc(m.n)+'</b>'
          +'<span><u>'+omEsc(m.m[0])+'</u> '+omEsc(m.m[1])+'</span></div></button>';
      }).join('')
    +'</div><span class="om-modbar-x">点击卡片直接进入对应工作区</span></div>';

  s+='</div>';
  return s;
}
function omMapOverlay(){
  return '<div class="om-legend">'
    +'<span><u class="lg-patrol"></u>执法船艇</span><span><u class="lg-boat"></u>渔船</span>'
    +'<span><u class="lg-route"></u>航线</span><span><u class="lg-zone"></u>禁捕区</span>'
    +'<span><u class="lg-core"></u>核心禁捕区</span><span><u class="lg-cam"></u>视频监控</span>'
    +'<span><u class="lg-ais"></u>AIS基站</span></div>'
  +'<div class="om-zoom"><button type="button" aria-label="定位">◎</button>'
    +'<button type="button" aria-label="放大">＋</button>'
    +'<button type="button" aria-label="缩小">－</button></div>';
}

/* ---------- 挂载与进出 ---------- */
var omWrap=null, omBack=null, omRO=null, omTimer=null;
function omDrawMap(){
  var box=omWrap&&omWrap.querySelector('.om-map');
  if(!box||typeof buildProj!=='function') return;
  var w=Math.max(400,Math.round(box.clientWidth)), h=Math.max(240,Math.round(box.clientHeight));
  if(typeof MAP_IMG_B64==='string'&&MAP_IMG_B64){
    box.innerHTML='<img class="om-map-photo" alt="江苏近海监管一张图" '
      +'src="data:image/jpeg;base64,'+MAP_IMG_B64+'"/>'+omMapOverlay();
  } else {
    box.innerHTML=omMapSvg(w,h)+omMapOverlay();
  }
}
var omT0=Date.now();
function omTick(){
  var el=omWrap&&omWrap.querySelector('#om-time'); if(!el) return;
  /* 从 demo 基准时刻 09:26:00 起走，和页面其它时间保持一致 */
  var sec=9*3600+26*60+Math.floor((Date.now()-omT0)/1000);
  el.textContent=[Math.floor(sec/3600)%24,Math.floor(sec/60)%60,sec%60]
    .map(function(n){ return ('0'+n).slice(-2); }).join(':');
}
function omOpen(){
  if(omWrap){ omWrap.classList.remove('om-out'); return; }
  omWrap=document.createElement('div');
  omWrap.className='om-wrap';
  omWrap.innerHTML=omMarkup();
  document.body.appendChild(omWrap);
  omDrawMap(); omTick();
  omTimer=setInterval(omTick,1000);
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
    if(omTimer){ clearInterval(omTimer); omTimer=null; }
    if(omWrap){ omWrap.remove(); omWrap=null; }
    document.removeEventListener('keydown',omKey);
    if(mod) omGoModule(mod);
    omBackBtn();
  },300);
}
function omGoModule(name){
  var btn=[].filter.call(document.querySelectorAll('aside nav button'),function(b){
    return b.textContent.indexOf(name)>=0;
  })[0];
  if(btn) btn.click();
}
function omBackBtn(){
  if(omBack&&document.body.contains(omBack)) return;
  omBack=document.createElement('button');
  omBack.type='button'; omBack.className='om-back';
  omBack.innerHTML='<span>←</span> 态势一张图';
  omBack.addEventListener('click',function(){ omBack.remove(); omBack=null; omOpen(); });
  document.body.appendChild(omBack);
}
function omKey(e){ if(e.key==='Enter'||e.key==='Escape') omEnter(); }
function omBoot(){
  if(document.querySelector('.shell')) omOpen();
  else setTimeout(omBoot,120);
}
omBoot();
