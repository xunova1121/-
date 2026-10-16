package com.xunova.jarvis;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 读出（并清掉）上次闪退的记录 */
@CapacitorPlugin(name = "CrashLog")
public class CrashLogPlugin extends Plugin {
    @PluginMethod
    public void take(PluginCall call) {
        JSObject r = new JSObject();
        r.put("text", CrashLog.take(getContext()));
        r.put("safeDisplay",MainActivity.safeDisplay(getContext()));
        r.put("consecutive",getContext().getSharedPreferences("render-health",android.content.Context.MODE_PRIVATE).getInt("consecutive",0));
        call.resolve(r);
    }
    @PluginMethod public void setDisplayMode(PluginCall call) {
        boolean safe=call.getBoolean("safe",true);
        android.content.SharedPreferences.Editor edit=getContext().getSharedPreferences("render-health",android.content.Context.MODE_PRIVATE).edit().putBoolean("safeDisplay",safe);
        if(!safe)edit.putLong("lastCrash",0).putInt("consecutive",0);
        edit.apply();call.resolve();
    }
}
