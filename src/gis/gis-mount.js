/* ===== 控件 HTML ===== */
function chrome(){
  var eta='';
  GEO.patrol.forEach(function(v,i){
    eta+='<div data-eta="'+i+'"><em>'+esc(v.id)+'</em><u style="--p:'+(18+i*13)+'%"></u><s>'+v.eta+'分</s></div>';
  });
  return '<div class="rg-tools">'
    +'<button type="button" class="rg-chip on" data-act="flow"><i></i>航线动效</button>'
    +'<button type="button" class="rg-chip play" data-act="play"><i></i>航线推演</button>'
  +'</div>'
  +'<div class="rg-panel">'
    +'<strong>周边执法力量与最优路径</strong>'
    +'<span>AIS / 北斗实时融合 · 可调度 <b>'+GEO.patrol.length+'艘</b></span>'
    +'<div class="rg-eta">'+eta+'</div>'
  +'</div>'
  +'<div class="rg-legend">'
    +'<span class="dash"><i></i>规划航线</span>'
    +'<span class="zn"><i></i>禁捕区</span>'
    +'<span><b class="dot" style="background:#ff6b74"></b>告警 8</span>'
    +'<em>执法力量 '+GEO.patrol.length+' · 规划路径 '+GEO.patrol.length+'</em>'
  +'</div>'
  +'<div class="rg-tip"></div>';
}

/* ===== 渲染 ===== */
function render(map){
  var box=map.getBoundingClientRect();
  var w=Math.max(320,Math.round(box.width)), h=Math.max(200,Math.round(box.height));
  proj=buildProj(w,h);
  placed=[];
  /* 为控件预留区域，参与标注避让 */
  reserved=[[8,8,196,34],[w-234,8,228,142],[8,h-46,w-16,38]];

  var root=map.querySelector('.rg-root');
  if(!root){
    root=document.createElement('div');
    root.className='rg-root';
    root.setAttribute('aria-label','江苏近海执法力量与航线规划一张图');
    map.appendChild(root);
    bind(map,root);
  }
  /* 生成顺序 = 标注优先级：目标船 → 执法船 → 禁捕区 → 经纬网 → 城市/港口 */
  var gHub=hubLayer(), gPatrol=patrolLayer(), gZone=zones(), gGrat=graticule(), gAnno=annotations();
  root.innerHTML='<svg viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'">'
    +defs()+basemap()+lanes()+tracks()+gZone+weather()+gGrat+gAnno
    +routes()+fishLayer()+gHub+gPatrol+'</svg>'+chrome();
  setupAnim(map,root);
}

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
