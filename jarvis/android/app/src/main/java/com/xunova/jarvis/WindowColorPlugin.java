package com.xunova.jarvis;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.view.ViewParent;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 状态栏、手势条下面露出的底色跟随界面明暗（旧版系统 WebView 不画到状态栏下面，露出的是这里的颜色）。
 */
@CapacitorPlugin(name = "WindowColor")
public class WindowColorPlugin extends Plugin {
    @PluginMethod
    public void set(PluginCall call) {
        final int color;
        try {
            color = Color.parseColor(call.getString("color", "#DDE1FB"));
        } catch (IllegalArgumentException e) {
            call.reject("颜色格式不对");
            return;
        }
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().setBackgroundDrawable(new ColorDrawable(color));
            getActivity().getWindow().getDecorView().setBackgroundColor(color);
            WebView webView = getBridge().getWebView();
            webView.setBackgroundColor(color);
            ViewParent parent = webView.getParent();
            if (parent instanceof View) ((View) parent).setBackgroundColor(color);
            call.resolve();
        });
    }
}
