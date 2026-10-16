package com.xunova.jarvis;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name="BackgroundTask")
public class BackgroundTaskPlugin extends Plugin {
    @Override protected void handleOnDestroy() { getContext().stopService(new Intent(getContext(),TaskService.class)); }
    @PluginMethod public void set(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                boolean active = call.getBoolean("active", false);
                Intent service = new Intent(getContext(),TaskService.class);
                if (active) { if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(service); else getContext().startService(service); }
                else getContext().stopService(service);
                if (Build.VERSION.SDK_INT >= 26) getBridge().getWebView().setRendererPriorityPolicy(android.webkit.WebView.RENDERER_PRIORITY_IMPORTANT,!active);
                call.resolve();
            } catch (Exception e) { call.reject("后台任务保护未开启：" + e.getMessage()); }
        });
    }
}
