/* ================= 雷达态势视图 =================
   极坐标原生数据：雷达操作员看到的就是方位/距离，不是经纬度。
   与一张图共用目标编号，两个视图讲同一件事，但不假装互为投影。 */
var RADAR = {
  station:"大丰海上监管雷达站", pos:"33°00′N / 120°58′E",
  rangeNm:48, rings:[12,24,36,48],
  sys:[["雷达",97],["双光谱",89],["通信",95],["电源",92]],
  targets:[]
};
/* 生成一条尾迹：从当前点沿反航向回溯 n 个点 */
function mkTrail(brg,rng,crs,n,step){
  var t=[], b=brg, r=rng, i;
  for(i=1;i<=n;i++){
    var dx=Math.sin((crs+180)*Math.PI/180)*step*i, dy=Math.cos((crs+180)*Math.PI/180)*step*i;
    var x=Math.sin(brg*Math.PI/180)*rng+dx, y=Math.cos(brg*Math.PI/180)*rng+dy;
    r=Math.sqrt(x*x+y*y); b=(Math.atan2(x,y)*180/Math.PI+360)%360;
    t.push([b,r]);
  }
  return t;
}
function T(id,name,brg,rng,crs,spd,st,opt){
  var o={id:id,name:name,brg:brg,rng:rng,crs:crs,spd:spd,st:st||"ok"};
  if(opt) for(var k in opt) o[k]=opt[k];
  if(o.trail===true) o.trail=mkTrail(brg,rng,crs,o.tn||6,o.ts||1.9);
  return o;
}
RADAR.targets=[
  /* 告警：本次锁定目标 */
  T("T001","苏盐渔05168",84,30,126,8.6,"bad",{lock:true,trail:true,tn:7,ts:2.2}),
  /* 关注目标（带尾迹） */
  T("W-217","苏盐渔07215",338,26,152,7.4,"warn",{trail:true,tn:6,ts:2.0}),
  T("W-118","苏连渔02690",347,17,138,6.1,"warn",{trail:true,tn:5,ts:1.7}),
  T("W-334","苏通渔03277",22,29,196,9.2,"warn",{trail:true,tn:6,ts:2.1}),
  T("W-402","苏盐渔04188",148,22,118,6.8,"warn",{trail:true,tn:7,ts:2.0}),
  T("W-455","苏通渔06031",156,34,124,7.7,"warn",{trail:true,tn:5,ts:2.2}),
  T("W-509","苏连渔01832",97,36,142,5.9,"warn",{trail:true,tn:5,ts:1.8}),
  /* 执法力量 */
  T("I002","中国渔政32568",58,21,96,28.5,"own"),
  T("I004","中国渔政32601",30,13,104,23.7,"own"),
  T("I006","中国海警2301",108,25,268,36.6,"own"),
  T("I008","中国渔政32115",132,31,312,30.5,"own"),
  /* 正常目标 */
  T("N-01","",12,38,150,6.2),  T("N-02","",44,34,88,5.4),
  T("N-03","",70,42,172,4.8),  T("N-04","",118,40,290,6.6),
  T("N-05","",143,12,64,5.1),  T("N-06","",168,27,340,7.2),
  T("N-07","",196,19,26,4.4),  T("N-08","",212,33,58,6.0),
  T("N-09","",236,24,102,5.7), T("N-10","",254,38,124,6.9),
  T("N-11","",274,15,208,4.9), T("N-12","",292,31,186,6.3),
  T("N-13","",311,40,164,5.5), T("N-14","",325,9,132,3.8),
  T("N-15","",8,20,110,4.2),   T("N-16","",188,41,300,7.1),
  T("N-17","",228,8,76,3.4),   T("N-18","",264,29,150,5.9)
];

/* ---------- 绘制 ---------- */
function rpt(cx,cy,R,brg,rng,rangeNm){
  var r=rng/rangeNm*R, a=brg*Math.PI/180;
  return [cx+r*Math.sin(a), cy-r*Math.cos(a)];
}
function scope(S){
  /* S: {cx,cy,R} */
  var cx=S.cx, cy=S.cy, R=S.R, s='', i, a, p1, p2;
  s+='<circle class="rd-face" cx="'+cx+'" cy="'+cy+'" r="'+R+'"/>';
  /* 距离环 */
  RADAR.rings.forEach(function(nm){
    var r=nm/RADAR.rangeNm*R;
    s+='<circle class="rd-ring" cx="'+cx+'" cy="'+cy+'" r="'+r.toFixed(1)+'"/>';
    s+='<text class="rd-ring-n" x="'+(cx+4)+'" y="'+(cy-r+11).toFixed(1)+'">'+nm+'nm</text>';
  });
  /* 径向线 */
  for(i=0;i<12;i++){
    a=i*30*Math.PI/180;
    s+='<line class="rd-spoke" x1="'+cx+'" y1="'+cy+'" x2="'+(cx+R*Math.sin(a)).toFixed(1)
      +'" y2="'+(cy-R*Math.cos(a)).toFixed(1)+'"/>';
  }
  /* 方位刻度与标注 */
  for(i=0;i<180;i++){
    a=i*2*Math.PI/180;
    var maj=(i%5===0), L=maj?7:3.5;
    p1=[cx+(R+3)*Math.sin(a), cy-(R+3)*Math.cos(a)];
    p2=[cx+(R+3+L)*Math.sin(a), cy-(R+3+L)*Math.cos(a)];
    s+='<line class="rd-tick'+(maj?' maj':'')+'" x1="'+p1[0].toFixed(1)+'" y1="'+p1[1].toFixed(1)
      +'" x2="'+p2[0].toFixed(1)+'" y2="'+p2[1].toFixed(1)+'"/>';
  }
  for(i=0;i<12;i++){
    a=i*30*Math.PI/180;
    var lp=[cx+(R+24)*Math.sin(a), cy-(R+24)*Math.cos(a)];
    s+='<text class="rd-brg" x="'+lp[0].toFixed(1)+'" y="'+(lp[1]+4).toFixed(1)+'">'+(i*30)+'</text>';
  }
  /* 扫描扇 */
  s+='<g class="rd-sweep-g" style="transform-origin:'+cx+'px '+cy+'px">'
    +'<path class="rd-sweep" d="M'+cx+' '+cy+' L'+cx+' '+(cy-R)
    +' A'+R+' '+R+' 0 0 0 '+(cx-R*Math.sin(0.62)).toFixed(1)+' '+(cy-R*Math.cos(0.62)).toFixed(1)+' Z"/>'
    +'<line class="rd-sweep-edge" x1="'+cx+'" y1="'+cy+'" x2="'+cx+'" y2="'+(cy-R)+'"/></g>';
  s+='<circle class="rd-hub" cx="'+cx+'" cy="'+cy+'" r="3"/>';
  return s;
}
function targets(S){
  var cx=S.cx, cy=S.cy, R=S.R, s='';
  RADAR.targets.forEach(function(t,i){
    var p=rpt(cx,cy,R,t.brg,t.rng,RADAR.rangeNm);
    if(t.trail&&t.trail.length){
      var d='M'+p[0].toFixed(1)+' '+p[1].toFixed(1);
      t.trail.forEach(function(q){
        var e=rpt(cx,cy,R,q[0],q[1],RADAR.rangeNm);
        d+='L'+e[0].toFixed(1)+' '+e[1].toFixed(1);
      });
      s+='<path class="rd-trail '+t.st+'" d="'+d+'"/>';
      t.trail.forEach(function(q,j){
        var e=rpt(cx,cy,R,q[0],q[1],RADAR.rangeNm);
        s+='<circle class="rd-dot '+t.st+'" cx="'+e[0].toFixed(1)+'" cy="'+e[1].toFixed(1)
          +'" r="'+(2.4-j*0.16).toFixed(2)+'" opacity="'+(0.85-j*0.09).toFixed(2)+'"/>';
      });
    }
    s+='<g class="rd-tg '+t.st+'" data-brg="'+t.brg+'" data-i="'+i+'"'
      +' transform="translate('+p[0].toFixed(1)+','+p[1].toFixed(1)+') rotate('+t.crs+')">'
      +'<path d="M0 -4.6 L3.9 3.4 L0 1.4 L-3.9 3.4 Z"/></g>';
    if(t.lock){
      S.lockXY=p;
      s+='<g class="rd-lock" transform="translate('+p[0].toFixed(1)+','+p[1].toFixed(1)+')">'
        +'<circle class="rd-lock-c" r="11"/>'
        +'<path class="rd-lock-b" d="M-26 -16 h-8 v8 M26 -16 h8 v8 M-26 16 h-8 v-8 M26 16 h8 v-8"/>'
        +'<path class="rd-lock-b" d="M-34 -16 v-8 h8 M34 -16 v-8 h8 M-34 16 v8 h8 M34 16 v8 h8"/>'
        +'<line class="rd-lock-x" x1="-17" y1="0" x2="-13" y2="0"/>'
        +'<line class="rd-lock-x" x1="13" y1="0" x2="17" y2="0"/></g>';
    }
  });
  return s;
}

/* ---------- 侧栏与通道 ---------- */
function donut(label,pct,i){
  var C=2*Math.PI*15;
  return '<div class="rd-gauge"><svg viewBox="0 0 36 36">'
    +'<g transform="rotate(-90 18 18)">'
      +'<circle class="g-bg" cx="18" cy="18" r="15"/>'
      +'<circle class="g-fg" cx="18" cy="18" r="15" stroke-dasharray="'+(C*pct/100).toFixed(1)+' '+C.toFixed(1)+'"'
      +' style="animation-delay:'+(i*0.12).toFixed(2)+'s"/>'
    +'</g>'
    +'<text x="18" y="21.5">'+pct+'%</text></svg><b>'+label+'</b></div>';
}
function sidebar(full){
  var s='';
  if(full){
    s+='<div class="rd-box rd-tele"><div class="rd-bars">';
    [72,44,88,36,61,93,50,78].forEach(function(v,i){
      s+='<i style="--v:'+v+'%;animation-delay:'+(i*0.17).toFixed(2)+'s"></i>';
    });
    s+='</div><svg class="rd-mini" viewBox="0 0 150 34" preserveAspectRatio="none">'
      +'<polyline class="rd-mini-l" points=""/></svg>'
      +'<div class="rd-kv"><span>站点</span><b>'+RADAR.station+'</b></div>'
      +'<div class="rd-kv"><span>坐标</span><b>'+RADAR.pos+'</b></div>'
      +'<div class="rd-kv"><span>量程</span><b>'+RADAR.rangeNm+' nm</b></div></div>';
  }
  s+='<div class="rd-box"><h4>目标信息</h4>'
    +'<div class="rd-leg ok"><i></i>正常目标<em>'+RADAR.targets.filter(function(t){return t.st==='ok'||t.st==='own';}).length+'</em></div>'
    +'<div class="rd-leg warn"><i></i>关注目标<em>'+RADAR.targets.filter(function(t){return t.st==='warn';}).length+'</em></div>'
    +'<div class="rd-leg bad"><i></i>告警目标<em>'+RADAR.targets.filter(function(t){return t.st==='bad';}).length+'</em></div></div>';
  s+='<div class="rd-box"><h4>系统状态</h4><div class="rd-gauges">'
    + RADAR.sys.map(function(g,i){ return donut(g[0],g[1],i); }).join('') +'</div></div>';
  return s;
}
function channels(){
  var t=RADAR.targets.filter(function(x){return x.lock;})[0];
  function panel(cls,title,img,meta){
    return '<div class="rd-ch '+cls+'"><h4>'+title+'<em></em></h4>'
      +'<div class="rd-ch-img"><img alt="'+title+'" src="data:image/jpeg;base64,'+img+'"/>'
      +'<div class="rd-scan"></div>'
      +'<svg class="rd-ch-ov" viewBox="0 0 200 100" preserveAspectRatio="none"></svg>'
      +'<div class="rd-track"><i></i><i></i><i></i><i></i></div>'
      +'<div class="rd-ch-meta">'+meta+'</div>'
      +'<div class="rd-ch-tag">'+esc(t.id+' '+t.name)+'</div></div></div>';
  }
  return panel('vis','可见光通道', VIS_B64, '低照度增益 ×8　f/1.4　1920×1080')
       + panel('ir','热成像通道', THERM_B64, '测温 −20~150℃　640×512　30Hz')
       + detailCard(t);
}
/* 锁定目标详情：填满右栏剩余空间，也是全屏态的信息落点 */
function detailCard(t){
  return '<div class="rd-detail"><h4>锁定目标　'+esc(t.id)+'<b>告警</b></h4>'
    +'<div class="rd-dl">'
      +'<span>船名</span><b>'+esc(t.name)+'</b><span>方位</span><b>'+t.brg.toFixed(0)+'°</b>'
      +'<span>距离</span><b>'+t.rng.toFixed(1)+' nm</b><span>航向</span><b>'+t.crs+'°</b>'
      +'<span>航速</span><b>'+t.spd.toFixed(1)+' kn</b><span>横倾</span><b>18.6°</b>'
      +'<span>风速</span><b>12.4 m/s</b><span>浪高</span><b>2.1 m</b>'
      +'<span>识别</span><b>雷达 + 双光谱</b><span>置信度</span><b>96.2%</b>'
    +'</div>'
    +'<div class="rd-note">双光谱已完成目标确认：船体轮廓与 AIS 报文一致，'
      +'热成像显示<em>机舱高温、尾流温升</em>，判定为在航作业。'
      +'当前位于禁捕区边缘 <em>0.8 nm</em>，已推送就近执法力量。</div></div>';
}

/* ---------- 组装 ---------- */
function radarMarkup(w,h,full){
  var padL = full?214:134, padR = full?Math.round(w*0.315):318, gap=full?12:9;
  var waveH = full?86:0;
  var avail = h - (full?24:16) - waveH - (full?10:0);
  var colW  = w - padL - padR - gap*2 - (full?24:16);
  var R = Math.max(64, Math.min(avail/2 - (full?38:36), colW/2 - (full?38:34)));
  var sw = colW, sh = avail;
  var cx = sw/2, cy = sh/2;
  var S = {cx:cx, cy:cy, R:R};
  var body = scope(S) + targets(S);
  return '<div class="rd-root'+(full?' full':'')+'" style="--padL:'+padL+'px;--padR:'+padR+'px;--gap:'+gap+'px">'
    +'<div class="rd-side">'+sidebar(full)+'</div>'
    +'<div class="rd-mid">'
      +'<div class="rd-scope"><svg viewBox="0 0 '+sw.toFixed(0)+' '+sh.toFixed(0)+'">'+body+'</svg></div>'
      +(full?'<div class="rd-wave"><svg viewBox="0 0 600 76" preserveAspectRatio="none">'
             +'<polyline class="w1" points=""/><polyline class="w2" points=""/><polyline class="w3" points=""/>'
             +'</svg></div>':'')
    +'</div>'
    +'<div class="rd-right">'+channels()+'</div>'
    +'<svg class="rd-link"></svg>'
    +'</div>';
}

/* ---------- 动画 ---------- */
var rdAnim=null;
function startRadar(root){
  stopRadar();
  var sweep=root.querySelector('.rd-sweep-g');
  var tgs=[].slice.call(root.querySelectorAll('.rd-tg'));
  var waves=[].slice.call(root.querySelectorAll('.rd-wave polyline'));
  var mini=root.querySelector('.rd-mini-l');
  var t0=performance.now(), REV=4200;          /* 一圈 4.2 秒 */
  function frame(now){
    var ang=((now-t0)%REV)/REV*360;
    if(sweep) sweep.style.transform='rotate('+ang.toFixed(1)+'deg)';
    /* 目标随扫描线刷新：扫过瞬间最亮，之后按余辉衰减 */
    tgs.forEach(function(g){
      var d=(ang-parseFloat(g.dataset.brg)+360)%360;
      g.style.opacity=(d<3?1:Math.max(0.24,1-Math.pow(d/360,0.62)*0.86)).toFixed(3);
    });
    var i,p;
    if(waves.length){
      for(i=0;i<waves.length;i++){
        p=[];
        for(var x=0;x<=600;x+=6){
          var ph=(now/(520+i*180))+x/(52+i*16);
          var y=38 + Math.sin(ph)*(9+i*3) + Math.sin(ph*2.7+i)*(5+i*2)
                  + Math.sin(ph*6.1+i*2)*(2.5+i) + Math.sin(x*0.9+now/140)*1.6;
          p.push(x+','+y.toFixed(1));
        }
        waves[i].setAttribute('points',p.join(' '));
      }
    }
    if(mini){
      p=[];
      for(i=0;i<=150;i+=3){
        p.push(i+','+(17+Math.sin(now/300+i/9)*6+Math.sin(now/90+i/3)*3.5).toFixed(1));
      }
      mini.setAttribute('points',p.join(' '));
    }
    rdAnim=requestAnimationFrame(frame);
  }
  rdAnim=requestAnimationFrame(frame);
  linkLines(root);
}
function stopRadar(){ if(rdAnim){ cancelAnimationFrame(rdAnim); rdAnim=null; } }

/* 锁定目标 → 可见光 → 热成像 的引出线 */
function linkLines(root){
  var svg=root.querySelector('.rd-link'); if(!svg) return;
  var box=root.getBoundingClientRect();
  var lock=root.querySelector('.rd-lock'), vis=root.querySelector('.rd-ch.vis .rd-track'),
      ir=root.querySelector('.rd-ch.ir .rd-track');
  if(!lock||!vis||!ir) return;
  function c(el){ var r=el.getBoundingClientRect();
    return [r.left-box.left+r.width/2, r.top-box.top+r.height/2]; }
  var a=c(lock), b=c(vis), d=c(ir);
  svg.setAttribute('viewBox','0 0 '+box.width.toFixed(0)+' '+box.height.toFixed(0));
  svg.innerHTML='<path class="rd-ln" d="M'+a[0].toFixed(0)+' '+a[1].toFixed(0)
      +' H'+((a[0]+b[0])/2).toFixed(0)+' V'+b[1].toFixed(0)+' H'+(b[0]-26).toFixed(0)+'"/>'
    +'<path class="rd-ln dash" d="M'+b[0].toFixed(0)+' '+(b[1]+24).toFixed(0)
      +' V'+(d[1]-24).toFixed(0)+'"/>'
    +'<circle class="rd-ln-d" cx="'+a[0].toFixed(0)+'" cy="'+a[1].toFixed(0)+'" r="2.5"/>';
}
