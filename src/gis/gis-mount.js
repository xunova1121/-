/* ===== 控件 HTML ===== */
function chrome(){
  var eta='';
  GEO.patrol.forEach(function(v,i){
    eta+='<div data-eta="'+i+'"><em>'+esc(v.id)+'</em><u style="--p:'+(18+i*13)+'%"></u>'
        +'<s>'+v.eta+'分</s><q>'+esc(v.wind||'')+'</q></div>';
  });
  var w=GEO.windNow;
  /* 风向箭头指向风的去向（气象上风从 dir 方向来） */
  var arrow='<svg class="rg-windrose" viewBox="0 0 20 20" style="transform:rotate('+(w.dir+180)+'deg)">'
    +'<path d="M10 2 L14.5 17 L10 13.4 L5.5 17 Z"/></svg>';
  return '<div class="rg-tools">'
    +'<button type="button" class="rg-chip on" data-act="flow"><i></i>航线动效</button>'
    +'<button type="button" class="rg-chip play" data-act="play"><i></i>航线推演</button>'
    +'<button type="button" class="rg-chip wind" data-act="wx" title="查看气象图层">'
      +arrow+'<b>'+w.spd.toFixed(1)+' m/s</b>'+esc(w.from)+'风 '+w.lvl+'级'
    +'</button>'
  +'</div>'
  +'<div class="rg-panel" data-open="'+(panelOpen?1:0)+'">'
    +'<button type="button" class="rg-panel-head" data-act="panel">'
      +'<i></i><b>执法力量</b><em>'+GEO.patrol.length+'</em>'
      +'<span class="rg-caret"></span>'
    +'</button>'
    +'<div class="rg-panel-body"><div>'
      +'<p>AIS / 北斗实时融合 · 最优路径测算中</p>'
      +'<div class="rg-wxline">实况 <b>'+esc(w.from)+'风 '+w.lvl+'级</b> · 风速 <b>'+w.spd.toFixed(1)+' m/s</b>'
        +' · 阵风 <b>'+w.gust.toFixed(1)+' m/s</b> · 浪高 <b>'+w.wave.toFixed(1)+' m</b></div>'
      +'<div class="rg-eta">'+eta+'</div>'
    +'</div></div>'
  +'</div>'
  +'<div class="rg-legend">'
    +'<span class="dash"><i></i>规划航线</span>'
    +'<span class="zn"><i></i>禁捕区</span>'
    +'<span><b class="dot" style="background:#ff6b74"></b>告警 8</span>'
    +'<em>执法力量 '+GEO.patrol.length+' · 规划路径 '+GEO.patrol.length+'</em>'
  +'</div>'
  +'<div class="rg-tip"></div>';
}

/* 信息板默认收起，展开状态跨重绘保持 */
var panelOpen=false;
/* 当前视图：map = 一张图，radar = 雷达态势 */
var view='map';

/* ===== 渲染 ===== */
function render(map){
  var box=map.getBoundingClientRect();
  var w=Math.max(320,Math.round(box.width)), h=Math.max(200,Math.round(box.height));
  proj=buildProj(w,h);
  placed=[];
  /* 为控件预留区域，参与标注避让 */
  reserved=[[8,8,510,34],[w-146,8,140,34],[8,h-46,w-16,38]];

  var root=map.querySelector('.rg-root');
  if(!root){
    root=document.createElement('div');
    root.className='rg-root';
    root.setAttribute('aria-label','江苏近海执法力量与航线规划一张图');
    map.appendChild(root);
    bind(map,root);
  }
  root.hidden = (view!=='map');
  renderRadar(map,w,h);
  viewTabs(map);
  if(view!=='map') return;
  /* 生成顺序 = 标注优先级：目标船 → 执法船 → 禁捕区 → 经纬网 → 城市/港口 */
  var gHub=hubLayer(), gPatrol=patrolLayer(), gZone=zones(), gGrat=graticule(), gAnno=annotations();
  root.innerHTML='<svg viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'">'
    +defs()+basemap()+lanes()+tracks()+gZone+weather()+gGrat+gAnno
    +routes()+fishLayer()+gHub+gPatrol+'</svg>'+chrome();
  setupAnim(map,root);
}

/* ===== 视图切换：一张图 / 雷达态势 ===== */
function viewTabs(map){
  var tabs=map.querySelector('.rd-viewtabs');
  if(!tabs){
    tabs=document.createElement('div');
    tabs.className='rd-viewtabs';
    tabs.innerHTML='<button type="button" data-view="map">一张图</button>'
                  +'<button type="button" data-view="radar">雷达态势</button>';
    tabs.addEventListener('click',function(e){
      var b=e.target.closest('[data-view]'); if(!b) return;
      view=b.dataset.view;
      render(map);
    });
    map.appendChild(tabs);
  }
  [].forEach.call(tabs.querySelectorAll('[data-view]'),function(b){
    b.classList.toggle('on', b.dataset.view===view);
  });
  var exp=map.querySelector('.rd-expand');
  if(view==='radar'&&!exp){
    exp=document.createElement('button');
    exp.type='button'; exp.className='rd-expand'; exp.textContent='⛶ 放大全屏';
    exp.addEventListener('click',function(){ openFullRadar(); });
    map.appendChild(exp);
  } else if(view!=='radar'&&exp){ exp.remove(); }
}
function renderRadar(map,w,h){
  var host=map.querySelector('.rd-host');
  if(view!=='radar'){
    if(host){ stopRadar(); host.remove(); }
    return;
  }
  if(!host){ host=document.createElement('div'); host.className='rd-host'; map.appendChild(host); }
  host.innerHTML=radarMarkup(w,h,false);
  injectSweepGrad(host);
  startRadar(host);
}
/* 扫描扇渐变（两个视图各一份，避免 id 冲突时相互覆盖） */
function injectSweepGrad(host){
  var svg=host.querySelector('.rd-scope svg'); if(!svg) return;
  var d=document.createElementNS('http://www.w3.org/2000/svg','defs');
  d.innerHTML='<linearGradient id="rdSweepGrad" x1="1" y1="0" x2="0" y2="0.6">'
    +'<stop offset="0" stop-color="#7fe8ff" stop-opacity=".55"/>'
    +'<stop offset="1" stop-color="#7fe8ff" stop-opacity="0"/></linearGradient>';
  svg.insertBefore(d, svg.firstChild);
}
/* 全屏雷达大屏 */
var fullWrap=null, fullRO=null;
function openFullRadar(){
  if(fullWrap) return;
  fullWrap=document.createElement('div');
  fullWrap.className='rd-full-wrap';
  document.body.appendChild(fullWrap);
  function paint(){
    var w=fullWrap.clientWidth, h=fullWrap.clientHeight;
    fullWrap.innerHTML='<div class="rd-full-title">全省海洋渔船雷达 · 双光谱协同态势'
      +'<span>'+RADAR.station+'　量程 '+RADAR.rangeNm+' nm　目标 '+RADAR.targets.length+'</span></div>'
      +'<button type="button" class="rd-close" aria-label="关闭">×</button>'
      + radarMarkup(w,h,true);
    injectSweepGrad(fullWrap);
    startRadar(fullWrap);
    fullWrap.querySelector('.rd-close').addEventListener('click',closeFullRadar);
  }
  paint();
  fullRO=new ResizeObserver(function(){ clearTimeout(fullWrap._t);
    fullWrap._t=setTimeout(paint,180); });
  fullRO.observe(fullWrap);
  document.addEventListener('keydown',escFull);
}
function closeFullRadar(){
  if(!fullWrap) return;
  stopRadar();
  if(fullRO){ fullRO.disconnect(); fullRO=null; }
  document.removeEventListener('keydown',escFull);
  fullWrap.remove(); fullWrap=null;
  var map=document.querySelector('.mapcard .map');
  if(map&&view==='radar') renderRadar(map,map.clientWidth,map.clientHeight);
}
function escFull(e){ if(e.key==='Escape') closeFullRadar(); }

/* ===== 动画：航线流光 + 航线推演 ===== */
var anim=null;
function setupAnim(map,root){
  if(anim&&anim.raf) cancelAnimationFrame(anim.raf);
  var hub=P(GEO.hub.ll);
  var lanesArr=[].map.call(root.querySelectorAll('.rg-comet'),function(c,i){
    var len=c.getTotalLength(), seg=Math.max(14,len*0.05);
    c.setAttribute('stroke-dasharray',seg.toFixed(1)+' '+(len+seg).toFixed(1));
    return {
      comet:c, len:len, seg:seg,
      blip:root.querySelector('.rg-blip[data-b="'+i+'"]'),
      hull:root.querySelector('.rg-hull[data-hull="'+i+'"]'),
      lab:root.querySelector('.rg-lab[data-lab="'+i+'"]'),
      rot:root.querySelector('.rg-hull[data-hull="'+i+'"] .rg-rot'),
      eta:root.querySelector('[data-eta="'+i+'"]'),
      etaMin:GEO.patrol[i].eta,
      dur:2600+i*430,
      phase:i*0.19,
      sail:0
    };
  });
  /* 船艏初始朝向 = 航线起点切线 */
  lanesArr.forEach(function(l){
    var p0=l.comet.getPointAtLength(0), p1=l.comet.getPointAtLength(Math.min(12,l.len));
    l.head=Math.atan2(p1.y-p0.y,p1.x-p0.x)*180/Math.PI;
    l.x0=p0.x; l.y0=p0.y;
    l.rot.setAttribute('transform','rotate('+l.head.toFixed(1)+')'+(Math.abs(l.head)>90?' scale(1,-1)':''));
  });
  anim={ raf:0, t0:performance.now(), playing:false, flow:true, lanes:lanesArr, root:root, hub:hub };
  var last=anim.t0;
  function frame(now){
    var dt=Math.min(64,now-last); last=now;
    anim.lanes.forEach(function(l){
      if(anim.flow){
        var prog=((now-anim.t0)/l.dur + l.phase)%1;
        var head=prog*(l.len+l.seg);
        l.comet.style.strokeDashoffset=(-head).toFixed(1);
        var pt=l.comet.getPointAtLength(Math.max(0,Math.min(l.len,head-l.seg*0.5)));
        l.blip.setAttribute('transform','translate('+pt.x.toFixed(1)+','+pt.y.toFixed(1)+')');
        l.blip.style.opacity=(head<l.seg||head>l.len+l.seg*0.6)?0:1;
      }
      if(anim.playing){
        l.sail+=dt/1000*(l.len/(l.etaMin*3.2));   /* ETA 分钟 → 演示秒 */
        if(l.sail>l.len){ l.sail=0; }
        var s=l.sail, p=l.comet.getPointAtLength(s), q=l.comet.getPointAtLength(Math.min(l.len,s+8));
        var ang=Math.atan2(q.y-p.y,q.x-p.x)*180/Math.PI;
        l.hull.setAttribute('transform','translate('+p.x.toFixed(1)+','+p.y.toFixed(1)+')');
        l.lab.setAttribute('transform','translate('+p.x.toFixed(1)+','+p.y.toFixed(1)+')');
        l.rot.setAttribute('transform','rotate('+ang.toFixed(1)+')'+(Math.abs(ang)>90?' scale(1,-1)':''));
        if(l.eta){
          var pct=Math.min(100,Math.round(l.sail/l.len*100));
          l.eta.querySelector('u').style.setProperty('--p',pct+'%');
          l.eta.querySelector('s').textContent=Math.max(0,Math.round(l.etaMin*(1-l.sail/l.len)))+'分';
        }
      }
    });
    anim.raf=requestAnimationFrame(frame);
  }
  anim.raf=requestAnimationFrame(frame);
}
function resetSail(){
  if(!anim) return;
  anim.lanes.forEach(function(l){
    l.sail=0;
    l.hull.setAttribute('transform','translate('+l.x0.toFixed(1)+','+l.y0.toFixed(1)+')');
    l.lab.setAttribute('transform','translate('+l.x0.toFixed(1)+','+l.y0.toFixed(1)+')');
    l.rot.setAttribute('transform','rotate('+l.head.toFixed(1)+')'+(Math.abs(l.head)>90?' scale(1,-1)':''));
    if(l.eta){ l.eta.querySelector('s').textContent=l.etaMin+'分'; }
  });
}

/* ===== 交互 ===== */
function bind(map,root){
  root.addEventListener('click',function(e){
    var btn=e.target.closest('[data-act]');
    if(btn){
      var act=btn.dataset.act;
      if(act==='flow'){
        anim.flow=!anim.flow; btn.classList.toggle('on',anim.flow);
        root.querySelectorAll('.rg-route').forEach(function(p){ p.style.animationPlayState=anim.flow?'running':'paused'; });
        root.querySelectorAll('.rg-comet,.rg-blip').forEach(function(p){ p.style.opacity=anim.flow?'':'0'; });
      } else if(act==='play'){
        anim.playing=!anim.playing; btn.classList.toggle('running',anim.playing);
        btn.lastChild.nodeValue=anim.playing?'停止推演':'航线推演';
        if(!anim.playing) resetSail();
      } else if(act==='panel'){
        panelOpen=!panelOpen;
        btn.parentNode.dataset.open=panelOpen?1:0;
      } else if(act==='wx'){
        var seg=[].filter.call(document.querySelectorAll('.mapcard .seg button'),function(x){
          return x.textContent.trim()==='气象';
        })[0];
        if(seg) seg.click();
      } else if(act==='video'){
        proxyClick(map,'.popup button');
      }
      return;
    }
    var v=e.target.closest('[data-ship]');
    if(v) proxyClick(map,'.ship.s'+v.dataset.ship);
  });
  root.addEventListener('mousemove',function(e){
    var tip=root.querySelector('.rg-tip'); if(!tip) return;
    var v=e.target.closest('[data-tip]');
    if(!v){ tip.classList.remove('show'); return; }
    var parts=v.dataset.tip.split('|');
    tip.innerHTML='<b>'+esc(parts[0])+'</b>'+parts.slice(1).map(esc).join('<br>');
    var r=root.getBoundingClientRect();
    tip.style.left=Math.max(70,Math.min(r.width-70,e.clientX-r.left))+'px';
    tip.style.top=(e.clientY-r.top-6)+'px';
    tip.classList.add('show');
  });
  root.addEventListener('mouseleave',function(){
    var t=root.querySelector('.rg-tip'); if(t) t.classList.remove('show');
  });
}
/* 复用页面原有 React 交互（船舶详情抽屉 / 视频墙） */
function proxyClick(map,sel){
  var el=map.querySelector(sel);
  if(el) el.click();
}

/* ===== 图层联动 ===== */
function syncLayer(map){
  var on=[].filter.call(document.querySelectorAll('.mapcard .seg button'),function(b){
    return b.classList.contains('on');
  })[0];
  map.dataset.layer=on?on.textContent.trim():'渔船';
}

/* ===== 挂载 ===== */
var ro=null, rt=0;
function mount(){
  var map=document.querySelector('.mapcard .map');
  if(!map) return;
  if(map.dataset.realGis==='1'&&map.querySelector('.rg-root')) return;
  map.dataset.realGis='1';
  map.classList.add('js-real-gis');
  render(map);
  syncLayer(map);
  document.querySelectorAll('.mapcard .seg button').forEach(function(b){
    b.addEventListener('click',function(){ setTimeout(function(){ syncLayer(map); },0); });
  });
  if(ro) ro.disconnect();
  ro=new ResizeObserver(function(){
    clearTimeout(rt);
    rt=setTimeout(function(){
      if(document.body.contains(map)){ var pl=anim&&anim.playing; render(map); if(pl){ anim.playing=true;
        var b=map.querySelector('[data-act="play"]'); if(b){ b.classList.add('running'); b.lastChild.nodeValue='停止推演'; } } }
    },160);
  });
  ro.observe(map);
}
var mo=new MutationObserver(function(){ mount(); });
mo.observe(document.documentElement,{childList:true,subtree:true});
mount(); setTimeout(mount,300); setTimeout(mount,1200);
