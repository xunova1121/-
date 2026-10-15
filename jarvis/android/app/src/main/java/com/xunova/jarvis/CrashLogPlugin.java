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
        call.resolve(r);
    }
}
