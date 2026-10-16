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
        if(!safe)edit.putLong("lastCrash",0).putInt("consecutive",0).putBoolean("softwareLayer",false);
        edit.apply();call.resolve();
    }
    /** 网页每隔几秒报一次当前界面（只是界面名和规模），渲染进程崩溃时写进异常记录 */
    @PluginMethod public void note(PluginCall call){
        String screen=call.getString("screen","");
        getContext().getSharedPreferences("render-health",android.content.Context.MODE_PRIVATE).edit().putString("lastScreen",screen.length()>200?screen.substring(0,200):screen).apply();
        call.resolve();
    }
    @PluginMethod public void diagnostics(PluginCall call){
        JSObject result=new JSObject();
        result.put("app",CrashLog.appVersion(getContext()));result.put("sdk",android.os.Build.VERSION.SDK_INT);
        result.put("device",android.os.Build.MANUFACTURER+" "+android.os.Build.MODEL);
        result.put("safeDisplay",MainActivity.safeDisplay(getContext()));
        result.put("softwareLayer",getContext().getSharedPreferences("render-health",android.content.Context.MODE_PRIVATE).getBoolean("softwareLayer",false));
        result.put("exitDetails",ExitReasons.since(getContext(),0));
        result.put("lastRenderer",getContext().getSharedPreferences("render-health",android.content.Context.MODE_PRIVATE).getString("lastRenderer",""));
        if(android.os.Build.VERSION.SDK_INT>=26){android.content.pm.PackageInfo web=android.webkit.WebView.getCurrentWebViewPackage();result.put("webview",web==null?"unknown":web.versionName);}
        if(android.os.Build.VERSION.SDK_INT>=30){
            org.json.JSONArray exits=new org.json.JSONArray();
            try{
                android.app.ActivityManager manager=(android.app.ActivityManager)getContext().getSystemService(android.content.Context.ACTIVITY_SERVICE);
                for(android.app.ApplicationExitInfo info:manager.getHistoricalProcessExitReasons(getContext().getPackageName(),0,5)){
                    JSObject row=new JSObject();row.put("time",info.getTimestamp());row.put("reason",info.getReason());row.put("status",info.getStatus());row.put("importance",info.getImportance());row.put("pssKB",info.getPss());row.put("rssKB",info.getRss());exits.put(row);
                }
            }catch(Exception ignored){ }
            result.put("exits",exits);
        }
        call.resolve(result);
    }
    @PluginMethod public void copyDiagnostics(PluginCall call){
        String text=call.getString("text","");
        if(text.length()>16000)text=text.substring(0,16000);
        ((android.content.ClipboardManager)getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE)).setPrimaryClip(android.content.ClipData.newPlainText("未央异常诊断",text));
        call.resolve();
    }
}
