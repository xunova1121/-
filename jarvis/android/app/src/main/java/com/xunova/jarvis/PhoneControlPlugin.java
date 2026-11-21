package com.xunova.jarvis;

import android.content.Intent;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.UUID;

@CapacitorPlugin(name="PhoneControl")
public class PhoneControlPlugin extends Plugin {
    @PluginMethod public void status(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            PhoneAccessibilityService service = PhoneAccessibilityService.instance;
            JSObject state = service == null ? new JSObject() : service.state();
            if (service == null) { state.put("enabled", false); state.put("accessibility", false); }
            android.content.SharedPreferences prefs = getContext().getSharedPreferences("phone-installation", android.content.Context.MODE_PRIVATE);
            String id = prefs.getString("id", ""); if (id.isEmpty()) { id = UUID.randomUUID().toString(); prefs.edit().putString("id", id).apply(); }
            state.put("installationId", id); state.put("deviceName", android.os.Build.MODEL); call.resolve(state);
        });
    }
    @PluginMethod public void settings(PluginCall call) { getActivity().runOnUiThread(() -> { getActivity().startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); call.resolve(); }); }
    @PluginMethod public void apps(PluginCall call) { JSObject result = new JSObject(); result.put("apps", PhoneIntents.apps(getContext())); call.resolve(result); }
    @PluginMethod public void enable(PluginCall call) { getActivity().runOnUiThread(() -> { PhoneAccessibilityService s = PhoneAccessibilityService.instance; if (s == null) { call.reject("请先在系统无障碍设置中开启未央手机操控", "PHONE_ACCESSIBILITY"); return; } try { s.begin(call.getData()); call.resolve(s.state()); } catch (Exception e) { String code = e.getMessage(); call.reject(PhoneAccessibilityService.errorText(code == null ? "PHONE_FAILED" : code), code); } }); }
    @PluginMethod public void stop(PluginCall call) { getActivity().runOnUiThread(() -> { PhoneAccessibilityService s = PhoneAccessibilityService.instance; if (s != null) s.stop(); call.resolve(); }); }
    @PluginMethod public void pause(PluginCall call) { getActivity().runOnUiThread(() -> { PhoneAccessibilityService s = PhoneAccessibilityService.instance; if (s != null) s.pause(call.getBoolean("paused", true)); call.resolve(); }); }
    @PluginMethod public void cancel(PluginCall call) { getActivity().runOnUiThread(() -> { PhoneAccessibilityService s = PhoneAccessibilityService.instance; if (s != null) s.cancel(call.getString("id", "")); call.resolve(); }); }
    @PluginMethod public void execute(PluginCall call) { getActivity().runOnUiThread(() -> { PhoneAccessibilityService s = PhoneAccessibilityService.instance; if (s == null) { call.reject("手机操控未开启", "PHONE_ACCESSIBILITY"); return; } s.execute(call.getData(), call::resolve, null); }); }
    @Override protected void handleOnDestroy() { PhoneAccessibilityService s = PhoneAccessibilityService.instance; if (s != null) s.main.post(s::stop); super.handleOnDestroy(); }
}
