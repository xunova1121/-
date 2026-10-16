package com.xunova.jarvis;

import android.os.Build;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
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
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private boolean rendererGone = false;
    private SharedPreferences health() { return getSharedPreferences("render-health",MODE_PRIVATE); }
    static boolean safeDisplay(Context context) {
        SharedPreferences prefs=context.getSharedPreferences("render-health",MODE_PRIVATE);
        return prefs.getBoolean("safeDisplay",false) || RenderRecovery.recent(prefs.getLong("lastCrash",0),System.currentTimeMillis(),24*60*60*1000L);
    }
    @Override public void onPause() {
        super.onPause();
        if(TaskService.running && !rendererGone && getBridge()!=null)getBridge().getWebView().onResume();
    }
    @Override public void onCreate(Bundle state) {
        CrashLog.install(this);
        registerPlugin(WindowColorPlugin.class);registerPlugin(AppUpdatePlugin.class);registerPlugin(CrashLogPlugin.class);
        registerPlugin(MobileSpeechPlugin.class);registerPlugin(EdgeSpeechPlugin.class);registerPlugin(BackgroundTaskPlugin.class);
        super.onCreate(state);
        WebView web=getBridge().getWebView();
        if(Build.VERSION.SDK_INT>=26)web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT,true);
        // 保持平台默认绘图路径；不再因为一次异常强制软件绘制 24 小时。
        final String script="window.__jarvisRenderSafe="+safeDisplay(this)+";";
        try {
            web.evaluateJavascript(script,null);
        }catch(Exception e){CrashLog.write(this,"轻量界面预置："+e.getMessage());}
        getBridge().addWebViewListener(new WebViewListener(){
            @Override public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail){
                if(rendererGone)return true; rendererGone=true;
                long now=System.currentTimeMillis();SharedPreferences prefs=health();
                int count=RenderRecovery.nextCount(prefs.getLong("lastCrash",0),prefs.getInt("consecutive",0),now);
                prefs.edit().putLong("lastCrash",now).putInt("consecutive",count).putBoolean("safeDisplay",true).commit();
                ActivityManager.MemoryInfo memory=new ActivityManager.MemoryInfo();((ActivityManager)getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(memory);
                Runtime runtime=Runtime.getRuntime();
                android.content.pm.PackageInfo provider=WebView.getCurrentWebViewPackage();
                String version=provider==null?"unknown":provider.versionName;
                CrashLog.write(MainActivity.this,"WebView="+version+"，didCrash="+(detail!=null&&detail.didCrash())+"，priority="+(detail==null?-1:detail.rendererPriorityAtExit())+"，可用内存="+memory.availMem/1048576+"MB，lowMemory="+memory.lowMemory+"，JavaHeap="+(runtime.totalMemory()-runtime.freeMemory())/1048576+"/"+runtime.maxMemory()/1048576+"MB，连续="+count+"，"+Build.MANUFACTURER+" "+Build.MODEL);
                CrashLog.write(MainActivity.this,RenderRecovery.autoRestart(count)?"界面进程异常，开启兼容显示后恢复一次":"界面连续异常，已停止自动重启，等待手动恢复");
                stopService(new Intent(MainActivity.this,TaskService.class));
                runOnUiThread(()->{
                    if(view.getParent() instanceof ViewGroup)((ViewGroup)view.getParent()).removeView(view);view.destroy();
                    if(RenderRecovery.autoRestart(count))recreate();else recoveryScreen();
                });return true;
            }
        });
    }
    private void recoveryScreen(){
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setGravity(Gravity.CENTER_VERTICAL);layout.setPadding(dp(26),dp(30),dp(26),dp(30));layout.setBackgroundColor(Color.rgb(252,251,255));
        TextView title=new TextView(this);title.setText("先稳住，再继续");title.setTextSize(24);title.setTypeface(null,Typeface.BOLD);title.setTextColor(Color.rgb(45,42,66));layout.addView(title);
        TextView message=new TextView(this);message.setText("界面连续异常，已停止自动重启。\n\n可以用兼容显示重新打开。已保存的对话、文件和设置仍在本机；正在执行但尚未保存的内容需要检查后继续。");message.setTextSize(16);message.setTextColor(Color.rgb(93,87,113));message.setLineSpacing(dp(5),1);message.setPadding(0,dp(20),0,dp(24));layout.addView(message);
        Button retry=new Button(this);retry.setText("用兼容显示重新打开");retry.setOnClickListener(v->{health().edit().putInt("consecutive",0).putLong("lastCrash",0).putBoolean("safeDisplay",true).commit();recreate();});layout.addView(retry);
        Button copy=new Button(this);copy.setText("复制诊断信息");copy.setOnClickListener(v->{((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("未央异常诊断",CrashLog.peek(this)));copy.setText("诊断已复制");});layout.addView(copy);
        Button later=new Button(this);later.setText("稍后再试");later.setOnClickListener(v->moveTaskToBack(true));layout.addView(later);
        setContentView(layout);
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
}
