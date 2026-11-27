package com.xunova.jarvis;

import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.view.View;
import android.view.ViewGroup;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private boolean rendererGone = false;
    private volatile boolean softwareDrawing;
    private final WorkshopDrawing workshopDrawing = new WorkshopDrawing();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable endRescue = this::restoreDefaultDrawing;
    private long rescueEndsElapsed;
    private boolean foreground;
    public boolean isRendererGone(){return rendererGone;}
    boolean usesSoftwareDrawing(){return softwareDrawing;}
    boolean usesWorkshopDrawing(){return workshopDrawing.active();}
    @Override public void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);takeShare(intent);}
    /** “分享 → 未央”：交给 ShareIntakePlugin 复制文件，网页再取（见 src/app/shareIntake.js） */
    private void takeShare(Intent intent){
        if(intent==null||getBridge()==null)return;
        String action=intent.getAction();
        if(!Intent.ACTION_SEND.equals(action)&&!Intent.ACTION_SEND_MULTIPLE.equals(action))return;
        com.getcapacitor.PluginHandle h=getBridge().getPlugin("ShareIntake");
        if(h!=null)((ShareIntakePlugin)h.getInstance()).receive(intent);
    }
    private SharedPreferences health() { return getSharedPreferences("render-health",MODE_PRIVATE); }
    static boolean safeDisplay(Context context) {
        SharedPreferences prefs=context.getSharedPreferences("render-health",MODE_PRIVATE);
        // 旧版把崩溃、内存提醒都写成永久的 safeDisplay=true，分不清是不是手动开的：升级后清掉一次，只认新的手动开关
        if (!prefs.getBoolean("safeDisplayLimited", false)) prefs.edit().remove("safeDisplay").putBoolean("safeDisplayLimited", true).commit();
        return RenderRecovery.safeDisplayActive(prefs.getBoolean("safeDisplayManual",false),prefs.getLong("lastCrash",0),prefs.getLong("lastTrim",0),System.currentTimeMillis());
    }
    private static String webViewVersion() {
        if (Build.VERSION.SDK_INT < 26) return "";
        android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
        return provider == null || provider.versionName == null ? "" : provider.versionName;
    }

    // BridgeActivity 已创建视图，但此时还没有加载网页。让第一帧就使用选定的绘制方式。
    @Override protected void load() {
        SharedPreferences prefs = health();
        WebView web = findViewById(com.getcapacitor.android.R.id.webview);
        if (web != null) {
            boolean manual = prefs.getBoolean("softwareLayer", false);
            long now = System.currentTimeMillis();
            long rescueStarted = prefs.getLong("softwareRescueAt", 0);
            String version = rescueStarted > 0 ? webViewVersion() : "";
            if (RenderRecovery.softwareLayerNow(manual, Build.MANUFACTURER, version, prefs.getString("hardwareCrashVersion", ""), rescueStarted, now)) {
                web.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
                if (!manual) {
                    long remaining = RenderRecovery.WINDOW_MS - (now - rescueStarted);
                    rescueEndsElapsed = SystemClock.elapsedRealtime() + remaining;
                }
            }
        }
        softwareDrawing = web != null && web.getLayerType() == View.LAYER_TYPE_SOFTWARE;
        super.load();
        scheduleRescueExpiry();
    }

    void restoreDefaultDrawing() {
        mainHandler.removeCallbacks(endRescue);
        if (rescueEndsElapsed > 0 && !rendererGone) health().edit().remove("softwareRescueAt").apply();
        rescueEndsElapsed = 0;
        workshopDrawing.userChoseDefault();
        if (!rendererGone && getBridge() != null && softwareDrawing) {
            WebView web = getBridge().getWebView();
            web.setLayerType(View.LAYER_TYPE_NONE, null);
            softwareDrawing = web.getLayerType() == View.LAYER_TYPE_SOFTWARE;
        }
    }

    private void scheduleRescueExpiry() {
        if (rescueEndsElapsed == 0) return;
        mainHandler.removeCallbacks(endRescue);
        long remaining = rescueEndsElapsed - SystemClock.elapsedRealtime();
        if (remaining > 0) mainHandler.postDelayed(endRescue, remaining);
        else restoreDefaultDrawing();
    }

    JSObject setWorkshopDrawing(boolean visible, long revision) {
        String status = workshopDrawing.request(visible, revision) ? applyWorkshopDrawing() : "stale";
        JSObject result = new JSObject();
        result.put("status", status);
        result.put("active", !rendererGone && workshopDrawing.active());
        result.put("softwareLayer", softwareDrawing);
        return result;
    }

    private String applyWorkshopDrawing() {
        if (rendererGone || getBridge() == null || isFinishing() || isDestroyed()) return "unavailable";
        WebView web = getBridge().getWebView();
        boolean entering = workshopDrawing.requested() && foreground;
        boolean cooldown = false;
        if (entering) {
            SharedPreferences prefs = health();
            long crash = prefs.getLong("workshopCrashAt", 0);
            cooldown = crash > 0 && WorkshopDrawing.coolingDown(crash, System.currentTimeMillis(),
                    prefs.getString("workshopCrashVersion", ""), webViewVersion());
        }
        boolean supportsVideo = !web.isAttachedToWindow() || web.isHardwareAccelerated();
        boolean previous = web.getLayerType() == View.LAYER_TYPE_SOFTWARE;
        boolean software = workshopDrawing.softwareFor(foreground && !cooldown && supportsVideo, previous);
        if (previous != software) web.setLayerType(software ? View.LAYER_TYPE_SOFTWARE : View.LAYER_TYPE_NONE, null);
        softwareDrawing = web.getLayerType() == View.LAYER_TYPE_SOFTWARE;
        if (workshopDrawing.requested() && !foreground) return "background";
        if (cooldown) return "cooldown";
        return entering && !supportsVideo ? "unavailable" : "applied";
    }

    @Override public void onResume() {
        super.onResume();
        foreground = true;
        // postDelayed 不计深度睡眠，回到前台时按实际剩余时间重排。
        scheduleRescueExpiry();
        if (workshopDrawing.requested()) applyWorkshopDrawing();
    }
    @Override public void onDestroy() {
        mainHandler.removeCallbacks(endRescue);
        super.onDestroy();
    }
    @Override public void onPause() {
        foreground = false;
        if (workshopDrawing.active()) applyWorkshopDrawing();
        super.onPause();
        if(TaskService.running && !rendererGone && getBridge()!=null)getBridge().getWebView().onResume();
    }
    @Override public void onCreate(Bundle state) {
        CrashLog.install(this);
        registerPlugin(PhoneControlPlugin.class);
        registerPlugin(ShareReturnPlugin.class);
        registerPlugin(WeatherLocationPlugin.class);registerPlugin(CompanionWallpaperPlugin.class);registerPlugin(WindowColorPlugin.class);registerPlugin(AppUpdatePlugin.class);registerPlugin(CrashLogPlugin.class);
        registerPlugin(NativeStreamPlugin.class);registerPlugin(MobileSpeechPlugin.class);registerPlugin(EdgeSpeechPlugin.class);
        registerPlugin(QwenRealtimePlugin.class);registerPlugin(BackgroundTaskPlugin.class);registerPlugin(KeepAwakePlugin.class);
        registerPlugin(ShareIntakePlugin.class);
        super.onCreate(state);
        // 被系统回收后重建时 state 不为空，这时的启动意图是旧的分享，不再收一次
        if(state==null)takeShare(getIntent());
        // 开着“后台待命”的：每次打开都挂上通知（被系统关掉、划掉后再打开时恢复）
        if(StandbyService.enabled(this))StandbyService.apply(this,true);
        if (getBridge() == null) return; // 系统没有可用 WebView 时保留 Capacitor 的原生提示页。
        WebView web=getBridge().getWebView();
        if(Build.VERSION.SDK_INT>=26)web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT,true);
        final String script="window.__jarvisRenderSafe="+safeDisplay(this)+";";
        try {
            web.evaluateJavascript(script,null);
        }catch(Exception e){CrashLog.write(this,"轻量界面预置："+e.getMessage());}
        getBridge().addWebViewListener(new WebViewListener(){
            @Override public void onPageStarted(WebView view) {
                workshopDrawing.documentStarted(System.currentTimeMillis());
                if (workshopDrawing.active()) applyWorkshopDrawing();
            }
            @Override public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail){
                if(rendererGone)return true; rendererGone=true;
                long now=System.currentTimeMillis();SharedPreferences prefs=health();
                int count=RenderRecovery.nextCount(prefs.getLong("lastCrash",0),prefs.getInt("consecutive",0),now);
                ActivityManager.MemoryInfo memory=new ActivityManager.MemoryInfo();((ActivityManager)getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(memory);
                Runtime runtime=Runtime.getRuntime();
                String version = webViewVersion();
                boolean crashed = detail != null && detail.didCrash();
                boolean wasSafe = safeDisplay(MainActivity.this);
                String crashVersion = RenderRecovery.eligibleHardwareCrash(Build.MANUFACTURER, version, foreground,
                        workshopDrawing.active(), softwareDrawing, crashed, memory.lowMemory) ? version : "";
                boolean fallback = RenderRecovery.repeatedHardwareCrash(crashVersion, prefs.getString("hardwareCrashVersion", ""),
                        wasSafe, prefs.getLong("lastCrash", 0), now);
                SharedPreferences.Editor record = prefs.edit().putLong("lastCrash",now).putInt("consecutive",count);
                if (crashed && !memory.lowMemory && workshopDrawing.active()) {
                    record.putLong("workshopCrashAt", now).putString("workshopCrashVersion", version);
                }
                record.putString("hardwareCrashVersion", crashVersion);
                if (fallback) record.putLong("softwareRescueAt", now); else record.remove("softwareRescueAt");
                String report="WebView="+version+"，didCrash="+crashed+"，priority="+(detail==null?-1:detail.rendererPriorityAtExit())+"，可用内存="+memory.availMem/1048576+"MB，lowMemory="+memory.lowMemory+"，JavaHeap="+(runtime.totalMemory()-runtime.freeMemory())/1048576+"/"+runtime.maxMemory()/1048576+"MB，连续="+count+"，软件绘制="+softwareDrawing+"，"+Build.MANUFACTURER+" "+Build.MODEL+"，崩溃前界面="+prefs.getString("lastScreen","未知");
                if (workshopDrawing.active()) report += "，小屋前台绘制";
                record.putString("lastRenderer",new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss",java.util.Locale.CHINA).format(new java.util.Date(now))+" App="+CrashLog.appVersion(MainActivity.this)+"，"+report).commit();
                CrashLog.write(MainActivity.this,report);
                String restartMode = fallback || softwareDrawing ? "软件绘制" : "兼容显示";
                CrashLog.write(MainActivity.this,RenderRecovery.autoRestart(count)?"界面进程异常，使用"+restartMode+"恢复一次":"界面连续异常，已停止自动重启，等待手动恢复");
                stopService(new Intent(MainActivity.this,TaskService.class));
                runOnUiThread(()->{
                    // 失效桥不能再接收 onPause/onDetachedFromWindow，否则会再次访问已销毁的 WebView。
                    Bridge dead = bridge;
                    bridge = null;
                    if (dead != null) dead.onDestroy();
                    if(view.getParent() instanceof ViewGroup)((ViewGroup)view.getParent()).removeView(view);view.destroy();
                    if(RenderRecovery.autoRestart(count))recreate();else recoveryScreen();
                });return true;
            }
        });
    }
    @Override public void onTrimMemory(int level){
        super.onTrimMemory(level);
        if(!RenderRecovery.shouldReduceDisplay(level))return;
        // 只是系统提醒内存紧张（多半在后台），不是闪退：不写进异常记录，记下时间供诊断
        health().edit().putLong("lastTrim",System.currentTimeMillis()).putInt("lastTrimLevel",level).apply();
        if(!rendererGone && !isFinishing() && !isDestroyed() && getBridge()!=null){
            getBridge().getWebView().evaluateJavascript("window.dispatchEvent(new Event('jarvis:memory-pressure'));",null);
        }
    }
    private void recoveryScreen(){
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setGravity(Gravity.CENTER_VERTICAL);layout.setPadding(dp(26),dp(30),dp(26),dp(30));layout.setBackgroundColor(Color.rgb(252,251,255));
        TextView title=new TextView(this);title.setText("先稳住，再继续");title.setTextSize(24);title.setTypeface(null,Typeface.BOLD);title.setTextColor(Color.rgb(45,42,66));layout.addView(title);
        TextView message=new TextView(this);message.setText("界面连续异常，已停止自动重启。\n\n可以用兼容显示重新打开；还是不行就试试软件绘制。已保存的对话、文件和设置仍在本机；正在执行但尚未保存的内容需要检查后继续。");message.setTextSize(16);message.setTextColor(Color.rgb(93,87,113));message.setLineSpacing(dp(5),1);message.setPadding(0,dp(20),0,dp(24));layout.addView(message);
        Button retry=new Button(this);retry.setText("用兼容显示重新打开");retry.setOnClickListener(v->{health().edit().putInt("consecutive",0).putLong("lastCrash",0).putBoolean("safeDisplayManual",true).remove("hardwareCrashVersion").remove("softwareRescueAt").putBoolean("softwareLayer",false).commit();recreate();});layout.addView(retry);
        // 兼容显示还是会崩时试这个：整个界面改用软件绘制，绕开手机图形驱动；以后在设置里关掉兼容显示就恢复正常绘制
        Button software=new Button(this);software.setText("用软件绘制重新打开（更稳，会慢一些）");software.setOnClickListener(v->{health().edit().putInt("consecutive",0).putLong("lastCrash",0).putBoolean("safeDisplayManual",true).putBoolean("softwareLayer",true).commit();CrashLog.write(this,"用户选择软件绘制重新打开");recreate();});layout.addView(software);
        Button copy=new Button(this);copy.setText("复制诊断信息");copy.setOnClickListener(v->{((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("未央异常诊断",CrashLog.peek(this)));copy.setText("诊断已复制");});layout.addView(copy);
        Button later=new Button(this);later.setText("稍后再试");later.setOnClickListener(v->moveTaskToBack(true));layout.addView(later);
        android.widget.ScrollView scroll=new android.widget.ScrollView(this);scroll.setFillViewport(true);scroll.addView(layout);setContentView(scroll);
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
}
