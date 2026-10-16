package com.xunova.jarvis;

import android.os.Build;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.view.ViewGroup;
import android.app.ActivityManager;
import android.content.Context;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private boolean rendererGone = false;
    @Override protected void onPause() {
        super.onPause();
        // 保留网络任务的 JS 执行；音频、录音由前端生命周期独立停止。
        if (TaskService.running && !rendererGone && getBridge() != null) getBridge().getWebView().onResume();
    }
    @Override
    public void onCreate(Bundle savedInstanceState) {
        CrashLog.install(this);
        registerPlugin(WindowColorPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(CrashLogPlugin.class);
        registerPlugin(MobileSpeechPlugin.class);
        registerPlugin(EdgeSpeechPlugin.class);
        registerPlugin(BackgroundTaskPlugin.class);
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getBridge().getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        }
        long lastCrash = getSharedPreferences("render-health", MODE_PRIVATE).getLong("lastCrash", 0);
        if (System.currentTimeMillis() - lastCrash < 24 * 60 * 60 * 1000L) {
            getBridge().getWebView().setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null);
        }
        // 手机内存紧张时系统会杀掉网页的渲染进程；默认整个 App 跟着退出（看起来就是闪退）。
        // 这里接住：记下原因，重新创建界面（对话都存在本机，重新打开后还在）
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                rendererGone = true;
                boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail != null && detail.didCrash();
                ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
                ((ActivityManager) getSystemService(Context.ACTIVITY_SERVICE)).getMemoryInfo(memory);
                getSharedPreferences("render-health", MODE_PRIVATE).edit().putLong("lastCrash", System.currentTimeMillis()).apply();
                CrashLog.write(MainActivity.this, "WebView=" + (WebView.getCurrentWebViewPackage() == null ? "unknown" : WebView.getCurrentWebViewPackage().versionName) + "，可用内存=" + memory.availMem / 1048576 + "MB，lowMemory=" + memory.lowMemory);
                CrashLog.write(MainActivity.this, crashed ? "界面渲染进程崩溃，已自动重新打开界面" : "界面渲染进程被系统回收（多半是手机内存不够），已自动重新打开界面");
                // 已失效的 WebView 必须移出视图树并销毁，不能让 recreate 重复持有坏的渲染进程。
                runOnUiThread(() -> {
                    if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
                    view.destroy();
                    recreate();
                });
                return true;
            }
        });
    }
}
