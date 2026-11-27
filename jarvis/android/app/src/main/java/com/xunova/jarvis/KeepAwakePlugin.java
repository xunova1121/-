package com.xunova.jarvis;

import android.view.Window;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 屏幕常亮（“智能”档）：未央说话时不让屏幕自己灭；亮着很久没碰手机时只把本 App 窗口调暗省电。
 * 只改这个窗口，不动系统亮度设置；App 退到后台或关掉时系统自动恢复。
 */
@CapacitorPlugin(name="KeepAwake")
public class KeepAwakePlugin extends Plugin {
    @PluginMethod public void set(PluginCall call) {
        final boolean keep=call.getBoolean("keep",false);
        final boolean dim=call.getBoolean("dim",false);
        getActivity().runOnUiThread(()->{
            if(getActivity().isDestroyed()){call.resolve();return;}
            Window window=getActivity().getWindow();
            if(keep)window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            WindowManager.LayoutParams params=window.getAttributes();
            params.screenBrightness=dim?0.05f:WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
            window.setAttributes(params);
            call.resolve();
        });
    }
}
