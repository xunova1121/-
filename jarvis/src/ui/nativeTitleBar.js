/** Windows 原生窗口按钮在网页遮罩上方，需要显式同步最终合成颜色。 */
function rgba(value, fallback=[255,255,255,1]) {
  const hex=String(value||'').match(/^#([a-f\d]{6})$/i);
  if(hex)return [0,2,4].map(i=>parseInt(hex[1].slice(i,i+2),16)).concat(1);
  const rgb=String(value||'').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
  return rgb?[Number(rgb[1]),Number(rgb[2]),Number(rgb[3]),rgb[4]===undefined?1:Number(rgb[4])]:fallback;
}
export function compositeTitleBar(base, backdrop) {
  const bg=rgba(base),fg=rgba(backdrop,[0,0,0,0]),alpha=Math.max(0,Math.min(1,fg[3]));
  const channels=bg.slice(0,3).map((v,i)=>Math.round(v*(1-alpha)+fg[i]*alpha));
  return {color:'#'+channels.map(v=>Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0')).join('').toUpperCase(),symbolColor:channels[0]*.299+channels[1]*.587+channels[2]*.114<140?'#FFFFFF':'#72727D',height:32};
}
export function createTitleBarSync({setTitleBar,getColors}) {
  let last='';
  return async()=>{
    const {base,backdrop}=getColors(),theme=compositeTitleBar(base,backdrop),key=JSON.stringify(theme);
    if(key===last)return;
    last=key;
    try{await setTitleBar(theme);}catch{if(last===key)last='';}
  };
}
export function initNativeTitleBar(desktop=globalThis.jarvisDesktop) {
  if(!desktop?.setTitleBar)return ()=>{};
  const sync=createTitleBarSync({setTitleBar:o=>desktop.setTitleBar(o),getColors:()=>{
    const bar=document.querySelector('.weiyang-titlebar')||document.querySelector('.topbar');
    const modal=[...document.querySelectorAll('dialog[open]')].filter(d=>d.matches(':modal')).at(-1);
    return {base:bar?getComputedStyle(bar).backgroundColor:'#FFFFFF',backdrop:modal?getComputedStyle(modal,'::backdrop').backgroundColor:''};
  }});
  const observer=new MutationObserver(()=>{sync();});
  observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
  const themeObserver=new MutationObserver(()=>{sync();});themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  addEventListener('jarvis:sync-titlebar',sync);
  sync();return()=>{observer.disconnect();themeObserver.disconnect();removeEventListener('jarvis:sync-titlebar',sync);};
}
