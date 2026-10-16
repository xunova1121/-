package com.xunova.jarvis;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.View;
import android.view.ViewParent;
import android.view.Window;
import android.view.WindowInsetsController;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 原生状态栏、手势条和顶部使用同一主题；不让白色状态栏留在夜间界面。 */
@CapacitorPlugin(name="WindowColor")
public class WindowColorPlugin extends Plugin {
    @PluginMethod public void set(PluginCall call) {
        final int color;
        try { color=Color.parseColor(call.getString("color","#FCFBFF")); }
        catch(IllegalArgumentException error){call.reject("颜色格式不对");return;}
        final boolean light=call.getBoolean("light",true);
        getActivity().runOnUiThread(()->{
            if(getActivity().isDestroyed() || (getActivity() instanceof MainActivity && ((MainActivity)getActivity()).isRendererGone())){call.resolve();return;}
            Window window=getActivity().getWindow();
            window.setBackgroundDrawable(new ColorDrawable(color));
            window.getDecorView().setBackgroundColor(color);
            window.setStatusBarColor(color);window.setNavigationBarColor(color);
            if(Build.VERSION.SDK_INT>=29){window.setStatusBarContrastEnforced(false);window.setNavigationBarContrastEnforced(false);}
            int flags=window.getDecorView().getSystemUiVisibility();
            flags=light?flags|View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR:flags&~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if(Build.VERSION.SDK_INT>=26)flags=light?flags|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR:flags&~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            window.getDecorView().setSystemUiVisibility(flags);
            if(Build.VERSION.SDK_INT>=30&&window.getInsetsController()!=null){
                int appearance=WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                window.getInsetsController().setSystemBarsAppearance(light?appearance:0,appearance);
            }
            WebView web=getBridge().getWebView();web.setBackgroundColor(color);
            ViewParent parent=web.getParent();if(parent instanceof View)((View)parent).setBackgroundColor(color);
            call.resolve();
        });
    }
}
