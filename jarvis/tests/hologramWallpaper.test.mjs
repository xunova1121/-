import {describe,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {createWallpaper,hitsCompanion} from '../desktop/wallpaper.mjs';

describe('全息陪伴桌面',()=>{
  it('只捕捉角色和聊天区域，屏幕坐标正确换算',()=>{
    const bounds={x:900,y:100},regions=[{x:100,y:60,width:180,height:250},{x:10,y:350,width:400,height:160}];
    expect(hitsCompanion({x:1050,y:200},bounds,regions)).toBe(true);
    expect(hitsCompanion({x:920,y:500},bounds,regions)).toBe(true);
    expect(hitsCompanion({x:905,y:120},bounds,regions)).toBe(false);
    expect(hitsCompanion({x:100,y:200},bounds,regions)).toBe(false);
  });
  it('背景与互动窗口分离，关闭清理窗口和命中轮询',()=>{
    vi.useFakeTimers();const windows=[];
    class Window extends EventEmitter{
      constructor(options){super();this.options=options;this.webContents={send:vi.fn()};this.ignore=[];windows.push(this);}
      loadURL(url){this.url=url;}setIgnoreMouseEvents(ignore){this.ignore.push(ignore);}showInactive(){this.visible=true;}hide(){this.visible=false;}isVisible(){return!!this.visible;}isDestroyed(){return false;}isFocused(){return false;}getBounds(){return{x:100,y:100,width:460,height:600};}destroy(){this.destroyed=true;this.emit('closed');}
    }
    const screen={getPrimaryDisplay:()=>({bounds:{x:0,y:0,width:1366,height:768},workArea:{x:0,y:0,width:1366,height:728}}),getCursorScreenPoint:()=>({x:150,y:160})};
    const wallpaper=createWallpaper({BrowserWindow:Window,screen,url:'http://localhost/wallpaper.html',preload:'preload',platform:'test'});
    wallpaper.show();windows.forEach(w=>w.emit('ready-to-show'));
    expect(windows).toHaveLength(2);expect(windows[0].options.focusable).toBe(false);expect(windows[1].options.transparent).toBe(true);expect(windows[1].options.alwaysOnTop).toBe(false);
    wallpaper.setRegions([{x:20,y:30,width:100,height:100},{x:NaN,y:0,width:1,height:1}]);vi.advanceTimersByTime(100);expect(windows[1].ignore.at(-1)).toBe(false);
    wallpaper.send({say:'已完成'});expect(windows[1].webContents.send).toHaveBeenCalledWith('jarvis:wallpaper',{say:'已完成'});
    wallpaper.pause(true);expect(windows.every(w=>!w.visible)).toBe(true);wallpaper.pause(false);expect(windows.every(w=>w.visible)).toBe(true);
    expect(wallpaper.setScale(9).scale).toBe(1.2);wallpaper.close();expect(windows.every(w=>w.destroyed)).toBe(true);expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
  });
});
