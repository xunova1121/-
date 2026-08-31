/* ===== 禁捕区 / 航道 / 气象 ===== */
function zones(){
  var s='<g class="rg-zones">';
  GEO.zones.forEach(function(z,i){
    s+='<path class="rg-zone" d="'+poly(z.p,true)+'"/>';
    var c=P(z.ll);
    reserveBox(c[0]-13,c[1]-1,26,26);
    var lp=placeBlock(c[0],c[1],textW(z.n,12),15,[[0,-28,'middle'],[0,-40,'middle'],[-16,-4,'end'],[16,-4,'start']]);
    if(lp) s+='<text class="rg-zone-label" text-anchor="middle" x="'+lp.x.toFixed(0)+'" y="'+(lp.y+12).toFixed(0)+'">'+esc(z.n)+'</text>';
    /* 参考图中的橙色禁渔徽标 */
    s+='<g class="rg-zone-badge" transform="translate('+c[0].toFixed(0)+','+(c[1]+10).toFixed(0)+')">'
      +'<circle r="9"/>'
      +'<path d="M-5.6 0 C-3.4 -3.4 1 -4 3.4 -1.6 L5.8 -3.6 L5.8 3.6 L3.4 1.6 C1 4 -3.4 3.4 -5.6 0 Z"/>'
      +'<path d="M-6.6 -6.6 L6.6 6.6" stroke="#ff9b3d" stroke-width="1.8" fill="none"/></g>';
  });
  return s+'</g>';
}
function lanes(){
  var s='<g class="rg-lanes">';
  GEO.lanes.forEach(function(l){ s+='<path class="rg-lane" d="'+smooth(l,false)+'"/>'; });
  return s+'</g>';
}
function weather(){
  var s='<g class="rg-wx">';
  GEO.wxBlobs.forEach(function(b){
    var p=P([b[0],b[1]]);
    s+='<circle class="rg-wx-blob" cx="'+p[0].toFixed(0)+'" cy="'+p[1].toFixed(0)+'" r="'+proj.km(b[2]*2).toFixed(0)+'"/>';
    var bw=Math.max(textW(b[3],11),textW(b[4],10));
    var lp=placeBlock(p[0],p[1],bw,24,[[0,-10,'middle'],[0,-30,'middle'],[0,14,'middle'],
                                       [14,-10,'start'],[-14,-10,'end']],true);
    if(lp){
      s+='<text class="rg-wx-name" text-anchor="middle" x="'+lp.x.toFixed(0)+'" y="'+(lp.y+11).toFixed(0)+'">'+esc(b[3])+'</text>'
        +'<text class="rg-wx-label" text-anchor="middle" x="'+lp.x.toFixed(0)+'" y="'+(lp.y+24).toFixed(0)+'">'+esc(b[4])+'</text>';
    }
  });
  GEO.wind.forEach(function(w,i){
    s+='<path class="rg-wind" style="animation-delay:'+(-i*0.5).toFixed(2)+'s" marker-end="url(#rgArrow)" d="'+smooth(w.p,false)+'"/>';
    /* 流线末端标风速，位置走统一避让 */
    var e=P(w.p[w.p.length-1]), a=P(w.p[w.p.length-2]);
    var t=w.spd.toFixed(1)+' m/s · '+w.lvl+'级';
    var lp=place(e[0],e[1],t,9.5,[[-9,4,'end'],[9,4,'start'],[0,-8,'middle'],[0,15,'middle'],
                                  [-9,-8,'end'],[9,-8,'start'],[-9,16,'end'],[9,16,'start']]);
    if(lp) s+='<text class="rg-wind-spd" text-anchor="'+lp.a+'" x="'+lp.x.toFixed(0)+'" y="'+lp.y.toFixed(0)+'">'+esc(t)+'</text>';
  });
  return s+'</g>';
}
function tracks(){
  var s='<g class="rg-tracks">';
  GEO.tracks.forEach(function(t){ s+='<path class="rg-track" d="'+smooth(t,false)+'"/>'; });
  return s+'</g>';
}

/* ===== 航线（规划路径） ===== */
function routeD(a,b,bend){
  var mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2, dx=b[0]-a[0], dy=b[1]-a[1];
  return 'M'+a[0].toFixed(1)+' '+a[1].toFixed(1)+' Q'+(mx-dy*bend).toFixed(1)+' '+(my+dx*bend).toFixed(1)
    +' '+b[0].toFixed(1)+' '+b[1].toFixed(1);
}
function routes(){
  var hub=P(GEO.hub.ll), s='<g class="rg-routes">';
  GEO.patrol.forEach(function(v,i){
    var a=P(v.ll), d=routeD(a,hub,v.bend);
    s+='<path class="rg-route-base" d="'+d+'"/>'
      +'<path class="rg-route'+(i%2?' alt':'')+'" data-r="'+i+'" marker-end="url(#rgArrow)" d="'+d+'"/>'
      +'<path class="rg-comet" data-c="'+i+'" d="'+d+'"/>';
  });
  /* 航路中间节点 */
  GEO.patrol.forEach(function(v,i){
    var a=P(v.ll), mx=(a[0]+hub[0])/2, my=(a[1]+hub[1])/2, dx=hub[0]-a[0], dy=hub[1]-a[1];
    var qx=(a[0]+2*(mx-dy*v.bend)+hub[0])/4, qy=(a[1]+2*(my+dx*v.bend)+hub[1])/4;
    s+='<circle class="rg-node" cx="'+qx.toFixed(1)+'" cy="'+qy.toFixed(1)+'" r="2.6"/>';
  });
  GEO.patrol.forEach(function(v,i){ s+='<circle class="rg-blip" data-b="'+i+'" r="2.6" cx="0" cy="0"/>'; });
  return s+'</g>';
}

/* ===== 目标船（雷达中心） ===== */
function hubLayer(){
  var p=P(GEO.hub.ll), r=proj.km(46), s='<g class="rg-hub">';
  s+='<circle cx="'+p[0].toFixed(0)+'" cy="'+p[1].toFixed(0)+'" r="'+(r*2.4).toFixed(0)+'" fill="url(#rgHubGlow)"/>';
  /* 雷达扫描扇形 */
  var a0=-Math.PI/2, a1=a0+Math.PI/3;
  s+='<path class="rg-sweep" d="M'+p[0].toFixed(1)+' '+p[1].toFixed(1)
    +'L'+(p[0]+r*Math.cos(a0)).toFixed(1)+' '+(p[1]+r*Math.sin(a0)).toFixed(1)
    +'A'+r.toFixed(1)+' '+r.toFixed(1)+' 0 0 1 '+(p[0]+r*Math.cos(a1)).toFixed(1)+' '+(p[1]+r*Math.sin(a1)).toFixed(1)+'Z"/>';
  ['','d2','d3','d4'].forEach(function(k){
    s+='<circle class="rg-ring '+k+'" cx="'+p[0].toFixed(0)+'" cy="'+p[1].toFixed(0)+'" r="'+r.toFixed(0)+'"/>';
  });
  /* 静态定标圈 */
  s+='<circle class="rg-fixring" cx="'+p[0].toFixed(0)+'" cy="'+p[1].toFixed(0)+'" r="'+(r*0.55).toFixed(0)+'"/>'
    +'<circle class="rg-fixring" cx="'+p[0].toFixed(0)+'" cy="'+p[1].toFixed(0)+'" r="'+r.toFixed(0)+'"/>';
  s+='<g class="rg-vessel rg-target" data-ship="3" data-tip="'+esc(
      GEO.hub.id+' '+GEO.hub.name
      +'|目标船 · 航速 '+GEO.hub.sog+' · 航向 '+GEO.hub.cog
      +'|风速 '+GEO.hub.wind+' · 横倾 '+GEO.hub.heel
      +'|2 项六防风险 · 4 路视频在线 · 点击查看详情')+'">';
  /* 闪烁：外圈光晕 + 高亮环 + 核心，同相位 */
  s+='<circle class="rg-hub-flash" cx="'+p[0].toFixed(0)+'" cy="'+p[1].toFixed(0)+'" r="22"/>';
  s+='<circle class="rg-hub-ring" cx="'+p[0].toFixed(0)+'" cy="'+p[1].toFixed(0)+'" r="13"/>';
  s+='<circle class="rg-hub-core" cx="'+p[0].toFixed(0)+'" cy="'+p[1].toFixed(0)+'" r="6"/>';
  reserveBox(p[0]-15,p[1]-15,30,30);
  var t1=GEO.hub.id+' · '+GEO.hub.name, t2='目标船 · '+GEO.hub.sog+' · 航向 '+GEO.hub.cog;
  var bw=Math.max(textW(t1,13),textW(t2,10)), bh=26;
  var lp=placeBlock(p[0],p[1],bw,bh,[[22,-10,'start'],[-22,-10,'end'],[22,8,'start'],[-22,8,'end'],
                                     [0,-34,'middle'],[0,24,'middle'],[22,-30,'start'],[-22,-30,'end'],
                                     [22,26,'start'],[-22,26,'end']],true);
  if(lp){
    s+='<text class="rg-hub-label" text-anchor="'+lp.a+'" x="'+lp.x.toFixed(0)+'" y="'+(lp.y+10).toFixed(0)+'">'+esc(t1)+'</text>';
    s+='<text class="rg-hub-sub" text-anchor="'+lp.a+'" x="'+lp.x.toFixed(0)+'" y="'+(lp.y+24).toFixed(0)+'">'+esc(t2)+'</text>';
  }
  return s+'</g></g>';
}

/* ===== 渔船 & 执法船艇 ===== */
function fishLayer(){
  var s='<g class="rg-fish-layer">';
  GEO.fish.forEach(function(f,i){
    var p=P([f[0],f[1]]), st=f[2], r=3.6;
    if(inLand(p[0],p[1])) return;                       /* 落到陆地的点直接丢弃 */
    if(p[0]<8||p[0]>proj.w-8||p[1]<8||p[1]>proj.h-50) return;
    if(st==='ok') r=2.6;
    if(st==='bad') s+='<circle class="rg-fish-halo" cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="10"/>';
    s+='<path class="rg-fish '+st+'" data-ship="'+(7+i%6)+'" data-tip="'+esc('苏渔 0'+(4200+i*37)+'|'+
        (st==='bad'?'告警 · 越界作业':st==='warn'?'关注 · 航速异常':'正常作业')+'|航速 '+(3+i%6)+'.'+(i%9)+' 节')+'" d="'
      +'M'+p[0].toFixed(1)+' '+(p[1]-r).toFixed(1)+' L'+(p[0]+r*0.8).toFixed(1)+' '+(p[1]+r).toFixed(1)
      +' L'+(p[0]-r*0.8).toFixed(1)+' '+(p[1]+r).toFixed(1)+' Z"/>';
  });
  return s+'</g>';
}
function patrolLayer(){
  var hub=P(GEO.hub.ll), s='<g class="rg-patrol">';
  /* 先为所有船体占位，标注不会压到任何一条船 */
  GEO.patrol.forEach(function(v){ var a=P(v.ll); reserveBox(a[0]-19,a[1]-13,38,26); });
  GEO.patrol.forEach(function(v,i){
    var a=P(v.ll);
    var t1=v.id, bw=textW(t1,11), bh=13;
    var far = a[0]<hub[0];   /* 靠陆一侧优先把标注放外侧，避免压住航线 */
    var cands = far
      ? [[-21,-4,'end'],[21,-4,'start'],[0,-17,'middle'],[0,22,'middle'],[-21,14,'end'],[21,14,'start']]
      : [[21,-4,'start'],[-21,-4,'end'],[0,-17,'middle'],[0,22,'middle'],[21,14,'start'],[-21,14,'end']];
    var lp=placeBlock(a[0],a[1],bw,bh,cands,true);
    var lx = lp ? (lp.x-a[0]) : 21, ly = lp ? (lp.y-a[1]) : -4, la = lp ? lp.a : 'start';
    s+='<circle class="rg-cover" cx="'+a[0].toFixed(0)+'" cy="'+a[1].toFixed(0)+'" r="'+proj.km(38).toFixed(0)+'"/>';
    s+='<g class="rg-vessel" data-ship="'+[1,2,4,5,6][i]+'" data-v="'+i+'" data-tip="'
      +esc(v.id+' '+v.name+'|'+v.org+' · 航速 '+v.sog+' 节|风速 '+(v.wind||'—')
         +'|预计 '+v.eta+' 分钟抵达目标船')+'">'
      +'<g class="rg-hull" data-hull="'+i+'" transform="translate('+a[0].toFixed(1)+','+a[1].toFixed(1)+')">'
        +'<path class="wake" d="M-26 9 Q-13 12 -2 8" fill="none" stroke="#7fe0f5" stroke-width="1.6" '
        +'stroke-linecap="round" opacity=".4" stroke-dasharray="3 4"/>'
        +'<g class="bob"><g class="rg-rot"><use class="hull" href="#rgBoat" x="-16" y="-8" width="32" height="16"/></g></g>'
      +'</g>'
      +'<g class="rg-lab" data-lab="'+i+'" transform="translate('+a[0].toFixed(1)+','+a[1].toFixed(1)+')">'
        +'<text class="v-name" text-anchor="'+la+'" x="'+lx.toFixed(0)+'" y="'+(ly+10).toFixed(0)+'">'+esc(t1)+'</text>'
      +'</g></g>';
  });
  return s+'</g>';
}
