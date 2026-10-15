package com.xunova.jarvis;

import android.os.Build;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        CrashLog.install(this);
        registerPlugin(WindowColorPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(CrashLogPlugin.class);
        super.onCreate(savedInstanceState);
        // 手机内存紧张时系统会杀掉网页的渲染进程；默认整个 App 跟着退出（看起来就是闪退）。
        // 这里接住：记下原因，重新创建界面（对话都存在本机，重新打开后还在）
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail != null && detail.didCrash();
                CrashLog.write(MainActivity.this, crashed ? "界面渲染进程崩溃，已自动重新打开界面" : "界面渲染进程被系统回收（多半是手机内存不够），已自动重新打开界面");
                runOnUiThread(MainActivity.this::recreate);
                return true;
            }
        });
    }
}
