/* ===== 雷达态势挂载器 =====
   本文件不改动页面自带的一张图（v105 覆盖层），只做三件事：
   1. 加「一张图 / 雷达态势」视图切换与全屏
   2. 把自带覆盖层里那张常驻的苏盐渔卡改成点击目标船才出现
   3. 挂载雷达视图本身
*/
function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var view='map';

/* ---------- 视图切换 ---------- */
function overlayOf(map){ return map.querySelector('.real-gis-overlay'); }

function applyView(map){
  var ov=overlayOf(map);
  if(ov) ov.classList.toggle('rd-hidden', view!=='map');
  var tabs=map.querySelector('.rd-viewtabs');
  if(tabs) [].forEach.call(tabs.querySelectorAll('[data-view]'),function(b){
    b.classList.toggle('on', b.dataset.view===view);
  });
  var exp=map.querySelector('.rd-expand');
  if(view==='radar'){
    if(!exp){
      exp=document.createElement('button');
      exp.type='button'; exp.className='rd-expand'; exp.textContent='⛶ 放大全屏';
      exp.addEventListener('click',function(){ openFullRadar(); });
      map.appendChild(exp);
    }
    renderRadar(map);
  } else {
    if(exp) exp.remove();
    var host=map.querySelector('.rd-host');
    if(host){ stopRadar(); host.remove(); }
    hideCard(map);
  }
}
function viewTabs(map){
  if(map.querySelector('.rd-viewtabs')) return;
  var tabs=document.createElement('div');
  tabs.className='rd-viewtabs';
  tabs.innerHTML='<button type="button" data-view="map">一张图</button>'
                +'<button type="button" data-view="radar">雷达态势</button>';
  tabs.addEventListener('click',function(e){
    var b=e.target.closest('[data-view]'); if(!b) return;
    view=b.dataset.view; applyView(map);
  });
  map.appendChild(tabs);
}

/* ---------- 雷达 ---------- */
function renderRadar(map){
  var host=map.querySelector('.rd-host');
  if(!host){ host=document.createElement('div'); host.className='rd-host'; map.appendChild(host); }
  host.innerHTML=radarMarkup(map.clientWidth, map.clientHeight, false);
  injectSweepGrad(host);
  startRadar(host);
}
function injectSweepGrad(host){
  var svg=host.querySelector('.rd-scope svg'); if(!svg) return;
  var d=document.createElementNS('http://www.w3.org/2000/svg','defs');
  d.innerHTML='<linearGradient id="rdSweepGrad" x1="1" y1="0" x2="0" y2="0.6">'
    +'<stop offset="0" stop-color="#7fe8ff" stop-opacity=".55"/>'
    +'<stop offset="1" stop-color="#7fe8ff" stop-opacity="0"/></linearGradient>';
  svg.insertBefore(d, svg.firstChild);
}
var fullWrap=null, fullRO=null;
function openFullRadar(){
  if(fullWrap) return;
  fullWrap=document.createElement('div');
  fullWrap.className='rd-full-wrap';
  document.body.appendChild(fullWrap);
  function paint(){
    fullWrap.innerHTML='<div class="rd-full-title">全省海洋渔船雷达 · 双光谱协同态势'
      +'<span>'+esc(RADAR.station)+'　量程 '+RADAR.rangeNm+' nm　目标 '+RADAR.targets.length+'</span></div>'
      +'<button type="button" class="rd-close" aria-label="关闭">×</button>'
      + radarMarkup(fullWrap.clientWidth, fullWrap.clientHeight, true);
    injectSweepGrad(fullWrap);
    startRadar(fullWrap);
    fullWrap.querySelector('.rd-close').addEventListener('click',closeFullRadar);
  }
  paint();
  fullRO=new ResizeObserver(function(){
    clearTimeout(fullWrap._t); fullWrap._t=setTimeout(paint,180);
  });
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
  if(map&&view==='radar') renderRadar(map);
}
function escFull(e){ if(e.key==='Escape'){ if(fullWrap) closeFullRadar(); } }

/* ---------- 苏盐渔卡：改成点击目标船才出现 ---------- */
function showCard(map){
  var c=map.querySelector('.gis-vessel-card'); if(!c) return;
  c.classList.add('rd-card-on');
}
function hideCard(map){
  var c=map.querySelector('.gis-vessel-card'); if(!c) return;
  c.classList.remove('rd-card-on');
}
function wireCard(map){
  var ov=overlayOf(map); if(!ov||ov.dataset.rdCard==='1') return;
  ov.dataset.rdCard='1';
  var card=map.querySelector('.gis-vessel-card');
  if(card&&!card.querySelector('.rd-card-x')){
    var x=document.createElement('button');
    x.type='button'; x.className='rd-card-x'; x.textContent='×';
    x.setAttribute('aria-label','关闭');
    card.appendChild(x);
  }
  /* 目标船本身很小，补一个透明的点击热区 */
  var core=ov.querySelector('.target-core');
  if(core&&!ov.querySelector('.rd-card-hit')){
    var hit=document.createElementNS('http://www.w3.org/2000/svg','circle');
    hit.setAttribute('class','rd-card-hit');
    hit.setAttribute('cx',core.getAttribute('cx'));
    hit.setAttribute('cy',core.getAttribute('cy'));
    hit.setAttribute('r','30');
    var ttl=document.createElementNS('http://www.w3.org/2000/svg','title');
    ttl.textContent='点击查看 苏盐渔05168 详情';
    hit.appendChild(ttl);
    core.parentNode.insertBefore(hit, core.nextSibling);
  }
  ov.addEventListener('click',function(e){
    if(e.target.closest('.rd-card-x')){ hideCard(map); return; }
    if(e.target.closest('[data-gis-action]')) return;        /* 卡内按钮走原逻辑 */
    if(e.target.closest('.gis-vessel-card')) return;
    if(e.target.closest('.rd-card-hit,.target-core,.target-boat,.target-label,.target-sub')){
      var c=map.querySelector('.gis-vessel-card');
      if(c) c.classList.toggle('rd-card-on');
      return;
    }
    hideCard(map);                                            /* 点空白收起 */
  },true);
}

/* ---------- 移植到自带覆盖层：实况风速胶囊 + 目标船闪烁 ----------
   这两项是先前已确认的需求，原本做在重制版地图里；
   现在一张图改用页面自带覆盖层，所以在它的工具条上补回来。 */
var WIND={ from:"东北", dir:45, spd:12.4, lvl:6, gust:18.6, wave:2.1 };
function wireWind(map){
  var bar=map.querySelector('.real-gis-overlay .gis-toolbar');
  if(!bar||bar.dataset.rdWind==='1') return;
  bar.dataset.rdWind='1';
  var chip=document.createElement('button');
  chip.type='button';
  chip.className='gis-chip rd-wind-chip';
  chip.title='实况风况　阵风 '+WIND.gust.toFixed(1)+' m/s　浪高 '+WIND.wave.toFixed(1)+' m　点击查看气象图层';
  chip.innerHTML='<svg class="rd-windrose" viewBox="0 0 20 20" style="transform:rotate('
    +(WIND.dir+180)+'deg)"><path d="M10 2 L14.5 17 L10 13.4 L5.5 17 Z"/></svg>'
    +'<b>'+WIND.spd.toFixed(1)+' m/s</b>'+esc(WIND.from)+'风 '+WIND.lvl+'级';
  chip.addEventListener('click',function(){
    var seg=[].filter.call(document.querySelectorAll('.mapcard .seg button'),function(x){
      return x.textContent.trim()==='气象';
    })[0];
    if(seg) seg.click();
  });
  bar.appendChild(chip);
}

/* ---------- 挂载 ---------- */
var rdRO=null, rdT=0;
function rdMount(){
  var map=document.querySelector('.mapcard .map');
  if(!map) return;
  wireCard(map);
  wireWind(map);
  viewTabs(map);
  if(map.dataset.rdInit!=='1'){
    map.dataset.rdInit='1';
    applyView(map);
    if(rdRO) rdRO.disconnect();
    rdRO=new ResizeObserver(function(){
      clearTimeout(rdT);
      rdT=setTimeout(function(){
        if(document.body.contains(map)&&view==='radar') renderRadar(map);
      },180);
    });
    rdRO.observe(map);
  }
}
new MutationObserver(function(){
  var map=document.querySelector('.mapcard .map');
  if(map&&map.dataset.rdInit!=='1') rdMount();
  else if(map&&!map.querySelector('.rd-viewtabs')) rdMount();
}).observe(document.documentElement,{childList:true,subtree:true});
rdMount(); setTimeout(rdMount,400); setTimeout(rdMount,1300);
