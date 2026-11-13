package com.xunova.jarvis;

import android.app.WallpaperManager;
import android.content.ComponentName;
import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 交给系统预览和确认壁纸；不私自替换用户的桌面。 */
@CapacitorPlugin(name="CompanionWallpaper")
public class CompanionWallpaperPlugin extends Plugin {
    @PluginMethod public void open(PluginCall call) {
        getActivity().runOnUiThread(()->{
            try {
                Intent intent=new Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER);
                intent.putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT,new ComponentName(getContext(),CompanionWallpaperService.class));
                getActivity().startActivity(intent);call.resolve();
            } catch(Exception error){call.reject("这台手机未开放动态壁纸预览，可以继续使用应用内全息陪伴。",error);}
        });
    }
    @PluginMethod public void consumeOpen(PluginCall call) {
        getActivity().runOnUiThread(()->{
            Intent intent=getActivity().getIntent();boolean open=intent!=null&&intent.getBooleanExtra("openHologram",false);
            if(intent!=null)intent.removeExtra("openHologram");JSObject result=new JSObject();result.put("open",open);call.resolve(result);
        });
    }
}
