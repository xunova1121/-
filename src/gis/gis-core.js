/* ===== 投影 ===== */
var VIEW = { latTop:35.25, latSpan:4.15, anchorLon:122.00, stretch:1.55 };
var proj = null;
function buildProj(w,h){
  var ky = h / VIEW.latSpan;
  var latMid = VIEW.latTop - VIEW.latSpan/2;
  var kx = ky * Math.cos(latMid*Math.PI/180) * VIEW.stretch;
  var lonSpan = w / kx;
  var lon0 = VIEW.anchorLon - lonSpan/2;
  return {
    w:w, h:h, kx:kx, ky:ky, lon0:lon0, lonSpan:lonSpan,
    x:function(lon){ return (lon-lon0)*kx; },
    y:function(lat){ return (VIEW.latTop-lat)*ky; },
    /* 公里 → 像素（按纬度方向，避免拉伸失真） */
    km:function(k){ return k/110.9*ky; }
  };
}
function P(ll){ return [proj.x(ll[0]), proj.y(ll[1])]; }
function poly(pts,close){
  var d='';
  for(var i=0;i<pts.length;i++){ var p=P(pts[i]); d+=(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1); }
  return d+(close?'Z':'');
}
/* Catmull-Rom → 三次贝塞尔，海岸线/河流更自然 */
function smooth(pts,close){
  var q=pts.map(P), n=q.length;
  if(n<3) return poly(pts,close);
  var d='M'+q[0][0].toFixed(1)+' '+q[0][1].toFixed(1);
  for(var i=0;i<n-1;i++){
    var p0=q[i-1]||q[0], p1=q[i], p2=q[i+1], p3=q[i+2]||q[n-1];
    d+='C'+(p1[0]+(p2[0]-p0[0])/6).toFixed(1)+' '+(p1[1]+(p2[1]-p0[1])/6).toFixed(1)+','
      +(p2[0]-(p3[0]-p1[0])/6).toFixed(1)+' '+(p2[1]-(p3[1]-p1[1])/6).toFixed(1)+','
      +p2[0].toFixed(1)+' '+p2[1].toFixed(1);
  }
  return d+(close?'Z':'');
}

/* ===== 标注避让 ===== */
var reserved=[], placed=[];
function hit(a,b){ return !(a[0]+a[2]<b[0]||b[0]+b[2]<a[0]||a[1]+a[3]<b[1]||b[1]+b[3]<a[1]); }
function textW(t,fs){ var w=0; for(var i=0;i<t.length;i++){ w += t.charCodeAt(i)>255 ? fs : fs*0.55; } return w; }
function place(x,y,t,fs,cands){
  for(var i=0;i<cands.length;i++){
    var c=cands[i], tx=x+c[0], ty=y+c[1], a=c[2], w=textW(t,fs);
    var bx = a==='end' ? tx-w : a==='middle' ? tx-w/2 : tx;
    var box=[bx-2,ty-fs,w+4,fs+4];
    if(box[0]<2||box[0]+box[2]>proj.w-2||box[1]<2||box[1]+box[3]>proj.h-2) continue;
    var bad=false, j;
    for(j=0;j<reserved.length;j++) if(hit(box,reserved[j])){bad=true;break;}
    if(!bad) for(j=0;j<placed.length;j++) if(hit(box,placed[j])){bad=true;break;}
    if(bad) continue;
    placed.push(box);
    return {x:tx,y:ty,a:a};
  }
  return null;
}
var CAND=[[7,4,'start'],[-7,4,'end'],[0,-8,'middle'],[0,15,'middle'],[7,-7,'start'],[-7,-7,'end'],[7,15,'start'],[-7,15,'end']];
/* 预留任意矩形（船体、雷达圈等），后续标注自动绕开 */
function reserveBox(x,y,w,h){ placed.push([x,y,w,h]); }
function fits(box){
  if(box[0]<3||box[0]+box[2]>proj.w-3||box[1]<3||box[1]+box[3]>proj.h-3) return false;
  var j;
  for(j=0;j<reserved.length;j++) if(hit(box,reserved[j])) return false;
  for(j=0;j<placed.length;j++) if(hit(box,placed[j])) return false;
  return true;
}
/* 为宽 w、高 h 的标注块寻找不冲突的位置，cands 为 [dx,dy,anchor] */
function placeBlock(x,y,w,h,cands,force){
  var i,c,tx,ty,a,bx,box;
  for(i=0;i<cands.length;i++){
    c=cands[i]; tx=x+c[0]; ty=y+c[1]; a=c[2];
    bx = a==='end' ? tx-w : a==='middle' ? tx-w/2 : tx;
    box=[bx-3,ty-3,w+6,h+6];
    if(!fits(box)) continue;
    placed.push(box);
    return {x:tx,y:ty,a:a};
  }
  if(!force) return null;
  /* 兜底：选第一个不越界的候选位 */
  for(i=0;i<cands.length;i++){
    c=cands[i]; tx=x+c[0]; ty=y+c[1]; a=c[2];
    bx = a==='end' ? tx-w : a==='middle' ? tx-w/2 : tx;
    box=[bx-3,ty-3,w+6,h+6];
    if(box[0]<3||box[0]+box[2]>proj.w-3||box[1]<3||box[1]+box[3]>proj.h-3) continue;
    placed.push(box);
    return {x:tx,y:ty,a:a};
  }
  return null;
}

/* ===== SVG 构建 ===== */
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function defs(){
  return '<defs>'
  +'<linearGradient id="rgSeaGrad" x1="0" y1="0" x2="0.7" y2="1">'
   +'<stop offset="0" stop-color="#05294a"/><stop offset=".5" stop-color="#031a31"/><stop offset="1" stop-color="#010b16"/></linearGradient>'
  +'<linearGradient id="rgLandGrad" x1="0.1" y1="0" x2="1" y2="1">'
   +'<stop offset="0" stop-color="#0e3b58"/><stop offset=".45" stop-color="#0a2c45"/><stop offset="1" stop-color="#061c2e"/></linearGradient>'
  +'<radialGradient id="rgCityGlow"><stop offset="0" stop-color="#7fe4ff" stop-opacity=".55"/>'
   +'<stop offset=".45" stop-color="#3ba7d6" stop-opacity=".2"/><stop offset="1" stop-color="#1d6f94" stop-opacity="0"/></radialGradient>'
  +'<radialGradient id="rgWxGrad"><stop offset="0" stop-color="#ffb35c" stop-opacity=".30"/>'
   +'<stop offset=".6" stop-color="#e2803c" stop-opacity=".13"/><stop offset="1" stop-color="#c96a30" stop-opacity="0"/></radialGradient>'
  +'<radialGradient id="rgHubGlow"><stop offset="0" stop-color="#5fe9ff" stop-opacity=".45"/>'
   +'<stop offset=".55" stop-color="#1f9fc9" stop-opacity=".16"/><stop offset="1" stop-color="#0d5f80" stop-opacity="0"/></radialGradient>'
  +'<linearGradient id="rgSweep" x1="0" y1="0" x2="1" y2="0">'
   +'<stop offset="0" stop-color="#4fe8ff" stop-opacity=".38"/><stop offset="1" stop-color="#4fe8ff" stop-opacity="0"/></linearGradient>'
  +'<pattern id="rgHatch" width="9" height="9" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
   +'<rect width="9" height="9" fill="#0a5f7d" fill-opacity=".14"/>'
   +'<line x1="0" y1="0" x2="0" y2="9" stroke="#2fd8f4" stroke-width="1.6" stroke-opacity=".34"/></pattern>'
  +'<filter id="rgCoast" x="-15%" y="-15%" width="130%" height="130%">'
   +'<feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
  +'<filter id="rgLine" x="-40%" y="-40%" width="180%" height="180%">'
   +'<feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
  +'<filter id="rgGlowS" x="-90%" y="-90%" width="280%" height="280%">'
   +'<feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
  +'<filter id="rgGlowL" x="-90%" y="-90%" width="280%" height="280%">'
   +'<feGaussianBlur stdDeviation="4.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
  +'<filter id="rgShadow" x="-50%" y="-50%" width="200%" height="200%">'
   +'<feDropShadow dx="0" dy="2" stdDeviation="2.4" flood-color="#000" flood-opacity=".85"/></filter>'
  +'<marker id="rgArrow" markerWidth="6" markerHeight="6" refX="5.2" refY="3" orient="auto">'
   +'<path d="M0 0 L6 3 L0 6 Z" fill="#3ee0ff"/></marker>'
  /* 执法船艇符号：白色船体 + 冷蓝上层建筑，与参考图一致 */
  +'<symbol id="rgBoat" viewBox="0 0 64 32">'
   +'<path d="M3 20 L55 17 L62 21 L52 29 L13 29 L3 23 Z" fill="#f2fbff" stroke="#5fb6d0" stroke-width="1.1"/>'
   +'<path d="M19 10 H45 L52 18 L13 20 Z" fill="#dceff6" stroke="#63b2c8" stroke-width="1"/>'
   +'<path d="M26 3 H41 L45 10 H23 Z" fill="#ffffff" stroke="#69bad0" stroke-width="1"/>'
   +'<path d="M28 5 H33 V9 H26 Z M35 5 H39 L42 9 H35 Z" fill="#12546f"/>'
   +'<path d="M12 24 H53" stroke="#1d7ea6" stroke-width="2.2"/>'
   +'<circle cx="47" cy="14" r="1.7" fill="#ff5f6b"/>'
   +'<path d="M33 3 V0 M33 1 L41 3" stroke="#bfeaf5" stroke-width="1"/></symbol>'
  +'</defs>';
}

/* 陆域判定：射线法，用于把聚落灯点撒在陆地上 */
var landPts=null;
function inLand(x,y){
  if(!landPts) landPts=GEO.coast.map(P);
  var c=false, n=landPts.length;
  for(var i=0,j=n-1;i<n;j=i++){
    var a=landPts[i], b=landPts[j];
    if((a[1]>y)!==(b[1]>y) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) c=!c;
  }
  return c;
}
/* 确定性伪随机，保证每次渲染纹理一致 */
function rnd(seed){ var t=Math.sin(seed*12.9898)*43758.5453; return t-Math.floor(t); }

function basemap(){
  var s='<g class="rg-base">';
  s+='<rect class="rg-sea-deep" x="0" y="0" width="'+proj.w+'" height="'+proj.h+'"/>';
  var land=smooth(GEO.coast,true);
  /* 海岸辉光（由外到内三层） */
  s+='<path class="rg-halo" d="'+land+'" stroke-width="11" opacity=".07"/>';
  s+='<path class="rg-halo" d="'+land+'" stroke-width="5" opacity=".14"/>';
  s+='<path class="rg-land" d="'+land+'"/>';
  /* 城市灯光团（仅陆域，压在陆地之上） */
  GEO.glows.forEach(function(g){
    var p=P([g[0],g[1]]);
    s+='<circle class="rg-citylight" cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="'+proj.km(g[2]*2.4).toFixed(1)+'"/>';
  });
  if(GEO.yangtze) s+='<path class="rg-yangtze" d="'+smooth(GEO.yangtze,true)+'"/>';
  GEO.islands.forEach(function(is){ s+='<path class="rg-island" d="'+smooth(is,true)+'"/>'; });
  GEO.rivers.forEach(function(r){ s+='<path class="rg-river" style="stroke-width:'+r.w+'" d="'+smooth(r.p,false)+'"/>'; });
  GEO.lakes.forEach(function(l){ s+='<path class="rg-lake" d="'+smooth(l,true)+'"/>'; });
  GEO.boundaries.forEach(function(b){ s+='<path class="rg-boundary" d="'+smooth(b,false)+'"/>'; });
  /* 聚落灯点：模拟夜光遥感底图的城镇肌理 */
  var dots='';
  for(var i=0;i<520;i++){
    var x=rnd(i+1)*proj.w, y=rnd(i+97.3)*proj.h;
    if(!inLand(x,y)) continue;
    var r=(0.4+rnd(i+13.7)*1.1).toFixed(2), o=(0.14+rnd(i+31.1)*0.5).toFixed(2);
    dots+='<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="'+r+'" opacity="'+o+'"/>';
  }
  s+='<g class="rg-settle" fill="#8fdcf7">'+dots+'</g>';
  /* 近岸浅滩带 */
  s+='<path class="rg-shelf" d="'+land+'"/>';
  return s+'</g>';
}

function graticule(){
  var s='<g class="rg-grat">', lon, lat;
  for(lon=Math.ceil(proj.lon0); lon<proj.lon0+proj.lonSpan; lon++){
    var x=proj.x(lon); if(x<26||x>proj.w-26) continue;
    var t=lon+'°00′E', box=[x-textW(t,9)/2-2,7,textW(t,9)+4,13];
    if(!fits(box)) continue; placed.push(box);
    s+='<text class="rg-grid-label" text-anchor="middle" x="'+x.toFixed(0)+'" y="18">'+t+'</text>';
  }
  for(lat=Math.ceil(VIEW.latTop-VIEW.latSpan); lat<VIEW.latTop; lat++){
    var y=proj.y(lat); if(y<30||y>proj.h-66) continue;
    var t2=lat+'°00′N', b2=[proj.w-8-textW(t2,9)-2,y-9,textW(t2,9)+4,13];
    if(!fits(b2)) continue; placed.push(b2);
    s+='<text class="rg-grid-label" text-anchor="end" x="'+(proj.w-8)+'" y="'+y.toFixed(0)+'">'+t2+'</text>';
  }
  return s+'</g>';
}

function annotations(){
  var s='<g class="rg-anno">';
  GEO.labels.forEach(function(l){
    var p=P(l.ll), fs=l.c==='rg-prov'?15:17;
    var box=[p[0]-textW(l.t,fs)/2-2,p[1]-fs,textW(l.t,fs)+4,fs+4];
    var bad=false;
    for(var j=0;j<reserved.length;j++) if(hit(box,reserved[j])) bad=true;
    if(box[0]<2||box[0]+box[2]>proj.w-2||box[1]<2||box[1]+box[3]>proj.h-4) bad=true;
    if(bad) return;
    placed.push(box);
    s+='<text class="'+l.c+'" text-anchor="middle" x="'+p[0].toFixed(0)+'" y="'+p[1].toFixed(0)+'">'+esc(l.t)+'</text>';
  });
  GEO.cities.forEach(function(c){
    var p=P(c.ll);
    if(p[0]<-20||p[0]>proj.w+20||p[1]<-20||p[1]>proj.h+20) return;
    s+='<circle class="rg-city-dot" cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="'+c.r.toFixed(1)+'"/>';
    var lp=place(p[0],p[1],c.n,11,CAND);
    if(lp) s+='<text class="rg-city-name" text-anchor="'+lp.a+'" x="'+lp.x.toFixed(0)+'" y="'+lp.y.toFixed(0)+'">'+esc(c.n)+'</text>';
  });
  GEO.ports.forEach(function(pt){
    var p=P(pt.ll);
    s+='<path class="rg-port" d="M'+(p[0]-3.4).toFixed(1)+' '+(p[1]+3).toFixed(1)+' L'+p[0].toFixed(1)+' '+(p[1]-3.6).toFixed(1)
      +' L'+(p[0]+3.4).toFixed(1)+' '+(p[1]+3).toFixed(1)+' Z"/>';
    var lp=place(p[0],p[1],pt.n,9,CAND);
    if(lp) s+='<text class="rg-port-name" text-anchor="'+lp.a+'" x="'+lp.x.toFixed(0)+'" y="'+lp.y.toFixed(0)+'">'+esc(pt.n)+'</text>';
  });
  return s+'</g>';
}
